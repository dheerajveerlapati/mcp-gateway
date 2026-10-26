import { ArrowUp, Check, ChevronRight, Code2, RotateCcw, Square, Waypoints, Wrench, X } from 'lucide-react'
import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import { ApiError } from '../api'
import { useMe } from '../session'
import { ErrorText, messageOf } from '../ui'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/misc'
import { cn } from '@/lib/utils'

// One tool call made by the agent, shown as it happens.
type ToolCall = {
  id: string
  name: string
  args: unknown
  ok?: boolean
  result?: string
  startedAt: number
  finishedAt?: number
}

type Turn =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; tools: ToolCall[]; error?: string; stopped?: boolean; verb: string }

// Events streamed by POST /api/chat (see services/gateway/app/agent.py).
type ChatEvent =
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | { type: 'tool_result'; id: string; name: string; ok: boolean; content: string }
  | { type: 'answer'; content: string }
  | { type: 'error'; content: string }
  | { type: 'done' }

// What the indicator says while the model thinks, one picked per answer.
const VERBS = ['Thinking', 'Pondering', 'Reasoning', 'Percolating', 'Mulling it over', 'Cogitating', 'Working']

const SUGGESTIONS = [
  'What orders came in today?',
  'List the 5 most recent orders with totals converted to USD, and their sum.',
  'Which products are in the store, and what do they cost?',
  'What time is it in New York, and how much is shipping 2 kg to the US?',
]

export default function Chat() {
  const me = useMe()
  const [turns, setTurns] = useState<Turn[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const controller = useRef<AbortController | null>(null)
  const bottom = useRef<HTMLDivElement>(null)

  // Keep the newest message in view while the answer streams in.
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' })
  }, [turns])

  // Esc stops the current answer, as in Claude Code.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') controller.current?.abort()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Apply one event to the last (assistant) turn.
  function apply(event: ChatEvent) {
    setTurns(previous => {
      const turns = [...previous]
      const last = turns.at(-1)
      if (!last || last.role !== 'assistant') return previous
      const turn = { ...last, tools: [...last.tools] }

      if (event.type === 'tool_call') {
        turn.tools.push({ id: event.id, name: event.name, args: event.args, startedAt: Date.now() })
      }
      if (event.type === 'tool_result') {
        turn.tools = turn.tools.map(t =>
          t.id === event.id ? { ...t, ok: event.ok, result: event.content, finishedAt: Date.now() } : t,
        )
      }
      if (event.type === 'answer') turn.content = event.content
      if (event.type === 'error') turn.error = event.content

      turns[turns.length - 1] = turn
      return turns
    })
  }

  async function ask(text: string) {
    const question = text.trim()
    if (!question || busy) return

    // The server keeps no history: we send the conversation each time.
    const history = [
      ...turns.map(t => ({ role: t.role, content: t.content })).filter(m => m.content),
      { role: 'user', content: question },
    ]
    const verb = VERBS[Math.floor(Math.random() * VERBS.length)]
    setTurns([...turns, { role: 'user', content: question }, { role: 'assistant', content: '', tools: [], verb }])
    setInput('')
    setBusy(true)
    setError(null)
    controller.current = new AbortController()

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history }),
        signal: controller.current.signal,
      })
      if (!response.ok || !response.body) throw new ApiError(`Chat failed (HTTP ${response.status})`, response.status)
      await readEvents(response.body, apply)
    } catch (e) {
      if (controller.current?.signal.aborted) markStopped()
      else setError(messageOf(e))
    } finally {
      controller.current = null
      setBusy(false)
    }
  }

  function markStopped() {
    setTurns(previous => {
      const last = previous.at(-1)
      if (!last || last.role !== 'assistant') return previous
      return [...previous.slice(0, -1), { ...last, stopped: true }]
    })
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    ask(input)
  }

  function onComposerKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends, Shift+Enter adds a line.
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      ask(input)
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center justify-between border-b px-6">
        <div>
          <h1 className="text-sm font-semibold">Chat</h1>
          <p className="text-xs text-muted-foreground">Uses the gateway's tools as {me.name}. Every call is audited.</p>
        </div>
        {turns.length > 0 && (
          <Button variant="ghost" size="sm" onClick={() => setTurns([])} disabled={busy}>
            <RotateCcw /> New chat
          </Button>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-6 py-8">
          {turns.length === 0 && <EmptyState onPick={ask} />}
          {turns.map((turn, i) =>
            turn.role === 'user' ? (
              <div key={i} className="flex justify-end">
                <div className="max-w-[85%] rounded-2xl bg-secondary px-4 py-2.5 text-sm whitespace-pre-wrap">
                  {turn.content}
                </div>
              </div>
            ) : (
              <AssistantTurn key={i} turn={turn} working={busy && i === turns.length - 1} />
            ),
          )}
          <ErrorText error={error} />
          <div ref={bottom} />
        </div>
      </div>

      <div className="shrink-0 px-6 pb-5">
        <form
          onSubmit={submit}
          className="mx-auto flex w-full max-w-3xl items-end gap-2 rounded-2xl border bg-card p-2 shadow-sm focus-within:ring-[3px] focus-within:ring-ring/30"
        >
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={onComposerKey}
            rows={1}
            placeholder="Ask about orders, products, or anything your tools can do…"
            className="max-h-48 min-h-9 flex-1 resize-none bg-transparent px-2 py-2 text-sm outline-none [field-sizing:content] placeholder:text-muted-foreground"
          />
          {busy ? (
            <Button type="button" size="icon" variant="secondary" onClick={() => controller.current?.abort()} title="Stop (Esc)">
              <Square className="size-3.5 fill-current" />
            </Button>
          ) : (
            <Button type="submit" size="icon" disabled={!input.trim()} title="Send (Enter)">
              <ArrowUp />
            </Button>
          )}
        </form>
        <p className="mx-auto mt-2 max-w-3xl text-center text-xs text-muted-foreground">
          Enter to send · Shift+Enter for a new line · Esc to stop
        </p>
      </div>
    </div>
  )
}

