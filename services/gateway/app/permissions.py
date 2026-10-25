"""Who may use which tool.

The rule:
- A tool the upstream marks read-only (MCP annotation `readOnlyHint`) is for
  everyone: it can only look things up.
- Any other tool may change something (create a product, change an order), so
  by default only admins may use it.
- An admin can override any tool to "everyone" or "admins".

Tools a caller may not use are hidden from their tool list AND refused if
called directly (a client could guess a tool name it was never shown).
"""

from mcp_types import Tool
from sqlalchemy import select

from app.db import Session, ToolPermission

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
