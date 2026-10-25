"""The gateway application: the dashboard API and the /mcp endpoint."""

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest
from sqlalchemy import func, select, text
from starlette.routing import Route

from app.config import settings
from app.db import Server, Session, User
from app.mcp_gateway import McpEndpoint, session_manager
from app.routes import audit, auth, chat, keys, oauth, servers, users
from app.security import encrypt, hash_password
from app.upstreams import upstreams

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
for noisy in ("httpx", "httpx2"):  # they log every upstream request URL
    logging.getLogger(noisy).setLevel(logging.WARNING)
log = logging.getLogger("gateway")


async def first_start_setup() -> None:
    """Create the first admin and register our in-cluster MCP servers, once.

    Both only happen on an empty database, so an admin who later removes a
    server or changes the admin password is never overruled. The WooCommerce
    server is registered first, as the assignment asks.
    """
    async with Session() as db:
        if await db.scalar(select(func.count()).select_from(User)) == 0:
            db.add(User(email=settings.bootstrap_admin_email.lower(), name="Admin", role="admin",
                        password_hash=hash_password(settings.bootstrap_admin_password)))
            log.info("Created the first admin: %s", settings.bootstrap_admin_email)

        if await db.scalar(select(func.count()).select_from(Server)) == 0:
            for name, url, token in (("woo", settings.woo_mcp_url, settings.woo_mcp_token),
                                     ("utils", settings.utils_mcp_url, settings.utils_mcp_token)):
                if url:
                    db.add(Server(name=name, url=url, auth_type="bearer", credential_encrypted=encrypt(token)))
                    await db.flush()  # keeps the ids in this order: woo is server #1
                    log.info("Registered MCP server %s: %s", name, url)

        await db.commit()


@asynccontextmanager
async def lifespan(app: FastAPI):
    await first_start_setup()
    health_loop = asyncio.create_task(upstreams.run_forever())
    async with session_manager.run():  # the MCP endpoint's request handling
        yield
    health_loop.cancel()


app = FastAPI(title="MCP Gateway", lifespan=lifespan)
# The MCP endpoint for Claude Code, Cursor, MCP Inspector and the chat agent.
app.router.routes.append(Route("/mcp", McpEndpoint(), methods=["GET", "POST", "DELETE"]))
app.include_router(auth.router)
app.include_router(users.router)
app.include_router(keys.router)
app.include_router(servers.router)
app.include_router(audit.router)
app.include_router(chat.router)
app.include_router(oauth.router)


class PublicEndpointsCors:
    """Browser-based MCP clients (e.g. MCP Inspector) call /mcp and the OAuth
    endpoints from their own origin, so those need CORS headers. Only those:
    the cookie-based /api stays same-origin, and "*" never allows cookies."""

    PATHS = ("/mcp", "/oauth/", "/.well-known/")

    def __init__(self, app):
        self.app = app
        self.cors = CORSMiddleware(app, allow_origins=["*"], allow_methods=["GET", "POST", "DELETE"],
                                   allow_headers=["*"], expose_headers=["WWW-Authenticate", "Mcp-Session-Id"])

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and scope["path"].startswith(self.PATHS):
            await self.cors(scope, receive, send)
        else:
            await self.app(scope, receive, send)


app.add_middleware(PublicEndpointsCors)


@app.get("/metrics", include_in_schema=False)
async def metrics():
    """Prometheus metrics. Only reachable inside the cluster (no Ingress route)."""
    return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)


@app.get("/healthz", include_in_schema=False)
async def healthz():
    """Liveness: the process is up."""
    return {"status": "ok"}


@app.get("/readyz", include_in_schema=False)
async def readyz():
    """Readiness: the database answers and the upstreams have been checked once.

    A new replica that has not finished its first check knows no tools yet; it
    must not receive traffic until it does.
    """
    if not upstreams.first_check_done:
        return JSONResponse({"status": "checking upstreams"}, status_code=503)
    try:
        async with Session() as db:
            await db.execute(text("SELECT 1"))
    except Exception:
        return JSONResponse({"status": "database unavailable"}, status_code=503)
    return {"status": "ok"}
