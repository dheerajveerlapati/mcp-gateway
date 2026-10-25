"""The gateway's own MCP endpoint: /mcp.

Here the gateway is an MCP *server*. To clients it looks like one server
whose tools are the tools of every enabled upstream, renamed
"<server>__<tool>" (e.g. "woo__list_orders"). Calling a tool strips the
prefix and forwards the call to that server.

Every request goes through three steps:
1. `McpEndpoint` checks who is calling (API key, or the chat agent's
   short-lived token) before any MCP code runs. Refusals are audited.
2. `list_tools` / `call_tool` answer the MCP request for that caller.
3. Every tool call is written to the audit log, whatever the outcome.
"""

import json
import logging
import time
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qs

from mcp.server import Server
from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
from mcp_types import CallToolRequestParams, CallToolResult, ListToolsResult, TextContent, Tool
from sqlalchemy import func, select
from starlette.responses import JSONResponse

from app.auth import check_api_key
from app.config import settings
from app.metrics import TOOL_CALL_SECONDS, TOOL_CALLS
from app.db import AuditLog, Server as ServerRow, Session, User
from app.permissions import access_for, load_overrides, may_use
from app.security import API_KEY_PREFIX, CHAT_AUDIENCE, read_token
from app.tool_search import CALL_TOOL, META_TOOLS, SEARCH_TOOL, search
from app.upstreams import SEPARATOR, UpstreamCallError, upstreams

log = logging.getLogger("gateway.mcp")


@dataclass
class Caller:
    user: User
    source: str  # "api_key" (an MCP client) or "chat" (the dashboard chat agent)
    search_mode: bool = False  # connected to /mcp?tools=search (see tool_search.py)


# The authenticated caller of the request being handled. Set by McpEndpoint,
# read by the handlers below (each request runs in its own context).
current_caller: ContextVar[Caller] = ContextVar("current_caller")


# ---------- MCP handlers ----------

async def list_tools(ctx, params) -> ListToolsResult:
    caller = current_caller.get()
    if caller.search_mode:
        return ListToolsResult(tools=META_TOOLS)
    return ListToolsResult(tools=await visible_tools(caller))


async def visible_tools(caller: Caller) -> list[Tool]:
    """Tools of every enabled, reachable server that this caller may use, prefixed."""
    overrides = await load_overrides()
    tools = []
    for server in await enabled_servers():
        state = await current_state(server)
        if state.status != "connected":
            continue  # a dead server simply contributes no tools
        for tool in state.tools:
            if not may_use(caller.user.role, access_for(server.id, tool.name, tool, overrides)):
                continue  # hidden: this role may not use it
            tools.append(tool.model_copy(update={
                "name": f"{server.name}{SEPARATOR}{tool.name}",
                # Tell the model (and the person reading) where the tool comes from.
                "description": f"[{server.name}] {tool.description or ''}".strip(),
            }))
    return tools


async def call_tool(ctx, params: CallToolRequestParams) -> CallToolResult:
    caller = current_caller.get()
    arguments = params.arguments or {}

    # The two search-mode tools (available in both modes once known).
    if params.name == SEARCH_TOOL:
        found = search(await visible_tools(caller), str(arguments.get("query", "")), int(arguments.get("limit", 8)))
        return CallToolResult(content=[TextContent(type="text", text=found)])
    if params.name == CALL_TOOL:
        return await route_call(caller, str(arguments.get("name", "")), arguments.get("arguments") or {})

    return await route_call(caller, params.name, arguments)


async def route_call(caller: Caller, name: str, arguments: dict) -> CallToolResult:
    """Route "<server>__<tool>" to the right upstream and audit the call."""
    started = time.monotonic()
    server_name, separator, tool_name = name.partition(SEPARATOR)

    server = await find_server(server_name) if separator else None
    if server is None:
        result, outcome = error_result(f"Unknown tool '{name}'."), "error"
    elif not server.enabled:
        result, outcome = error_result(f"Server '{server_name}' is disabled by an admin."), "denied"
    elif not await caller_may_use(caller, server, tool_name):
        result = error_result(f"Your role ({caller.user.role}) may not use {name}. Ask an admin.")
        outcome = "denied"
    elif await over_rate_limit(caller.user):
        result = error_result(f"Rate limit: at most {settings.rate_limit_per_minute} tool calls per minute. "
                              "Try again in a moment.")
        outcome = "denied"
    else:
        try:
            result = await upstreams.call_tool(server, tool_name, arguments)
            outcome = "error" if result.is_error else "ok"
        except UpstreamCallError as error:
            result = error_result(str(error))
            outcome = "timeout" if error.timed_out else "error"

    seconds = time.monotonic() - started
    TOOL_CALLS.labels(server_name or "-", outcome).inc()
    TOOL_CALL_SECONDS.labels(server_name or "-").observe(seconds)
    await write_audit(
        caller.user, caller.source, server_name or "-", tool_name or name,
        duration_ms=int(seconds * 1000), outcome=outcome,
        error=result.content[0].text if outcome != "ok" and result.content else None,
    )
    return result


mcp_server = Server(
    "mcp-gateway",
    instructions="One endpoint for all of the team's MCP servers. Tool names are <server>__<tool>.",
    on_list_tools=list_tools,
    on_call_tool=call_tool,
)

