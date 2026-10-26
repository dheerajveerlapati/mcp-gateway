import { Loader2, Waypoints } from 'lucide-react'
import { type FormEvent, type ReactNode, useState } from 'react'
import { api, type Me } from '../api'
import { ErrorText, messageOf } from '../ui'
import { Button } from '@/components/ui/button'
import { Input, Label } from '@/components/ui/input'

export default function Login({ onLogin }: { onLogin: (me: Me) => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      onLogin(await api<Me>('/api/auth/login', { method: 'POST', body: { email, password } }))
    } catch (e) {
      setError(messageOf(e))
      setBusy(false)
    }
  }

  return (
    <AuthLayout title="Sign in to MCP Gateway" description="One endpoint for all of your team's MCP servers.">
      <form className="space-y-4" onSubmit={submit}>
        <Label>
          Email
          <Input type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} required />
        </Label>
        <Label>
          Password
          <Input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
          />
        </Label>
        <ErrorText error={error} />
        <Button type="submit" className="w-full" disabled={busy}>
          {busy && <Loader2 className="animate-spin" />} Sign in
        </Button>
      </form>
    </AuthLayout>
  )
}

// Centered card used by the pages a person sees before or outside the app.
export function AuthLayout({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-muted/40 px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="flex size-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Waypoints className="size-5" />
          </div>
          <h1 className="mt-4 text-xl font-semibold tracking-tight">{title}</h1>
          {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
        </div>
        <div className="rounded-xl border bg-card p-6 shadow-sm">{children}</div>
      </div>
    </div>
  )
}
