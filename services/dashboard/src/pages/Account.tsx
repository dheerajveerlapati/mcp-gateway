import { type FormEvent, useState } from 'react'
import { api } from '../api'
import { useMe } from '../session'
import { ErrorText, messageOf } from '../ui'

// Your account: change your password.
export default function Account() {
  const me = useMe()
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    setSaved(false)
    try {
      await api('/api/auth/password', {
        method: 'POST',
        body: { current_password: currentPassword, new_password: newPassword },
      })
      setSaved(true)
      setCurrentPassword('')
      setNewPassword('')
    } catch (e) {
      setError(messageOf(e))
    }
  }

  return (
    <>
      <h1>Account</h1>
      <form className="card narrow-left" onSubmit={submit}>
        <p className="muted">{me.name} · {me.email} · {me.role}</p>
        <h2>Change password</h2>
        <label>Current password
          <input type="password" value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} required />
        </label>
        <label>New password (8+ characters)
          <input type="password" minLength={8} value={newPassword} onChange={e => setNewPassword(e.target.value)} required />
        </label>
        <ErrorText error={error} />
        {saved && <p>Password changed.</p>}
        <button type="submit">Change password</button>
      </form>
    </>
  )
}
