"""Connections to the upstream MCP servers.

The gateway is an MCP *client* of every registered server. This module:

1. Checks every enabled server in the background (every few seconds):
   connect, list its tools, remember the result and the status
   (connected / unreachable / disabled) plus the reason when it fails.
2. Calls a tool on one server, with a timeout.

Each check and each call opens a fresh connection. That costs one extra
round trip, but a dead or restarted server can never leave a broken
connection behind, and one server can never block another.

The remembered state lives in this process's memory. The database stays the
source of truth for *which* servers exist and are enabled, so with several
gateway replicas each one keeps its own copy of the status.
"""

import asyncio
import logging
import re
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime

import httpx2
from mcp import Client
from mcp.client.streamable_http import streamable_http_client
from mcp_types import CallToolResult, Tool
from sqlalchemy import select

from app.config import settings
from app.db import Server, Session
from app.security import decrypt

log = logging.getLogger("gateway.upstreams")

HEALTH_CHECK_TIMEOUT = 5.0  # seconds; a check is a connect + tools/list

# Gateway tool names are "<server>__<tool>". Many MCP clients only accept
# names matching this pattern, so tools that would break it are skipped.
VALID_TOOL_NAME = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")
SEPARATOR = "__"


@dataclass
class UpstreamState:
    status: str = "unknown"  # "connected", "unreachable", "disabled" or "unknown" (not checked yet)
    error: str | None = None  # why it is unreachable
    tools: list[Tool] = field(default_factory=list)
    skipped_tools: list[str] = field(default_factory=list)  # names that would be invalid once prefixed
    checked_at: datetime | None = None


class UpstreamHTTPError(Exception):
    """The upstream answered with an HTTP error status."""

    def __init__(self, status: int):
        super().__init__(f"HTTP {status}")
        self.status = status


class UpstreamCallError(Exception):
    """A tool call could not be completed (timeout, connection error...)."""

    def __init__(self, message: str, timed_out: bool = False):
        super().__init__(message)
        self.timed_out = timed_out


class Upstreams:
    def __init__(self):
        self.states: dict[int, UpstreamState] = {}  # by server id

    def state(self, server_id: int) -> UpstreamState:
        return self.states.get(server_id, UpstreamState())

    # ---------- Health checks ----------

    async def run_forever(self) -> None:
        """Background loop started by the app: refresh everything, sleep, repeat."""
        while True:
            try:
                await self.refresh_all()
            except Exception:
                log.exception("Refreshing upstreams failed")
            await asyncio.sleep(settings.health_interval_seconds)

    async def refresh_all(self) -> None:
        async with Session() as db:
            servers = list(await db.scalars(select(Server)))
        # Check all servers at the same time, so a slow one never delays the others.
        await asyncio.gather(*(self.refresh(server) for server in servers))
        # Forget servers that were removed.
        known_ids = {server.id for server in servers}
        for server_id in list(self.states):
            if server_id not in known_ids:
                del self.states[server_id]

    async def refresh(self, server: Server) -> None:
        """Check one server and remember the result."""
        now = datetime.now(UTC)
        if not server.enabled:
            self.states[server.id] = UpstreamState(status="disabled", checked_at=now)
            return
        try:
            async with asyncio.timeout(HEALTH_CHECK_TIMEOUT):
                tools = await self._list_tools(server)
        except Exception as error:
            reason = describe_error(error, HEALTH_CHECK_TIMEOUT)
            if self.state(server.id).status != "unreachable":
                log.warning("Upstream %s is unreachable: %s", server.name, reason)
            self.states[server.id] = UpstreamState(status="unreachable", error=reason, checked_at=now)
            return

        usable = [t for t in tools if VALID_TOOL_NAME.match(f"{server.name}{SEPARATOR}{t.name}")]
        skipped = [t.name for t in tools if t not in usable]
        self.states[server.id] = UpstreamState(status="connected", tools=usable, skipped_tools=skipped,
                                               checked_at=now)

    async def _list_tools(self, server: Server) -> list[Tool]:
        tools: list[Tool] = []
        async with connect(server) as client:
            cursor = None
            while True:  # tool lists can be paginated
                page = await client.list_tools(cursor=cursor)
                tools.extend(page.tools)
                cursor = page.next_cursor
                if not cursor:
                    return tools

    # ---------- Tool calls ----------

    async def call_tool(self, server: Server, tool_name: str, arguments: dict) -> CallToolResult:
        timeout = settings.upstream_timeout_seconds
        try:
            async with asyncio.timeout(timeout):
                async with connect(server) as client:
                    return await client.call_tool(tool_name, arguments)
        except Exception as error:
            raise UpstreamCallError(
                f"Server '{server.name}' failed: {describe_error(error, timeout)}",
                timed_out=isinstance(root_cause(error), TIMEOUT_ERRORS),
            ) from error


@asynccontextmanager
async def connect(server: Server):
    """Open an MCP connection to one server, sending its credential.

    This is the only place an upstream credential is decrypted, and it only
    ever goes to that server - never to the browser or an MCP client.
    """
    headers = {}
    if server.credential_encrypted and server.auth_type == "bearer":
        headers["Authorization"] = f"Bearer {decrypt(server.credential_encrypted)}"
    elif server.credential_encrypted and server.auth_type == "header":
        headers[server.auth_header] = decrypt(server.credential_encrypted)

    # The MCP client reports HTTP failures only as a generic error, so we note
    # the status codes ourselves to explain e.g. a rejected credential.
    error_statuses: list[int] = []

    async def remember_errors(response: httpx2.Response) -> None:
        if response.status_code >= 400:
            error_statuses.append(response.status_code)

    try:
        # timeout=None: the caller's asyncio.timeout is the single time limit,
        # so there is no hidden second timer with a different value.
        async with httpx2.AsyncClient(headers=headers, follow_redirects=False, timeout=None,
                                      event_hooks={"response": [remember_errors]}) as http:
            async with Client(streamable_http_client(server.url, http_client=http)) as client:
                yield client
    except Exception as error:
        if error_statuses:
            raise UpstreamHTTPError(error_statuses[-1]) from error
        raise


TIMEOUT_ERRORS = (TimeoutError, httpx2.TimeoutException)


def root_cause(error: BaseException) -> BaseException:
    """The MCP client wraps failures in exception groups; find the real one."""
    while isinstance(error, BaseExceptionGroup) and error.exceptions:
        error = error.exceptions[0]
    return error


def describe_error(error: BaseException, timeout: float) -> str:
    """Turn a connection failure into one short, readable reason."""
    error = root_cause(error)
    if isinstance(error, TIMEOUT_ERRORS):
        return f"no answer within {timeout:g} seconds"
    if isinstance(error, httpx2.ConnectError):
        return "cannot connect (server down, wrong address, or blocked by network policy)"
    if isinstance(error, UpstreamHTTPError):
        if error.status in (401, 403):
            return f"server rejected the credential (HTTP {error.status})"
        return f"server answered HTTP {error.status}"
    message = str(error) or error.__class__.__name__
    return message[:200]


upstreams = Upstreams()
