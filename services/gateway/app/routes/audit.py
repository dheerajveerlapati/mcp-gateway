"""The audit log: admins see every tool call, members see their own."""

from datetime import datetime

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import current_user, get_db
from app.db import AuditLog, User

router = APIRouter(prefix="/api/audit", tags=["audit"])


class AuditOut(BaseModel):
    id: int
    created_at: datetime
    user_email: str
    source: str
    server_name: str
    tool_name: str
    duration_ms: int
    outcome: str
    error: str | None


@router.get("")
async def list_audit(
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
    server: str | None = None,
    outcome: str | None = None,
    user_email: str | None = None,
    limit: int = Query(default=100, le=500),
) -> list[AuditOut]:
    query = select(AuditLog).order_by(AuditLog.id.desc()).limit(limit)
    if user.role != "admin":
        query = query.where(AuditLog.user_id == user.id)
    elif user_email:
        query = query.where(AuditLog.user_email == user_email)
    if server:
        query = query.where(AuditLog.server_name == server)
    if outcome:
        query = query.where(AuditLog.outcome == outcome)

    rows = await db.scalars(query)
    return [AuditOut.model_validate(row, from_attributes=True) for row in rows]