function EmptyState({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="flex flex-col items-center pt-[12vh] text-center">
      <div className="flex size-11 items-center justify-center rounded-xl border bg-card shadow-xs">
        <Waypoints className="size-5" />
      </div>
      <h2 className="mt-4 text-lg font-semibold tracking-tight">What can I help with?</h2>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">
        I answer with the tools of every server you can use. For multi-step questions I write one small program instead
        of many calls.
      </p>
      <div className="mt-8 grid w-full gap-2 sm:grid-cols-2">
        {SUGGESTIONS.map(text => (
          <button
            key={text}
            onClick={() => onPick(text)}
            className="rounded-xl border bg-card px-4 py-3 text-left text-sm text-muted-foreground shadow-xs transition-colors hover:bg-accent hover:text-foreground"
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  )
}

function AssistantTurn({ turn, working }: { turn: Extract<Turn, { role: 'assistant' }>; working: boolean }) {
  const running = turn.tools.find(t => t.ok === undefined)
  return (
    <div className="flex gap-3">
      <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border bg-card">
        <Waypoints className="size-3.5" />
      </div>
      <div className="min-w-0 flex-1 space-y-3">
        {turn.tools.length > 0 && (
          <div className="space-y-1.5">
            {turn.tools.map(tool => (
              <ToolCallCard key={tool.id} tool={tool} />
            ))}
          </div>
        )}
        {turn.content && (
          // Models answer in Markdown (tables, lists, sometimes <br>). Sanitizing
          // keeps harmless tags and drops scripts: the text may come from tools.
          <div className="prose prose-sm max-w-none text-foreground dark:prose-invert prose-headings:font-semibold prose-pre:bg-muted prose-pre:text-foreground prose-table:text-sm prose-th:font-medium">
            <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw, rehypeSanitize]}>
              {turn.content}
            </Markdown>
          </div>
        )}
        {turn.error && <ErrorText error={turn.error} />}
        {turn.stopped && <p className="text-sm text-muted-foreground">Stopped.</p>}
        {working && !turn.content && !turn.error && (
          <WorkingIndicator verb={running ? `Running ${displayName(running.name)}` : turn.verb} />
        )}
      </div>
    </div>
  )
}

// Claude Code-style progress: a turning glyph, shimmering words, elapsed time.
const GLYPHS = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢']

function WorkingIndicator({ verb }: { verb: string }) {
  const [tick, setTick] = useState(0)
  const [started] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setTick(n => n + 1), 120)
    return () => clearInterval(timer)
  }, [])
  const seconds = Math.floor((Date.now() - started) / 1000)

  return (
    <div className="flex items-center gap-2 text-sm" aria-live="polite">
      <span className="w-4 text-center font-mono text-base leading-none text-spark">{GLYPHS[tick % GLYPHS.length]}</span>
      <span className="shimmer-text font-medium">{verb}…</span>
      <span className="text-xs text-muted-foreground tabular-nums">
        ({seconds}s · esc to stop)
      </span>
    </div>
  )
}

