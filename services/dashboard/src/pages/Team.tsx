import { type FormEvent, useEffect, useState } from 'react'
import { api, type Server, type TeamMember } from '../api'
import { useMe } from '../session'
import { CopyBox, ErrorText, formatTime, messageOf } from '../ui'
import { KeyList } from './Keys'

// Admins only: invite people, change roles, remove people, manage their keys,
// and choose which servers each person may use.
export default function Team() {
  const me = useMe()
  const [members, setMembers] = useState<TeamMember[]>([])
  // The servers this admin has: the only ones they can give to others.
  const [servers, setServers] = useState<Server[]>([])
  const [error, setError] = useState<string | null>(null)
  const [openKeysFor, setOpenKeysFor] = useState<number | null>(null)

  async function load() {
    try {
      setMembers(await api<TeamMember[]>('/api/users'))
      setServers(await api<Server[]>('/api/servers'))
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
  const setServerAccess = (m: TeamMember, all_servers: boolean, server_ids: number[]) =>
    run(() => api(`/api/users/${m.id}/servers`, { method: 'PUT', body: { all_servers, server_ids } }))
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
            <tr><th>Name</th><th>Email</th><th>Role</th><th>Servers</th><th>Status</th><th>Joined</th><th /></tr>
          </thead>
          <tbody>
            {members.map(m => (
              <tr key={m.id}>
                <td>{m.name}{m.id === me.id && ' (you)'}</td>
                <td>{m.email}</td>
                <td>
                  {m.owner ? 'admin (owner)' : (
                    <select value={m.role} onChange={e => changeRole(m, e.target.value)}>
                      <option value="member">member</option>
                      <option value="admin">admin</option>
                    </select>
                  )}
                </td>
                <td>
                  <ServerAccess member={m} servers={servers} editable={!m.owner && m.id !== me.id}
                                onChange={(all, ids) => setServerAccess(m, all, ids)} />
                </td>
                <td>{m.status}</td>
                <td>{formatTime(m.created_at)}</td>
                <td className="row">
                  {m.status === 'active' && (
                    <button className="secondary" onClick={() => setOpenKeysFor(openKeysFor === m.id ? null : m.id)}>
                      Keys
                    </button>
                  )}
                  {m.id !== me.id && !m.owner && <button className="danger" onClick={() => remove(m)}>Remove</button>}
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

// "All servers", or a tick per server. Only servers the admin has are listed.
function ServerAccess({ member, servers, editable, onChange }: {
  member: TeamMember
  servers: Server[]
  editable: boolean
  onChange: (allServers: boolean, serverIds: number[]) => void
}) {
  if (member.owner) return <span className="muted">all (owner)</span>
  const names = (ids: number[]) =>
    ids.map(id => servers.find(s => s.id === id)?.name ?? `#${id}`).join(', ') || 'none'
  if (!editable) return <span className="muted">{member.all_servers ? 'all' : names(member.server_ids)}</span>

  const toggle = (id: number, on: boolean) =>
    onChange(false, on ? [...member.server_ids, id] : member.server_ids.filter(x => x !== id))
  return (
    <div>
      <label>
        <input type="checkbox" checked={member.all_servers}
               onChange={e => onChange(e.target.checked, e.target.checked ? [] : servers.map(s => s.id))} />
        {' '}all servers
      </label>
      {!member.all_servers && servers.map(s => (
        <label key={s.id} style={{ display: 'block' }}>
          <input type="checkbox" checked={member.server_ids.includes(s.id)}
                 onChange={e => toggle(s.id, e.target.checked)} />
          {' '}{s.name}
        </label>
      ))}
    </div>
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
