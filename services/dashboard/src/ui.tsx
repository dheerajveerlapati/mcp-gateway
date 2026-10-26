// Small pieces shared by several pages, built on the shadcn/ui components.
import { AlertCircle, Check, Copy } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

// Every page: a title, a line saying what the page is for, and its actions.
export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

// The content column of a normal page.
export function Page({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('mx-auto w-full max-w-6xl px-6 py-8', className)}>{children}</div>
}

export function ErrorText({ error }: { error: string | null }) {
  if (!error) return null
  return (
    <Alert variant="destructive">
      <AlertCircle />
      <AlertDescription>{error}</AlertDescription>
    </Alert>
  )
}

// Server status and audit outcomes share one look: a coloured dot and a word.
const STATUS_STYLE: Record<string, { variant: 'success' | 'destructive' | 'warning' | 'secondary'; dot: string }> = {
  connected: { variant: 'success', dot: 'bg-success' },
  ok: { variant: 'success', dot: 'bg-success' },
  unreachable: { variant: 'destructive', dot: 'bg-destructive' },
  error: { variant: 'destructive', dot: 'bg-destructive' },
  denied: { variant: 'destructive', dot: 'bg-destructive' },
  timeout: { variant: 'warning', dot: 'bg-warning' },
}

export function StatusBadge({ status }: { status: string }) {
  const style = STATUS_STYLE[status] ?? { variant: 'secondary', dot: 'bg-muted-foreground' }
  return (
    <Badge variant={style.variant} className="capitalize">
      <span className={cn('size-1.5 rounded-full', style.dot)} />
      {status}
    </Badge>
  )
}

export function formatTime(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—'
}

// Text the user must copy (an API key, an invite link, a command).
export function CopyBox({ label, value }: { label: string; value: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'select'>('idle')

  async function copy(button: HTMLButtonElement) {
    // The clipboard API only exists on https:// or localhost pages. On plain
    // http (local *.localtest.me) we select the text for Ctrl+C instead.
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(value)
      setState('copied')
      setTimeout(() => setState('idle'), 1500)
    } else {
      const code = button.parentElement?.querySelector('code')
      if (code) window.getSelection()?.selectAllChildren(code)
      setState('select')
    }
  }

  return (
    <div className="space-y-1.5">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="flex items-start gap-2 rounded-md border bg-muted/40 py-1.5 pr-1.5 pl-3">
        <code className="min-w-0 flex-1 py-1 font-mono text-[13px] break-all">{value}</code>
        <Button type="button" variant="ghost" size="icon-sm" onClick={e => copy(e.currentTarget)} title="Copy">
          {state === 'copied' ? <Check className="text-success" /> : <Copy />}
        </Button>
      </div>
      {state === 'select' && <div className="text-xs text-muted-foreground">Selected. Press Ctrl+C to copy.</div>}
    </div>
  )
}

// One row spanning a table, for "nothing here yet".
export function EmptyRow({ colSpan, children }: { colSpan: number; children: ReactNode }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-3 py-10 text-center text-sm text-muted-foreground">
        {children}
      </td>
    </tr>
  )
}

// "Dheeraj Veerlapati" -> "DV", for avatars.
export function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]?.toUpperCase()).join('') || '?'
}

// Turns any thrown error into a message for the page.
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.'
}
