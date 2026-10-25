"""Who may use which tool.

The rule:
- A tool the upstream marks read-only (MCP annotation `readOnlyHint`) is for
  everyone: it can only look things up.
- Any other tool may change something (create a product, change an order), so
  by default only admins may use it.
- An admin can override any tool to "everyone" or "admins".

On top of that, a user can be limited to some servers only (`User.all_servers`
off, the allowed servers in `user_server_access`). The other servers' tools
are hidden and refused the same way, and a server added later is not given to
them until an admin ticks it. This is a hierarchy:
- The owner (the first admin, BOOTSTRAP_ADMIN_EMAIL) always has every server
  and cannot be limited.
- Any other admin or member can be limited.
- An admin can only give servers they have themselves, and can only change
  the access of someone whose servers they also have.

Tools a caller may not use are hidden from their tool list AND refused if
called directly (a client could guess a tool name it was never shown).
"""

from mcp_types import Tool
from sqlalchemy import select

from app.config import settings
from app.db import Session, ToolPermission, User, UserServerAccess

EVERYONE = "everyone"
ADMINS = "admins"


def default_access(tool: Tool | None) -> str:
    # An unknown tool (e.g. its server is unreachable) gets the safe default.
    if tool is not None and tool.annotations and tool.annotations.read_only_hint:
        return EVERYONE
    return ADMINS


def may_use(role: str, access: str) -> bool:
    return access == EVERYONE or role == "admin"


async def load_overrides() -> dict[tuple[int, str], str]:
    """All admin overrides, keyed by (server id, tool name)."""
    async with Session() as db:
        rows = await db.scalars(select(ToolPermission))
        return {(row.server_id, row.tool_name): row.access for row in rows}


def access_for(server_id: int, tool_name: str, tool: Tool | None, overrides: dict) -> str:
    return overrides.get((server_id, tool_name)) or default_access(tool)


def is_owner(user: User) -> bool:
    return user.email == settings.bootstrap_admin_email.lower()


async def allowed_server_ids(user: User) -> set[int] | None:
    """The ids of the servers this user may use, or None for every server."""
    if is_owner(user) or user.all_servers:
        return None
    async with Session() as db:
        rows = await db.scalars(select(UserServerAccess.server_id).where(UserServerAccess.user_id == user.id))
        return set(rows)


def may_use_server(allowed: set[int] | None, server_id: int) -> bool:
    return allowed is None or server_id in allowed


def covers(granter: set[int] | None, granted: set[int] | None) -> bool:
    """True if someone with `granter` access has every server in `granted`."""
    return granter is None or (granted is not None and granted <= granter)
