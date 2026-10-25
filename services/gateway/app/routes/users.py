"""Team management (admins only): invite people, change roles, remove people,
and limit people to some servers.

Server access is a hierarchy (see app/permissions.py): the owner has every
server; an admin can only give the servers they have, and can only manage
someone whose servers they also have. The owner cannot be limited, demoted
or removed.

Invites work by link: the admin gets a one-time URL to send to the person
(we do not send email). The link is valid for 7 days.
"""

from datetime import UTC, datetime, timedelta
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import admin_user, get_db
from app.config import settings
from app.db import Server, User, UserServerAccess
from app.permissions import allowed_server_ids, covers, is_owner
from app.security import hash_token, new_invite_token

router = APIRouter(prefix="/api/users", tags=["users"], dependencies=[Depends(admin_user)])

INVITE_LIFETIME = timedelta(days=7)
Role = Literal["admin", "member"]


class UserOut(BaseModel):
    id: int
    email: str
    name: str
    role: str
    status: str  # "active" or "invited"
    created_at: datetime
    all_servers: bool
    server_ids: list[int]  # the servers they may use when all_servers is False
    owner: bool  # the first admin: always every server


class InviteRequest(BaseModel):
    email: EmailStr
    name: str = Field(min_length=1, max_length=100)
    role: Role = "member"


class InviteOut(BaseModel):
    user: UserOut
    invite_url: str  # shown once to the admin


class RoleUpdate(BaseModel):
    role: Role


class ServerAccessUpdate(BaseModel):
    all_servers: bool
    server_ids: list[int] = []


def to_out(user: User, server_ids: list[int] | None = None) -> UserOut:
    status = "active" if user.password_hash else "invited"
    return UserOut(id=user.id, email=user.email, name=user.name, role=user.role, status=status,
                   created_at=user.created_at, all_servers=user.all_servers, server_ids=server_ids or [],
                   owner=is_owner(user))


@router.get("")
async def list_users(db: AsyncSession = Depends(get_db)) -> list[UserOut]:
    users = await db.scalars(select(User).order_by(User.created_at))
    access: dict[int, list[int]] = {}
    for row in await db.scalars(select(UserServerAccess)):
        access.setdefault(row.user_id, []).append(row.server_id)
    return [to_out(u, access.get(u.id)) for u in users]


@router.post("", status_code=201)
async def invite_user(body: InviteRequest, admin: User = Depends(admin_user),
                      db: AsyncSession = Depends(get_db)) -> InviteOut:
    email = body.email.lower()
    if await db.scalar(select(User).where(User.email == email)):
        raise HTTPException(409, "Someone with this email is already on the team.")
    token = new_invite_token()
    user = User(email=email, name=body.name, role=body.role, invite_token_hash=hash_token(token),
                invite_expires_at=datetime.now(UTC) + INVITE_LIFETIME)
    # Someone invited by a limited admin starts with that admin's servers, not more.
    inviter_allowed = await allowed_server_ids(admin)
    inviter_servers = sorted(inviter_allowed or [])
    user.all_servers = inviter_allowed is None
    db.add(user)
    await db.flush()
    db.add_all(UserServerAccess(user_id=user.id, server_id=i) for i in inviter_servers)
    await db.commit()
    await db.refresh(user)
    return InviteOut(user=to_out(user, inviter_servers), invite_url=f"{settings.public_url}/invite/{token}")


@router.patch("/{user_id}")
async def change_role(user_id: int, body: RoleUpdate, admin: User = Depends(admin_user),
                      db: AsyncSession = Depends(get_db)) -> UserOut:
    user = await get_manageable_user(db, user_id, admin)
    if is_owner(user) and body.role != "admin":
        raise HTTPException(409, "The owner is always an admin.")
    if user.role == "admin" and body.role != "admin":
        await ensure_another_admin(db)
    user.role = body.role
    await db.commit()
    return to_out(user, await server_ids_of(db, user.id))


@router.put("/{user_id}/servers")
async def set_server_access(user_id: int, body: ServerAccessUpdate, admin: User = Depends(admin_user),
                            db: AsyncSession = Depends(get_db)) -> UserOut:
    """Give a user every server, or only the listed ones. Takes effect on their next request."""
    user = await get_manageable_user(db, user_id, admin)
    if is_owner(user):
        raise HTTPException(409, "The owner always has every server.")
    if user.id == admin.id:
        raise HTTPException(409, "You cannot change your own server access. Ask another admin.")
    server_ids = sorted(set(body.server_ids)) if not body.all_servers else []
    granted = None if body.all_servers else set(server_ids)
    if not covers(await allowed_server_ids(admin), granted):
        raise HTTPException(403, "You can only give servers you have access to yourself.")
    known = set(await db.scalars(select(Server.id).where(Server.id.in_(server_ids))))
    if unknown := set(server_ids) - known:
        raise HTTPException(422, f"Unknown server ids: {sorted(unknown)}")
    user.all_servers = body.all_servers
    await db.execute(delete(UserServerAccess).where(UserServerAccess.user_id == user.id))
    db.add_all(UserServerAccess(user_id=user.id, server_id=i) for i in server_ids)
    await db.commit()
    return to_out(user, server_ids)


@router.delete("/{user_id}", status_code=204)
async def remove_user(user_id: int, admin: User = Depends(admin_user), db: AsyncSession = Depends(get_db)) -> None:
    user = await get_manageable_user(db, user_id, admin)
    if is_owner(user):
        raise HTTPException(409, "The owner cannot be removed.")
    if user.role == "admin":
        await ensure_another_admin(db)
    await db.delete(user)  # their API keys are deleted with them (ON DELETE CASCADE)
    await db.commit()


async def get_manageable_user(db: AsyncSession, user_id: int, admin: User) -> User:
    """A user the admin may manage: someone whose servers the admin also has."""
    user = await get_user_or_404(db, user_id)
    if user.id != admin.id and not covers(await allowed_server_ids(admin), await allowed_server_ids(user)):
        raise HTTPException(403, "This person has servers you do not have. Ask an admin who has them.")
    return user


async def server_ids_of(db: AsyncSession, user_id: int) -> list[int]:
    return list(await db.scalars(select(UserServerAccess.server_id).where(UserServerAccess.user_id == user_id)))


async def get_user_or_404(db: AsyncSession, user_id: int) -> User:
    user = await db.get(User, user_id)
    if user is None:
        raise HTTPException(404, "User not found.")
    return user


async def ensure_another_admin(db: AsyncSession) -> None:
    """Never leave the team without an admin."""
    admins = await db.scalar(select(func.count()).select_from(User).where(User.role == "admin"))
    if admins <= 1:
        raise HTTPException(409, "The team needs at least one admin.")
