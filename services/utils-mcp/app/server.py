"""Shop Utils MCP server.

Small helper tools for running a shop: currency conversion, shipping quotes
and the current time. It also has two tools that exist for the demo:
`ping` (same name as the WooCommerce server's tool, to show how the gateway
handles name collisions) and `slow_task` (to show gateway timeouts).

Like the WooCommerce server it is internal-only and requires the gateway's
bearer token.
"""

import asyncio
import hmac
import os
from datetime import datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import uvicorn
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp_types import ToolAnnotations
from starlette.requests import Request
from starlette.responses import JSONResponse

mcp = MCPServer("shop-utils", instructions="Helper tools: currency conversion, shipping quotes, current time.")

READ_ONLY = ToolAnnotations(read_only_hint=True)

# Fixed demo rates: how many INR one unit of each currency is worth.
# A real deployment would fetch these from a rates API.
INR_PER_UNIT = {"INR": 1.0, "USD": 88.0, "EUR": 102.0, "GBP": 118.0, "AED": 24.0}

# Shipping: base fee + per-kg fee, in INR, by zone.
SHIPPING_RATES = {"domestic": (49, 20), "international": (899, 450)}


@mcp.tool(annotations=READ_ONLY)
async def convert_currency(amount: float, from_currency: str, to_currency: str) -> dict:
    """Convert an amount between INR, USD, EUR, GBP and AED (fixed demo rates)."""
    source, target = from_currency.upper(), to_currency.upper()
    for code in (source, target):
        if code not in INR_PER_UNIT:
            raise ToolError(f"Unknown currency {code}. Supported: {', '.join(INR_PER_UNIT)}.")
    converted = amount * INR_PER_UNIT[source] / INR_PER_UNIT[target]
    return {"amount": amount, "from": source, "to": target, "result": round(converted, 2)}


@mcp.tool(annotations=READ_ONLY)
async def shipping_quote(weight_kg: float, country_code: str = "IN") -> dict:
    """Estimate the shipping cost in INR for a parcel. country_code is ISO-2, e.g. IN, US."""
    if weight_kg <= 0:
        raise ToolError("Weight must be more than 0 kg.")
    zone = "domestic" if country_code.upper() == "IN" else "international"
    base, per_kg = SHIPPING_RATES[zone]
    return {"zone": zone, "weight_kg": weight_kg, "cost_inr": round(base + per_kg * weight_kg, 2)}


@mcp.tool(annotations=READ_ONLY)
async def current_time(timezone: str = "Asia/Kolkata") -> dict:
    """Current date and time in a time zone (IANA name, e.g. Asia/Kolkata, UTC)."""
    try:
        now = datetime.now(ZoneInfo(timezone))
    except ZoneInfoNotFoundError:
        raise ToolError(f"Unknown time zone {timezone}.") from None
    return {"timezone": timezone, "date": now.date().isoformat(), "time": now.strftime("%H:%M:%S")}


@mcp.tool(annotations=READ_ONLY)
async def ping() -> str:
    """Check that the Shop Utils server is up."""
    return "pong from shop-utils"


@mcp.tool(annotations=READ_ONLY)
async def slow_task(seconds: int = 30) -> str:
    """Wait the given number of seconds (max 120) before answering. Used to test timeouts."""
    seconds = max(0, min(seconds, 120))
    await asyncio.sleep(seconds)
    return f"finished after {seconds} seconds"


# ---------- HTTP app ----------

@mcp.custom_route("/healthz", methods=["GET"])
async def healthz(request: Request) -> JSONResponse:
    return JSONResponse({"status": "ok"})


class RequireBearerToken:
    """ASGI middleware: only callers with the shared token (the gateway) get in."""

    def __init__(self, app, token: str):
        self.app = app
        self.expected = f"Bearer {token}".encode()

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and scope["path"] != "/healthz":
            sent = dict(scope["headers"]).get(b"authorization", b"")
            if not hmac.compare_digest(sent, self.expected):
                await JSONResponse({"error": "unauthorized"}, status_code=401)(scope, receive, send)
                return
        await self.app(scope, receive, send)


def main():
    app = mcp.streamable_http_app(stateless_http=True, json_response=True, host="0.0.0.0")
    uvicorn.run(RequireBearerToken(app, os.environ["MCP_TOKEN"]), host="0.0.0.0", port=8000)


if __name__ == "__main__":
    main()
