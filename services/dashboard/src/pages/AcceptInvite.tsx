import { type FormEvent, useEffect, useState } from 'react'
import { useParams } from 'react-router'
import { api, type Me } from '../api'
import { ErrorText, messageOf } from '../ui'

// The page behind an invite link: greet the person, let them pick a password.
export default function AcceptInvite() {
  const { token } = useParams()
  const [invitee, setInvitee] = useState<Me | null>(null)
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api<Me>(`/api/auth/invites/${token}`).then(setInvitee).catch(e => setError(messageOf(e)))
  }, [token])

  async function submit(event: FormEvent) {
    event.preventDefault()
    try {
      await api(`/api/auth/invites/${token}/accept`, { method: 'POST', body: { password } })
      window.location.href = '/keys' // logged in now: next step is getting an API key
    } catch (e) {
      setError(messageOf(e))
    }
  }

  return (
    <form className="card narrow" onSubmit={submit}>
      <h1>Join the team</h1>
      {invitee && <p>Welcome, {invitee.name} ({invitee.email}). Choose a password to finish.</p>}
      {invitee && (
        <label>Password (8+ characters)
          <input type="password" minLength={8} value={password} onChange={e => setPassword(e.target.value)} required />
        </label>
      )}
      <ErrorText error={error} />
      {invitee && <button type="submit">Join</button>}
    </form>
  )
}
