// Runs one model-written program for code mode (see code_mode.py).
//
// Deno starts this file with no permissions: no network, no files, no
// environment, no subprocesses. The program's only way out is `tools`, which
// asks the gateway (our parent process) to make a call, over stdin/stdout:
//
//   gateway -> runner  {"code": "..."}                         first line
//   runner  -> gateway {"type": "call", "id": 1, "name": "woo__list_orders", "arguments": {...}}
//   gateway -> runner  {"id": 1, "ok": true, "text": "..."}   the tool's result
//   runner  -> gateway {"type": "done", "result": ..., "logs": [...]}   or "error"
//
// The gateway runs every call through its normal checks, so a program can do
// exactly what its user could do with single calls, and nothing more.

const encoder = new TextEncoder();
const reader = Deno.stdin.readable.pipeThrough(new TextDecoderStream()).getReader();
let buffered = "";

async function nextMessage() {
  while (!buffered.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) throw new Error("The gateway closed the connection.");
    buffered += value;
  }
  const end = buffered.indexOf("\n");
  const line = buffered.slice(0, end);
  buffered = buffered.slice(end + 1);
  return JSON.parse(line);
}

async function send(message) {
  let bytes = encoder.encode(JSON.stringify(message) + "\n");
  while (bytes.length > 0) bytes = bytes.subarray(await Deno.stdout.write(bytes));
}

// Tool results are text; most of our tools return JSON, so hand back objects.
function parse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// Calls waiting for their answer, by id. Several can be open at once
// (Promise.all); the gateway answers them one by one.
const waiting = new Map();
let lastId = 0;

async function receiveAnswers() {
  for (;;) {
    const answer = await nextMessage();
    const call = waiting.get(answer.id);
    waiting.delete(answer.id);
    if (call && answer.ok) call.resolve(parse(answer.text));
    else if (call) call.reject(new Error(answer.text));
  }
}

function callTool(name, args) {
  const id = ++lastId;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    send({ type: "call", id, name, arguments: args ?? {} });
  });
}

// tools.woo.list_orders(args) -> the gateway tool "woo__list_orders".
// "then" is left undefined so `await tools.woo` does not look like a promise.
const server = (serverName) =>
  new Proxy({}, {
    get: (_, toolName) => toolName === "then" ? undefined : (args) => callTool(`${serverName}__${String(toolName)}`, args),
  });
const tools = new Proxy({}, { get: (_, serverName) => serverName === "then" ? undefined : server(String(serverName)) });

const logs = [];
const log = (...parts) => logs.push(parts.map((p) => typeof p === "string" ? p : JSON.stringify(p)).join(" "));
const programConsole = { log, info: log, warn: log, error: log };

const { code } = await nextMessage();
receiveAnswers().catch(() => {}); // ends when the gateway closes stdin

// Models write either a function body ("const x = ...; return x") or a whole
// function ("async () => { ... }"). Try the code as one expression first; if
// that does not parse, it is a body. A function that comes back is called.
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
function compile(source) {
  try {
    return new AsyncFunction("tools", "console", `return (${source}\n)`);
  } catch {
    return new AsyncFunction("tools", "console", source);
  }
}

try {
  let result = await compile(code)(tools, programConsole);
  if (typeof result === "function") result = await result(tools);
  await send({ type: "done", result: result ?? null, logs });
} catch (error) {
  await send({ type: "error", error: String(error?.message ?? error), logs });
}
Deno.exit(0);
