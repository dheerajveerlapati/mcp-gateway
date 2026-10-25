"""Search mode, for when there are too many tools to hand to a model at once.

Ten servers can mean hundreds of tools: every tool description is sent to the
model with every request, which costs tokens and makes it pick worse. A client
that connects to /mcp?tools=search sees only two tools:

  gateway__search_tools(query)          find tools by keywords
  gateway__call_tool(name, arguments)   run one of the tools it found

The model searches first, reads the few matching descriptions and schemas,
then calls the one it needs. gateway__call_tool goes through exactly the same
routing, permissions, rate limit and audit log as a direct call.

Ranking is deliberately simple: count the query words that appear in a tool's
name (worth 2) and description (worth 1).
"""

import json
import re

from mcp_types import Tool

SEARCH_TOOL = "gateway__search_tools"
CALL_TOOL = "gateway__call_tool"

META_TOOLS = [
    Tool(
        name=SEARCH_TOOL,
        description="Find tools for a task by keywords, e.g. 'orders today' or 'create github issue'. "
                    "Returns matching tool names with their descriptions and argument schemas.",
        input_schema={
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "What you want to do, in a few words"},
                "limit": {"type": "integer", "default": 8, "minimum": 1, "maximum": 20},
            },
            "required": ["query"],
        },
    ),
    Tool(
        name=CALL_TOOL,
        description="Run a tool found with gateway__search_tools, by its exact name.",
        input_schema={
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Exact tool name, e.g. woo__list_orders"},
                "arguments": {"type": "object", "description": "Arguments matching the tool's schema"},
            },
            "required": ["name"],
        },
    ),
]


def words(text: str) -> set[str]:
    return set(re.findall(r"[a-z0-9]+", text.lower()))


def search(tools: list[Tool], query: str, limit: int = 8) -> str:
    """The best-matching tools, as JSON text for the model."""
    wanted = words(query)
    scored = []
    for tool in tools:
        score = 2 * len(wanted & words(tool.name)) + len(wanted & words(tool.description or ""))
        if score:
            scored.append((score, tool))
    scored.sort(key=lambda pair: pair[0], reverse=True)

    matches = [
        {"name": tool.name, "description": tool.description, "arguments_schema": tool.input_schema}
        for _, tool in scored[: max(1, min(limit, 20))]
    ]
    return json.dumps({"count": len(matches), "tools": matches}, indent=1)
