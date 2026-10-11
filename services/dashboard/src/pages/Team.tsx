import { type FormEvent, useEffect, useState } from 'react'
import { api, type TeamMember } from '../api'
import { useMe } from '../session'
import { CopyBox, ErrorText, formatTime, messageOf } from '../ui'
import { KeyList } from './Keys'

// Admins only: invite people, change roles, remove people, manage their keys.
export default function Team() {
  const me = useMe()
  const [members, setMembers] = useState<TeamMember[]>([])
  const [error, setError] = useState<string | null>(null)
  const [openKeysFor, setOpenKeysFor] = useState<number | null>(null)

  async function load() {
    try {
      setMembers(await api<TeamMember[]>('/api/users'))
    } catch (e) {
      setError(messageOf(e))
    }
  }

  useEffect(() => { load() }, [])

  async function run(action: () => Promise<unknown>) {
    setError(null)
    try {
      await action()
      await load()
    } catch (e) {
      setError(messageOf(e))
    }
  }

  const changeRole = (m: TeamMember, role: string) =>
    run(() => api(`/api/users/${m.id}`, { method: 'PATCH', body: { role } }))
  const remove = (m: TeamMember) => {
    if (confirm(`Remove ${m.email}? Their API keys stop working.`)) {
      run(() => api(`/api/users/${m.id}`, { method: 'DELETE' }))
    }
  }

  return (
    <>
      <h1>Team</h1>
      <InviteForm onInvited={load} />
      <ErrorText error={error} />
      <section className="card">
        <table>
          <thead>
            <tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Joined</th><th /></tr>
          </thead>
          <tbody>
            {members.map(m => (
              <tr key={m.id}>
                <td>{m.name}{m.id === me.id && ' (you)'}</td>
                <td>{m.email}</td>
                <td>
                  <select value={m.role} onChange={e => changeRole(m, e.target.value)}>
                    <option value="member">member</option>
                    <option value="admin">admin</option>
                  </select>
                </td>
                <td>{m.status}</td>
                <td>{formatTime(m.created_at)}</td>
                <td className="row">
                  {m.status === 'active' && (
                    <button className="secondary" onClick={() => setOpenKeysFor(openKeysFor === m.id ? null : m.id)}>
                      Keys
                    </button>
                  )}
                  {m.id !== me.id && <button className="danger" onClick={() => remove(m)}>Remove</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {openKeysFor && (
        <>
          <h2>Keys of {members.find(m => m.id === openKeysFor)?.email}</h2>
          <KeyList userId={openKeysFor} />
        </>
      )}
    </>
  )
}

function InviteForm({ onInvited }: { onInvited: () => void }) {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [role, setRole] = useState('member')
  const [inviteUrl, setInviteUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    try {
      const result = await api<{ invite_url: string }>('/api/users', { method: 'POST', body: { email, name, role } })
      setInviteUrl(result.invite_url)
      setEmail('')
      setName('')
      onInvited()
    } catch (e) {
      setError(messageOf(e))
    }
  }

  return (
    <section className="card">
      <h2>Invite someone</h2>
      <form className="row" onSubmit={submit}>
        <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="email" required />
        <input value={name} onChange={e => setName(e.target.value)} placeholder="name" required />
        <select value={role} onChange={e => setRole(e.target.value)}>
          <option value="member">member</option>
          <option value="admin">admin</option>
        </select>
        <button type="submit">Invite</button>
      </form>
      <ErrorText error={error} />
      {inviteUrl && (
        <div className="notice">
          <p>Send this one-time link to them (valid 7 days). It will not be shown again.</p>
          <CopyBox label="Invite link" value={inviteUrl} />
        </div>
      )}
    </section>
  )
}
