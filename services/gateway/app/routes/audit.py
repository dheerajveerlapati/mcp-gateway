"""The audit log: admins see every tool call, members see their own."""

from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import admin_user, current_user, get_db
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


class ServerStats(BaseModel):
    server_name: str
    calls: int
    errors: int  # anything that is not "ok": error, timeout, denied
    error_rate: float
    avg_ms: int
    p95_ms: int


@router.get("/stats", dependencies=[Depends(admin_user)])
async def stats(db: AsyncSession = Depends(get_db), hours: int = Query(default=24, le=24 * 30)) -> list[ServerStats]:
    """Per-server calls, error rate and latency over the last `hours` (admins)."""
    since = datetime.now(UTC) - timedelta(hours=hours)
    rows = await db.execute(
        select(
            AuditLog.server_name,
            func.count(),
            func.count().filter(AuditLog.outcome != "ok"),
            func.avg(AuditLog.duration_ms),
            func.percentile_cont(0.95).within_group(AuditLog.duration_ms),
        )
        .where(AuditLog.created_at > since)
        .group_by(AuditLog.server_name)
        .order_by(AuditLog.server_name)
    )
    return [
        ServerStats(server_name=name, calls=calls, errors=errors, error_rate=round(errors / calls, 3),
                    avg_ms=int(avg or 0), p95_ms=int(p95 or 0))
        for name, calls, errors, avg, p95 in rows
    ]


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
