"""Dashboard login, logout and accepting an invite."""

from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import SESSION_COOKIE, current_user, get_db
from app.config import settings
from app.db import User
from app.security import (
    DUMMY_PASSWORD_HASH,
    SESSION_AUDIENCE,
    create_token,
    hash_password,
    hash_token,
    verify_password,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])

SESSION_LIFETIME = timedelta(hours=12)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class AcceptInviteRequest(BaseModel):
    password: str = Field(min_length=8)


class Me(BaseModel):
    id: int
    email: str
    name: str
    role: str


def to_me(user: User) -> Me:
    return Me(id=user.id, email=user.email, name=user.name, role=user.role)


def start_session(response: Response, user: User) -> None:
    """Log the user in by setting a signed, httpOnly cookie."""
    response.set_cookie(
        SESSION_COOKIE,
        create_token(user.id, SESSION_AUDIENCE, SESSION_LIFETIME),
        max_age=int(SESSION_LIFETIME.total_seconds()),
        httponly=True,  # page scripts cannot read it
        samesite="lax",  # not sent on cross-site POSTs (CSRF protection)
        secure=settings.public_url.startswith("https://"),
    )


@router.post("/login")
async def login(body: LoginRequest, response: Response, db: AsyncSession = Depends(get_db)) -> Me:
    user = await db.scalar(select(User).where(User.email == body.email.lower()))
    password_hash = user.password_hash if user and user.password_hash else DUMMY_PASSWORD_HASH
    if not verify_password(password_hash, body.password) or user is None or user.password_hash is None:
        raise HTTPException(401, "Wrong email or password.")
    start_session(response, user)
    return to_me(user)


@router.post("/logout", status_code=204)
async def logout(response: Response) -> None:
    response.delete_cookie(SESSION_COOKIE)


@router.get("/me")
async def me(user: User = Depends(current_user)) -> Me:
    return to_me(user)


async def find_invite(db: AsyncSession, token: str) -> User:
    user = await db.scalar(select(User).where(User.invite_token_hash == hash_token(token)))
    if user is None or user.invite_expires_at is None or user.invite_expires_at < datetime.now(UTC):
        raise HTTPException(404, "This invite link is invalid or has expired.")
    return user


@router.get("/invites/{token}")
async def show_invite(token: str, db: AsyncSession = Depends(get_db)) -> Me:
    """Lets the invite page greet the person before they choose a password."""
    return to_me(await find_invite(db, token))


@router.post("/invites/{token}/accept")
async def accept_invite(
    token: str, body: AcceptInviteRequest, response: Response, db: AsyncSession = Depends(get_db)
) -> Me:
    user = await find_invite(db, token)
    user.password_hash = hash_password(body.password)
    user.invite_token_hash = None  # one-time link: it stops working now
    user.invite_expires_at = None
    await db.commit()
    start_session(response, user)
    return to_me(user)
