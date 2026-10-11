// Small pieces shared by several pages.
import { type MouseEvent, useState } from 'react'

export function ErrorText({ error }: { error: string | null }) {
  return error ? <p className="error">{error}</p> : null
}

export function StatusBadge({ status }: { status: string }) {
  return <span className={`badge badge-${status}`}>{status}</span>
}

export function formatTime(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : '—'
}

// Text the user must copy (an API key, an invite link). Shown once.
export function CopyBox({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState('Copy')

  async function copy(event: MouseEvent<HTMLButtonElement>) {
    // The clipboard API only exists on https:// or localhost pages. On plain
    // http (local *.localtest.me) we select the text for Ctrl+C instead.
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(value)
      setCopied('Copied')
    } else {
      const code = event.currentTarget.previousElementSibling as HTMLElement
      window.getSelection()?.selectAllChildren(code)
      setCopied('Press Ctrl+C')
    }
  }

  return (
    <div className="copy-box">
      <div className="muted">{label}</div>
      <code>{value}</code>
      <button type="button" onClick={copy}>{copied}</button>
    </div>
  )
}

// Turns any thrown error into a message for the page.
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.'
}
