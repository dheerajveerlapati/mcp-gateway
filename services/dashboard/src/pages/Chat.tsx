import { type FormEvent, useState } from 'react'
import Markdown from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import { ApiError } from '../api'
import { ErrorText, messageOf } from '../ui'

// One tool call made by the agent, shown as it happens.
type ToolCall = { id: string; name: string; args: unknown; ok?: boolean; result?: string }

type Turn =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; tools: ToolCall[]; error?: string }

// Events streamed by POST /api/chat (see services/gateway/app/agent.py).
type ChatEvent =
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | { type: 'tool_result'; id: string; name: string; ok: boolean; content: string }
  | { type: 'answer'; content: string }
  | { type: 'error'; content: string }
  | { type: 'done' }

export default function Chat() {
  const [turns, setTurns] = useState<Turn[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Apply one event to the last (assistant) turn.
  function apply(event: ChatEvent) {
    setTurns(previous => {
      const turns = [...previous]
      const last = turns.at(-1)
      if (!last || last.role !== 'assistant') return previous
      const turn = { ...last, tools: [...last.tools] }

      if (event.type === 'tool_call') turn.tools.push({ id: event.id, name: event.name, args: event.args })
      if (event.type === 'tool_result') {
        turn.tools = turn.tools.map(t => (t.id === event.id ? { ...t, ok: event.ok, result: event.content } : t))
      }
      if (event.type === 'answer') turn.content = event.content
      if (event.type === 'error') turn.error = event.content

      turns[turns.length - 1] = turn
      return turns
    })
  }

  async function send(event: FormEvent) {
    event.preventDefault()
    const question = input.trim()
    if (!question || busy) return

    // The server keeps no history: we send the conversation each time.
    const history = [
      ...turns.map(t => ({ role: t.role, content: t.content })).filter(m => m.content),
      { role: 'user', content: question },
    ]
    setTurns([...turns, { role: 'user', content: question }, { role: 'assistant', content: '', tools: [] }])
    setInput('')
    setBusy(true)
    setError(null)

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history }),
      })
      if (!response.ok || !response.body) throw new ApiError(`Chat failed (HTTP ${response.status})`, response.status)
      await readEvents(response.body, apply)
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <h1>Chat</h1>
      <p className="muted">
        The assistant uses the same tools as your MCP clients, through the gateway, as you.
        Every tool call it makes appears in the audit log under your name.
      </p>

      <div className="chat">
        {turns.map((turn, i) =>
          turn.role === 'user' ? (
            <div key={i} className="bubble user">{turn.content}</div>
          ) : (
            <div key={i} className="bubble assistant">
              {turn.tools.map(tool => <ToolCallView key={tool.id} tool={tool} />)}
              {turn.content && (
                <div className="answer">
                  {/* Models answer in Markdown (tables, lists, sometimes <br>). Sanitizing
                      keeps harmless tags and drops scripts: the text may come from tools. */}
                  <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw, rehypeSanitize]}>
                    {turn.content}
                  </Markdown>
                </div>
              )}
              {turn.error && <p className="error">{turn.error}</p>}
              {busy && i === turns.length - 1 && !turn.content && !turn.error && <span className="muted">Thinking…</span>}
            </div>
          ),
        )}
      </div>

      <ErrorText error={error} />
      <form className="row" onSubmit={send}>
        <input value={input} onChange={e => setInput(e.target.value)} placeholder="e.g. What orders came in today?" disabled={busy} />
        <button type="submit" disabled={busy}>Send</button>
      </form>
    </>
  )
}

function ToolCallView({ tool }: { tool: ToolCall }) {
  const state = tool.ok === undefined ? 'running' : tool.ok ? 'ok' : 'error'
  return (
    <details className={`tool-call tool-${state}`}>
      <summary>
        🔧 <code>{tool.name}</code> <span className="muted">{state}</span>
      </summary>
      <div className="muted">Arguments</div>
      <pre>{JSON.stringify(tool.args, null, 2)}</pre>
      {tool.result !== undefined && (
        <>
          <div className="muted">Result</div>
          <pre>{tool.result}</pre>
        </>
      )}
    </details>
  )
}

// Read a Server-Sent Events stream: blocks of "data: {json}" separated by a blank line.
async function readEvents(body: ReadableStream<Uint8Array>, onEvent: (event: ChatEvent) => void) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) return
    buffer += decoder.decode(value, { stream: true })
    const blocks = buffer.split('\n\n')
    buffer = blocks.pop() ?? '' // the last block may be incomplete
    for (const block of blocks) {
      if (block.startsWith('data: ')) onEvent(JSON.parse(block.slice(6)))
    }
  }
}