// "woo__list_orders" -> "woo · list_orders"; code mode gets a friendlier name.
function displayName(name: string): string {
  if (name === 'gateway__run_code') return 'a program'
  const [server, ...rest] = name.split('__')
  return rest.length ? `${server} · ${rest.join('__')}` : name
}

function ToolCallCard({ tool }: { tool: ToolCall }) {
  const [, setNow] = useState(0)
  const state = tool.ok === undefined ? 'running' : tool.ok ? 'ok' : 'error'
  const isProgram = tool.name === 'gateway__run_code'
  const code = isProgram ? String((tool.args as { code?: string })?.code ?? '') : null
  const [server, ...rest] = tool.name.split('__')

  // While running, re-render each second so the duration counts up.
  useEffect(() => {
    if (state !== 'running') return
    const timer = setInterval(() => setNow(n => n + 1), 1000)
    return () => clearInterval(timer)
  }, [state])
  const seconds = ((tool.finishedAt ?? Date.now()) - tool.startedAt) / 1000

  return (
    <Collapsible className="group/tool rounded-lg border bg-card text-sm">
      <CollapsibleTrigger className="flex w-full items-center gap-2.5 px-3 py-2 text-left outline-none hover:bg-muted/40 focus-visible:ring-[3px] focus-visible:ring-ring/50 rounded-lg">
        <StatusIcon state={state} />
        {isProgram ? <Code2 className="size-3.5 text-muted-foreground" /> : <Wrench className="size-3.5 text-muted-foreground" />}
        <span className="min-w-0 flex-1 truncate font-mono text-[13px]">
          {isProgram ? (
            <span>Ran a program</span>
          ) : (
            <>
              <span className="text-muted-foreground">{server}__</span>
              {rest.join('__')}
            </>
          )}
        </span>
        <span className="text-xs text-muted-foreground tabular-nums">{seconds < 0.1 ? '' : `${seconds.toFixed(1)}s`}</span>
        <ChevronRight className="size-4 text-muted-foreground transition-transform group-data-[state=open]/tool:rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-3 border-t px-3 py-3">
        <Block label={isProgram ? 'Program' : 'Arguments'}>{code ?? JSON.stringify(tool.args, null, 2)}</Block>
        {tool.result !== undefined && <Block label="Result" tone={tool.ok ? undefined : 'error'}>{tool.result}</Block>}
      </CollapsibleContent>
    </Collapsible>
  )
}

function StatusIcon({ state }: { state: 'running' | 'ok' | 'error' }) {
  if (state === 'running') {
    return <span className="size-3.5 animate-spin rounded-full border-[1.5px] border-muted-foreground/30 border-t-spark" />
  }
  if (state === 'ok') {
    return (
      <span className="flex size-3.5 items-center justify-center rounded-full bg-success/15 text-success">
        <Check className="size-2.5" strokeWidth={3} />
      </span>
    )
  }
  return (
    <span className="flex size-3.5 items-center justify-center rounded-full bg-destructive/15 text-destructive">
      <X className="size-2.5" strokeWidth={3} />
    </span>
  )
}

function Block({ label, children, tone }: { label: string; children: string; tone?: 'error' }) {
  return (
    <div className="space-y-1.5">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <pre
        className={cn(
          'max-h-72 overflow-auto rounded-md bg-muted/60 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words',
          tone === 'error' && 'text-destructive',
        )}
      >
        {children}
      </pre>
    </div>
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
