"""Who is calling? FastAPI dependencies used by the routes.

The dashboard identifies people with a login cookie. MCP clients identify
themselves with an API key (see `check_api_key`, used by /mcp).
"""

from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import UTC, datetime

from fastapi import Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import ApiKey, Session, User
from app.security import SESSION_AUDIENCE, hash_token, read_token

SESSION_COOKIE = "mgw_session"


async def get_db() -> AsyncIterator[AsyncSession]:
    async with Session() as db:
        yield db


async def current_user(request: Request, db: AsyncSession = Depends(get_db)) -> User:
    token = request.cookies.get(SESSION_COOKIE)
    user_id = read_token(token, SESSION_AUDIENCE) if token else None
    user = await db.get(User, user_id) if user_id else None
    # We load the user on every request, so a deleted user or a role change
    # takes effect immediately, not when the cookie expires.
    if user is None or user.password_hash is None:
        raise HTTPException(401, "Please log in.")
    return user


async def admin_user(user: User = Depends(current_user)) -> User:
    if user.role != "admin":
        raise HTTPException(403, "Only admins can do this.")
    return user


@dataclass
class KeyCheck:
    user: User | None  # known even for a revoked key, so the refusal can be audited
    refusal: str | None  # why the key was refused; None means accepted


async def check_api_key(db: AsyncSession, raw_key: str) -> KeyCheck:
    """Look up an API key and decide whether it may be used."""
    key = await db.scalar(select(ApiKey).where(ApiKey.key_hash == hash_token(raw_key)))
    if key is None:
        return KeyCheck(user=None, refusal="Unknown API key.")
    user = await db.get(User, key.user_id)
    if key.revoked_at is not None:
        return KeyCheck(user=user, refusal="This API key has been revoked.")
    key.last_used_at = datetime.now(UTC)
    await db.commit()
    return KeyCheck(user=user, refusal=None)
