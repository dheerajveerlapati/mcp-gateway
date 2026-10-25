"""Database connection and the gateway's four tables.

users      who is on the team, and their role
api_keys   each user's keys for MCP clients (only a hash is stored)
servers    the registered upstream MCP servers (credential stored encrypted)
tool_permissions  admin overrides of who may use a tool
audit_log  one row per tool call
"""

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, String, Text, func
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from app.config import settings

engine = create_async_engine(settings.database_url, pool_pre_ping=True)
Session = async_sessionmaker(engine, expire_on_commit=False)


class Base(DeclarativeBase):
    # Store every timestamp with its time zone, so "today" is never ambiguous.
    type_annotation_map = {datetime: DateTime(timezone=True)}


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(255), unique=True)
    name: Mapped[str] = mapped_column(String(100))
    role: Mapped[str] = mapped_column(String(20))  # "admin" or "member"
    # Empty until an invited user sets their password.
    password_hash: Mapped[str | None] = mapped_column(String(255))
    # One-time invite link (hashed), cleared once the invite is accepted.
    invite_token_hash: Mapped[str | None] = mapped_column(String(64), unique=True)
    invite_expires_at: Mapped[datetime | None]
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())


class ApiKey(Base):
    __tablename__ = "api_keys"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(100))  # e.g. "Claude Code on laptop"
    # First characters of the key, so people can tell their keys apart.
    prefix: Mapped[str] = mapped_column(String(16))
    # SHA-256 of the full key. The key itself is shown once and never stored.
    key_hash: Mapped[str] = mapped_column(String(64), unique=True)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    last_used_at: Mapped[datetime | None]
    revoked_at: Mapped[datetime | None]


class Server(Base):
    __tablename__ = "servers"

    id: Mapped[int] = mapped_column(primary_key=True)
    # Short unique name, also the tool prefix: "woo" -> "woo__list_orders".
    name: Mapped[str] = mapped_column(String(40), unique=True)
    url: Mapped[str] = mapped_column(String(500))
    # "none", "bearer" (Authorization: Bearer <secret>) or "header" (<auth_header>: <secret>)
    auth_type: Mapped[str] = mapped_column(String(10), default="none")
    auth_header: Mapped[str | None] = mapped_column(String(100))
    # The secret, encrypted with ENCRYPTION_KEY. Never returned by the API.
    credential_encrypted: Mapped[str | None] = mapped_column(Text)
    enabled: Mapped[bool] = mapped_column(default=True)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now(), onupdate=func.now())


class ToolPermission(Base):
    """An admin's override of who may use one tool (see app/permissions.py)."""

    __tablename__ = "tool_permissions"

    server_id: Mapped[int] = mapped_column(ForeignKey("servers.id", ondelete="CASCADE"), primary_key=True)
    tool_name: Mapped[str] = mapped_column(String(100), primary_key=True)  # the upstream's name, unprefixed
    access: Mapped[str] = mapped_column(String(10))  # "everyone" or "admins"


class AuditLog(Base):
    __tablename__ = "audit_log"
    # The rate limit counts one user's calls in the last minute: this index makes that cheap.
    __table_args__ = (Index("ix_audit_log_user_time", "user_id", "created_at"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now(), index=True)
    # Who. The email is copied so the row still reads well after the user is deleted.
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), index=True)
    user_email: Mapped[str] = mapped_column(String(255))
    source: Mapped[str] = mapped_column(String(10))  # "api_key" or "chat"
    # What. Names are copied for the same reason.
    server_name: Mapped[str] = mapped_column(String(40))
    tool_name: Mapped[str] = mapped_column(String(100))
    # How it went.
    duration_ms: Mapped[int]
    outcome: Mapped[str] = mapped_column(String(10))  # "ok", "error", "timeout" or "denied"
    error: Mapped[str | None] = mapped_column(Text)
