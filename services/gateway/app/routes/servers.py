"""Upstream MCP servers: everyone can see them, only admins can change them.

Credentials are write-only: the API accepts them, encrypts them, and from
then on only ever answers "has_credential: true".
"""

import re
from datetime import datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import AfterValidator, BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import admin_user, current_user, get_db
from app.db import Server
from app.security import encrypt
from app.upstreams import upstreams

router = APIRouter(prefix="/api/servers", tags=["servers"])

# Lowercase words joined by single underscores, e.g. "woo", "shop_utils".
# "__" is reserved: it separates server and tool in "woo__list_orders".
SERVER_NAME = re.compile(r"^[a-z][a-z0-9]*(_[a-z0-9]+)*$")
AuthType = Literal["none", "bearer", "header"]


def check_url(url: str) -> str:
    if not url.startswith(("http://", "https://")):
        raise ValueError("URL must start with http:// or https://")
    return url


ServerUrl = Annotated[str, Field(max_length=500), AfterValidator(check_url)]


class ToolOut(BaseModel):
    name: str
    description: str | None


class ServerOut(BaseModel):
    id: int
    name: str
    url: str
    auth_type: str
    auth_header: str | None
    has_credential: bool
    enabled: bool
    status: str  # "connected", "unreachable", "disabled" or "unknown"
    error: str | None
    checked_at: datetime | None
    tools: list[ToolOut]
    skipped_tools: list[str]


class CreateServer(BaseModel):
    name: str = Field(max_length=20)
    url: ServerUrl
    auth_type: AuthType = "none"
    auth_header: str | None = Field(default=None, max_length=100)
    credential: str | None = None
    enabled: bool = True

    @field_validator("name")
    @classmethod
    def valid_name(cls, name: str) -> str:
        if not SERVER_NAME.match(name):
            raise ValueError("Use lowercase letters, digits and single underscores, e.g. shop_utils")
        return name


class UpdateServer(BaseModel):
    # Every field is optional: only what is sent changes.
    url: ServerUrl | None = None
    auth_type: AuthType | None = None
    auth_header: str | None = Field(default=None, max_length=100)
    enabled: bool | None = None
    credential: str | None = None  # a new secret; leave out to keep the current one


def to_out(server: Server) -> ServerOut:
    state = upstreams.state(server.id)
    return ServerOut(
        id=server.id, name=server.name, url=server.url, auth_type=server.auth_type,
        auth_header=server.auth_header, has_credential=server.credential_encrypted is not None,
        enabled=server.enabled, status=state.status, error=state.error, checked_at=state.checked_at,
        tools=[ToolOut(name=t.name, description=t.description) for t in state.tools],
        skipped_tools=state.skipped_tools,
    )


def check_auth_fields(server: Server) -> None:
    if server.auth_type == "header" and not server.auth_header:
        raise HTTPException(422, "Header authentication needs a header name, e.g. X-API-Key.")
    if server.auth_type != "none" and not server.credential_encrypted:
        raise HTTPException(422, "This authentication type needs a credential.")


@router.get("", dependencies=[Depends(current_user)])
async def list_servers(db: AsyncSession = Depends(get_db)) -> list[ServerOut]:
    servers = await db.scalars(select(Server).order_by(Server.id))
    return [to_out(s) for s in servers]


@router.post("", status_code=201, dependencies=[Depends(admin_user)])
async def add_server(body: CreateServer, db: AsyncSession = Depends(get_db)) -> ServerOut:
    if await db.scalar(select(Server).where(Server.name == body.name)):
        raise HTTPException(409, f"A server named '{body.name}' already exists.")
    server = Server(name=body.name, url=body.url, auth_type=body.auth_type, auth_header=body.auth_header,
                    enabled=body.enabled, credential_encrypted=encrypt(body.credential) if body.credential else None)
    check_auth_fields(server)
    db.add(server)
    await db.commit()
    await upstreams.refresh(server)  # show its status and tools right away
    return to_out(server)


@router.patch("/{server_id}", dependencies=[Depends(admin_user)])
async def edit_server(server_id: int, body: UpdateServer, db: AsyncSession = Depends(get_db)) -> ServerOut:
    server = await get_server_or_404(db, server_id)
    changes = body.model_dump(exclude_unset=True)
    for field in ("url", "auth_type", "auth_header", "enabled"):
        if changes.get(field) is not None:
            setattr(server, field, changes[field])
    if changes.get("credential"):
        server.credential_encrypted = encrypt(changes["credential"])
    if server.auth_type == "none":
        server.credential_encrypted = None
        server.auth_header = None
    check_auth_fields(server)
    await db.commit()
    await upstreams.refresh(server)
    return to_out(server)


@router.delete("/{server_id}", status_code=204, dependencies=[Depends(admin_user)])
async def remove_server(server_id: int, db: AsyncSession = Depends(get_db)) -> None:
    server = await get_server_or_404(db, server_id)
    await db.delete(server)
    await db.commit()
    upstreams.states.pop(server_id, None)


async def get_server_or_404(db: AsyncSession, server_id: int) -> Server:
    server = await db.get(Server, server_id)
    if server is None:
        raise HTTPException(404, "Server not found.")
    return server
