import { Loader2 } from 'lucide-react'
import { type FormEvent, useEffect, useState } from 'react'
import { useParams } from 'react-router'
import { api, type Me } from '../api'
import { ErrorText, messageOf } from '../ui'
import { AuthLayout } from './Login'
import { Button } from '@/components/ui/button'
import { Input, Label } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/misc'

// The page behind an invite link: greet the person, let them pick a password.
export default function AcceptInvite() {
  const { token } = useParams()
  const [invitee, setInvitee] = useState<Me | null>(null)
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api<Me>(`/api/auth/invites/${token}`).then(setInvitee).catch(e => setError(messageOf(e)))
  }, [token])

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    try {
      await api(`/api/auth/invites/${token}/accept`, { method: 'POST', body: { password } })
      window.location.href = '/keys' // logged in now: next step is getting an API key
    } catch (e) {
      setError(messageOf(e))
      setBusy(false)
    }
  }

  return (
    <AuthLayout
      title="Join the team"
      description={invitee ? `Welcome, ${invitee.name}. Choose a password to finish.` : 'Checking your invite…'}
    >
      {!invitee && !error && <Skeleton className="h-24 w-full" />}
      {invitee && (
        <form className="space-y-4" onSubmit={submit}>
          <Label>
            Email
            <Input value={invitee.email} disabled />
          </Label>
          <Label>
            Password
            <Input
              type="password"
              autoComplete="new-password"
              minLength={8}
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="At least 8 characters"
              required
            />
          </Label>
          <ErrorText error={error} />
          <Button type="submit" className="w-full" disabled={busy}>
            {busy && <Loader2 className="animate-spin" />} Join
          </Button>
        </form>
      )}
      {!invitee && <ErrorText error={error} />}
    </AuthLayout>
  )
}
