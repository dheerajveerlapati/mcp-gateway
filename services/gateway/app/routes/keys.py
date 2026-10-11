"""API keys for MCP clients.

Everyone can create, list and revoke their own keys. Admins can also do it
for other people ("issue or revoke their API keys"). A new key is shown
exactly once; the database only keeps its SHA-256 hash.
"""

from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import current_user, get_db
from app.db import ApiKey, User
from app.security import hash_token, new_api_key

router = APIRouter(prefix="/api/keys", tags=["keys"])


class KeyOut(BaseModel):
    id: int
    user_id: int
    name: str
    prefix: str
    created_at: datetime
    last_used_at: datetime | None
    revoked_at: datetime | None


class CreateKeyRequest(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    user_id: int | None = None  # admins only: issue a key for someone else


class NewKeyOut(BaseModel):
    key: KeyOut
    secret: str  # the full key, shown once


def to_out(key: ApiKey) -> KeyOut:
    return KeyOut(id=key.id, user_id=key.user_id, name=key.name, prefix=key.prefix,
                  created_at=key.created_at, last_used_at=key.last_used_at, revoked_at=key.revoked_at)


def target_user_id(user: User, requested: int | None) -> int:
    """Members always act on their own keys; admins may name another user."""
    if requested is None or requested == user.id:
        return user.id
    if user.role != "admin":
        raise HTTPException(403, "You can only manage your own keys.")
    return requested


@router.get("")
async def list_keys(user_id: int | None = None, user: User = Depends(current_user),
                    db: AsyncSession = Depends(get_db)) -> list[KeyOut]:
    owner = target_user_id(user, user_id)
    keys = await db.scalars(select(ApiKey).where(ApiKey.user_id == owner).order_by(ApiKey.created_at.desc()))
    return [to_out(k) for k in keys]


@router.post("", status_code=201)
async def create_key(body: CreateKeyRequest, user: User = Depends(current_user),
                     db: AsyncSession = Depends(get_db)) -> NewKeyOut:
    owner = target_user_id(user, body.user_id)
    owner_user = await db.get(User, owner)
    if owner_user is None:
        raise HTTPException(404, "User not found.")
    if owner_user.password_hash is None:
        raise HTTPException(409, "This person has not accepted their invite yet.")

    secret = new_api_key()
    key = ApiKey(user_id=owner, name=body.name, prefix=secret[:12], key_hash=hash_token(secret))
    db.add(key)
    await db.commit()
    await db.refresh(key)
    return NewKeyOut(key=to_out(key), secret=secret)


@router.post("/{key_id}/revoke")
async def revoke_key(key_id: int, user: User = Depends(current_user),
                     db: AsyncSession = Depends(get_db)) -> KeyOut:
    key = await db.get(ApiKey, key_id)
    if key is None:
        raise HTTPException(404, "Key not found.")
    target_user_id(user, key.user_id)  # members may only revoke their own
    if key.revoked_at is None:
        key.revoked_at = datetime.now(UTC)
        await db.commit()
    return to_out(key)