# Stateless + JSON responses: every request stands alone, so any gateway
# replica can answer any request and nothing has to be shared between them.
session_manager = StreamableHTTPSessionManager(app=mcp_server, stateless=True, json_response=True)


# ---------- Authentication in front of the MCP endpoint ----------

class McpEndpoint:
    """ASGI app for /mcp: authenticate the caller, then hand over to MCP."""

    async def __call__(self, scope, receive, send):
        caller, refusal, refused_user = await identify(bearer_token(scope))

        if caller is None:
            if refused_user:  # e.g. a revoked key: we know whose it was, so audit it
                await audit_refusal(refused_user, refusal, receive)
            response = JSONResponse({"error": refusal}, status_code=401,
                                    headers={"WWW-Authenticate": 'Bearer realm="mcp-gateway"'})
            await response(scope, receive, send)
            return

        caller.search_mode = "search" in parse_qs(scope.get("query_string", b"").decode()).get("tools", [])
        current_caller.set(caller)
        await session_manager.handle_request(scope, receive, send)


def bearer_token(scope) -> str | None:
    header = dict(scope["headers"]).get(b"authorization", b"").decode()
    scheme, _, token = header.partition(" ")
    return token.strip() if scheme.lower() == "bearer" and token.strip() else None


async def identify(token: str | None) -> tuple[Caller | None, str, User | None]:
    """Return (caller, "", None) if accepted, else (None, reason, user-if-known)."""
    if token is None:
        return None, "Missing API key. Send it as: Authorization: Bearer <key>", None

    if token.startswith(API_KEY_PREFIX):
        async with Session() as db:
            check = await check_api_key(db, token)
        if check.refusal:
            return None, check.refusal, check.user
        return Caller(check.user, "api_key"), "", None

    # Otherwise it can only be the chat agent's short-lived token.
    user_id = read_token(token, CHAT_AUDIENCE)
    async with Session() as db:
        user = await db.get(User, user_id) if user_id else None
    if user is None:
        return None, "Invalid or expired token.", None
    return Caller(user, "chat"), "", None


async def audit_refusal(user: User, reason: str, receive) -> None:
    """Record a refused request from a known user, e.g. someone using a revoked key."""
    # Read the request to see what they tried to do (we are refusing it anyway).
    body = b""
    while True:
        message = await receive()
        body += message.get("body", b"")
        if not message.get("more_body"):
            break
    try:
        request = json.loads(body)
        params = request.get("params") or {}
        attempted = params.get("name") or request.get("method", "-")
    except (ValueError, AttributeError):
        attempted = "-"
    server_name, separator, tool_name = attempted.partition(SEPARATOR)
    await write_audit(user, "api_key", server_name if separator else "-", tool_name or attempted,
                      duration_ms=0, outcome="denied", error=reason)


# ---------- Helpers ----------

async def over_rate_limit(user: User) -> bool:
    """Count this user's tool calls in the last minute, from the audit log.

    The count lives in Postgres, so the limit holds across all gateway
    replicas (an in-memory counter would allow N x the limit with N replicas).
    """
    since = datetime.now(UTC) - timedelta(minutes=1)
    async with Session() as db:
        recent = await db.scalar(
            select(func.count()).select_from(AuditLog)
            .where(AuditLog.user_id == user.id, AuditLog.created_at > since)
        )
    return recent >= settings.rate_limit_per_minute


async def caller_may_use(caller: Caller, server: ServerRow, tool_name: str) -> bool:
    """The same rule as the tool list, checked again because a client can call
    a tool by name without ever having been shown it."""
    state = await current_state(server)
    tool = next((t for t in state.tools if t.name == tool_name), None)
    return may_use(caller.user.role, access_for(server.id, tool_name, tool, await load_overrides()))


async def current_state(server: ServerRow):
    """This replica's view of an enabled server, re-checked if it is stale.

    Each replica remembers upstream status in memory. If an admin just enabled
    a server through another replica, this one may still remember it as
    disabled (or, if it just started, not know it yet); check it now rather
    than wait for the next health-check round.
    """
    state = upstreams.state(server.id)
    if state.status in ("disabled", "unknown"):
        await upstreams.refresh(server)
        state = upstreams.state(server.id)
    return state


async def enabled_servers() -> list[ServerRow]:
    # Read from the database on every request, so disabling or removing a
    # server takes effect at once on every gateway replica.
    async with Session() as db:
        return list(await db.scalars(select(ServerRow).where(ServerRow.enabled).order_by(ServerRow.id)))


async def find_server(name: str) -> ServerRow | None:
    async with Session() as db:
        return await db.scalar(select(ServerRow).where(ServerRow.name == name))


def error_result(message: str) -> CallToolResult:
    return CallToolResult(content=[TextContent(type="text", text=message)], is_error=True)


async def write_audit(user: User, source: str, server_name: str, tool_name: str,
                      duration_ms: int, outcome: str, error: str | None) -> None:
    # An audit failure is logged but never breaks the tool call itself.
    try:
        async with Session() as db:
            db.add(AuditLog(user_id=user.id, user_email=user.email, source=source,
                            server_name=server_name[:40], tool_name=tool_name[:100],
                            duration_ms=duration_ms, outcome=outcome, error=error))
            await db.commit()
    except Exception:
        log.exception("Could not write the audit log")
