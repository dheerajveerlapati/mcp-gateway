"""WooCommerce MCP server.

Exposes the store's products and orders as MCP tools over Streamable HTTP.
It is internal-only: no Ingress points at it, a NetworkPolicy only lets the
gateway in, and every request must carry the gateway's bearer token.
"""

import hmac
import logging
import os
from typing import Literal

import uvicorn
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp_types import ToolAnnotations
from starlette.requests import Request
from starlette.responses import JSONResponse

from app.woo_client import WooClient, WooError

# httpx logs every URL at INFO, which would put the API key id in the logs.
logging.getLogger("httpx").setLevel(logging.WARNING)

store = WooClient(
    base_url=os.environ["WOO_URL"],  # internal address, e.g. http://store-wordpress.store
    consumer_key=os.environ["WOO_CONSUMER_KEY"],
    consumer_secret=os.environ["WOO_CONSUMER_SECRET"],
)
mcp = MCPServer("woocommerce", instructions="Tools for the WooCommerce store: products and orders.")

READ_ONLY = ToolAnnotations(read_only_hint=True)
OrderStatus = Literal["pending", "processing", "on-hold", "completed", "cancelled", "refunded", "failed"]


# ---------- Products ----------

# List tools return {"count": n, "<items>": [...]} rather than a bare list:
# an empty list would reach the model as an empty answer, and models then
# retry because they cannot tell "nothing found" from "something broke".

@mcp.tool(annotations=READ_ONLY)
async def list_products(search: str | None = None, page: int = 1, per_page: int = 20) -> dict:
    """List products in the store, newest first. Optionally filter by a search term."""
    products = await call_store(store.get("/products", {
        "search": search, "page": page, "per_page": limit(per_page), "orderby": "date", "order": "desc",
    }))
    return {"count": len(products), "products": [product_summary(p) for p in products]}


@mcp.tool()
async def create_product(name: str, price: float, description: str = "", image_url: str | None = None) -> dict:
    """Create a published product. Price is in the store currency. It appears on the storefront at once."""
    body = {"name": name, "regular_price": f"{price:.2f}", "description": description, "status": "publish"}
    if image_url:
        body["images"] = [{"src": image_url}]
    return product_summary(await call_store(store.post("/products", body)))


# ---------- Orders ----------

@mcp.tool(annotations=READ_ONLY)
async def list_orders(
    date_from: str | None = None,
    date_to: str | None = None,
    status: OrderStatus | None = None,
    page: int = 1,
    per_page: int = 20,
) -> dict:
    """List orders, newest first.

    date_from / date_to are days in YYYY-MM-DD format (store time zone), both inclusive.
    For "today's orders" pass today's date as both date_from and date_to.
    """
    orders = await call_store(store.get("/orders", {
        "after": f"{date_from}T00:00:00" if date_from else None,
        "before": f"{date_to}T23:59:59" if date_to else None,
        "status": status,
        "page": page,
        "per_page": limit(per_page),
    }))
    return {"count": len(orders), "orders": [order_summary(o) for o in orders]}


@mcp.tool(annotations=READ_ONLY)
async def get_order(order_id: int) -> dict:
    """Get one order with its items, customer and totals."""
    return order_summary(await call_store(store.get(f"/orders/{order_id}")))


@mcp.tool()
async def update_order_status(order_id: int, status: OrderStatus) -> dict:
    """Change the status of an order, e.g. to 'completed' once it has shipped."""
    return order_summary(await call_store(store.put(f"/orders/{order_id}", {"status": status})))


@mcp.tool(annotations=READ_ONLY)
async def ping() -> str:
    """Check that the WooCommerce MCP server is up."""
    return "pong from woocommerce"


# ---------- Helpers ----------

async def call_store(request):
    """Run a store request and turn store failures into errors the model can read."""
    try:
        return await request
    except WooError as error:
        raise ToolError(str(error)) from error


def limit(per_page: int) -> int:
    # Keep answers small: the model does not need 500 orders at once.
    return max(1, min(per_page, 50))


def product_summary(p: dict) -> dict:
    return {
        "id": p["id"],
        "name": p["name"],
        "price": p["price"],
        "status": p["status"],
        "stock_status": p["stock_status"],
        "url": p["permalink"],
    }


def order_summary(o: dict) -> dict:
    billing = o.get("billing", {})
    return {
        "id": o["id"],
        "status": o["status"],
        "created": o["date_created"],
        "total": o["total"],
        "currency": o["currency"],
        "payment_method": o["payment_method_title"],
        "customer": f'{billing.get("first_name", "")} {billing.get("last_name", "")}'.strip(),
        "email": billing.get("email", ""),
        "items": [{"name": i["name"], "quantity": i["quantity"], "total": i["total"]} for i in o["line_items"]],
    }


# ---------- HTTP app ----------

@mcp.custom_route("/healthz", methods=["GET"])
async def healthz(request: Request) -> JSONResponse:
    # Liveness/readiness: the process is up. Deliberately not tied to the store,
    # so a store outage shows up as clear tool errors instead of a dead server.
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
    # Stateless + JSON responses: every request stands alone, so any replica
    # can answer it and no session state has to be shared.
    app = mcp.streamable_http_app(stateless_http=True, json_response=True, host="0.0.0.0")
    uvicorn.run(RequireBearerToken(app, os.environ["MCP_TOKEN"]), host="0.0.0.0", port=8000)


if __name__ == "__main__":
    main()
