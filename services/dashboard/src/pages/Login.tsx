import { type FormEvent, useState } from 'react'
import { api, type Me } from '../api'
import { ErrorText, messageOf } from '../ui'

export default function Login({ onLogin }: { onLogin: (me: Me) => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    try {
      onLogin(await api<Me>('/api/auth/login', { method: 'POST', body: { email, password } }))
    } catch (e) {
      setError(messageOf(e))
    }
  }

  return (
    <form className="card narrow" onSubmit={submit}>
      <h1>MCP Gateway</h1>
      <label>Email <input type="email" value={email} onChange={e => setEmail(e.target.value)} required /></label>
      <label>Password <input type="password" value={password} onChange={e => setPassword(e.target.value)} required /></label>
      <ErrorText error={error} />
      <button type="submit">Log in</button>
    </form>
  )
}
