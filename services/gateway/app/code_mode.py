"""Code mode: the model writes one small program instead of many tool calls.

A task like "today's orders with totals in USD" normally takes one model
round trip per tool call, and every intermediate result passes through the
model. With `gateway__run_code` the model writes a short JavaScript program
that makes all the calls itself; only the program's final result goes back
to the model. Fewer rounds, far fewer tokens.

The tool sits in every tool list next to the normal tools, so a client can
still call tools one by one; the model picks whichever fits the task.

Safety. The program is code written by a model, possibly steered by text from
an untrusted upstream, and the gateway process holds every upstream
credential. So the program never runs in this process:
- It runs in a separate Deno process started with NO permissions: no network,
  no files, no environment variables (it is also started with an empty
  environment), no subprocesses.
- Its only way out is `tools.<server>.<tool>(args)`, which comes back here and
  goes through `route_call`: the same permissions, per-user server access,
  rate limit and audit log as any single call.
- Limits: 60 seconds per program, 50 tool calls, 64 MB of memory, 4 programs
  at a time per gateway pod, and the output is cut at 20,000 characters.
"""

import asyncio
import json
import logging
from collections.abc import Awaitable, Callable
from pathlib import Path

from mcp_types import CallToolResult, TextContent, Tool

log = logging.getLogger("gateway.code_mode")

RUN_CODE = "gateway__run_code"
RUNNER = Path(__file__).with_name("code_runner.js")
TIMEOUT_SECONDS = 60
MAX_CALLS = 50
MEMORY_MB = 64
MAX_OUTPUT = 20_000
# The program sees none of the gateway's environment (credentials, keys).
SANDBOX_ENV = {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": "/tmp", "DENO_DIR": "/tmp/deno",
               "DENO_NO_UPDATE_CHECK": "1", "NO_COLOR": "1"}

running = asyncio.Semaphore(4)

RUN_CODE_TOOL = Tool(
    name=RUN_CODE,
    description=(
        "Run a short JavaScript program that calls several tools in one go. Prefer it when a task needs "
        "more than two tool calls, loops over items, or combines results (totals, conversions, "
        "comparisons): only the final result comes back, so it is faster and uses far fewer tokens.\n"
        "Inside the program every tool you can use is a function tools.<server>.<tool>(arguments), "
        "e.g. `await tools.woo.list_orders({date_from: '2026-10-26', date_to: '2026-10-26'})` for "
        "woo__list_orders. It returns the tool's result (parsed from JSON when possible); a failed call "
        "throws an Error you can catch. `return` the value you want back; console.log output is returned too.\n"
        "Use only result fields named in a tool's description or output schema; if a tool does not say what "
        "it returns, first run a one-line program that returns one sample result, then write the full program.\n"
        "Plain JavaScript only: no TypeScript types, no imports, no network or files. "
        f"Limits: {TIMEOUT_SECONDS} seconds and {MAX_CALLS} tool calls per program."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "code": {"type": "string", "description": "Statements ending in `return <value>`, e.g. "
                     "\"const r = await tools.woo.list_orders({}); return r.count;\""},
        },
        "required": ["code"],
    },
)

# Runs one gateway tool for the program, e.g. ("woo__list_orders", {...}).
CallTool = Callable[[str, dict], Awaitable[CallToolResult]]


async def run_code(code: str, call_tool: CallTool) -> CallToolResult:
    async with running:
        process = await asyncio.create_subprocess_exec(
            "deno", "run", "--quiet", "--no-prompt", "--no-remote", "--no-npm", "--no-config",
            f"--v8-flags=--max-old-space-size={MEMORY_MB}", str(RUNNER),
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            env=SANDBOX_ENV, limit=4 * 1024 * 1024,  # one message per line; tool results can be long
        )
        try:
            async with asyncio.timeout(TIMEOUT_SECONDS):
                return await converse(process, code, call_tool)
        except TimeoutError:
            return failure(f"The program did not finish within {TIMEOUT_SECONDS} seconds.")
        except Exception:
            log.exception("Code mode failed")
            return failure("The program could not be run because of an internal error.")
        finally:
            if process.returncode is None:
                process.kill()
            await process.wait()


async def converse(process: asyncio.subprocess.Process, code: str, call_tool: CallTool) -> CallToolResult:
    """Hand the program to the runner, answer its tool calls, return its result."""
    await write(process, {"code": code})
    calls = 0
    while line := await process.stdout.readline():
        try:
            message = json.loads(line)
            message["type"]
        except (ValueError, TypeError, KeyError):
            # The program can write to stdout itself; anything that is not a message ends it.
            return failure("The program wrote output the gateway could not read. Use console.log or return.")
        if message["type"] == "call":
            calls += 1
            if calls > MAX_CALLS:
                await write(process, {"id": message["id"], "ok": False,
                                      "text": f"Too many tool calls: at most {MAX_CALLS} per program."})
                continue
            result = await call_tool(str(message["name"]), message.get("arguments") or {})
            text = "\n".join(part.text for part in result.content if part.type == "text")
            await write(process, {"id": message["id"], "ok": not result.is_error, "text": text})
        elif message["type"] == "done":
            output = json.dumps({"result": message["result"], "logs": message["logs"], "tool_calls": calls},
                                indent=1, ensure_ascii=False)
            return CallToolResult(content=[TextContent(type="text", text=cut(output))])
        else:
            details = "\n".join(message.get("logs") or [])
            return failure(f"The program failed: {message['error']}" + (f"\nLogs:\n{details}" if details else ""))

    # The runner ended without an answer: a syntax error, out of memory...
    stderr = (await process.stderr.read()).decode(errors="replace").strip()
    log.info("Code runner exited without a result: %s", stderr[:500])
    return failure(f"The program could not run: {cut(stderr) or 'the runner stopped unexpectedly'}")


async def write(process: asyncio.subprocess.Process, message: dict) -> None:
    try:
        process.stdin.write((json.dumps(message) + "\n").encode())
        await process.stdin.drain()
    except (BrokenPipeError, ConnectionResetError):
        # The program already finished (e.g. it returned without awaiting a
        # call); its last message is still waiting on stdout.
        pass


def cut(text: str) -> str:
    return text if len(text) <= MAX_OUTPUT else text[:MAX_OUTPUT] + "\n... (output cut)"


def failure(message: str) -> CallToolResult:
    return CallToolResult(content=[TextContent(type="text", text=message)], is_error=True)
