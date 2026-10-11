"""Team management (admins only): invite people, change roles, remove people.

Invites work by link: the admin gets a one-time URL to send to the person
(we do not send email). The link is valid for 7 days.
"""

from datetime import UTC, datetime, timedelta
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import admin_user, get_db
from app.config import settings
from app.db import User
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


class InviteRequest(BaseModel):
    email: EmailStr
    name: str = Field(min_length=1, max_length=100)
    role: Role = "member"


class InviteOut(BaseModel):
    user: UserOut
    invite_url: str  # shown once to the admin


class RoleUpdate(BaseModel):
    role: Role


def to_out(user: User) -> UserOut:
    status = "active" if user.password_hash else "invited"
    return UserOut(id=user.id, email=user.email, name=user.name, role=user.role, status=status,
                   created_at=user.created_at)


@router.get("")
async def list_users(db: AsyncSession = Depends(get_db)) -> list[UserOut]:
    users = await db.scalars(select(User).order_by(User.created_at))
    return [to_out(u) for u in users]


@router.post("", status_code=201)
async def invite_user(body: InviteRequest, db: AsyncSession = Depends(get_db)) -> InviteOut:
    email = body.email.lower()
    if await db.scalar(select(User).where(User.email == email)):
        raise HTTPException(409, "Someone with this email is already on the team.")
    token = new_invite_token()
    user = User(email=email, name=body.name, role=body.role, invite_token_hash=hash_token(token),
                invite_expires_at=datetime.now(UTC) + INVITE_LIFETIME)
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return InviteOut(user=to_out(user), invite_url=f"{settings.public_url}/invite/{token}")


@router.patch("/{user_id}")
async def change_role(user_id: int, body: RoleUpdate, db: AsyncSession = Depends(get_db)) -> UserOut:
    user = await get_user_or_404(db, user_id)
    if user.role == "admin" and body.role != "admin":
        await ensure_another_admin(db)
    user.role = body.role
    await db.commit()
    return to_out(user)


@router.delete("/{user_id}", status_code=204)
async def remove_user(user_id: int, db: AsyncSession = Depends(get_db)) -> None:
    user = await get_user_or_404(db, user_id)
    if user.role == "admin":
        await ensure_another_admin(db)
    await db.delete(user)  # their API keys are deleted with them (ON DELETE CASCADE)
    await db.commit()


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
