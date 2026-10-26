import { CheckCircle2, KeyRound, Trash2, UserPlus } from 'lucide-react'
import { type FormEvent, useEffect, useState } from 'react'
import { api, type Server, type TeamMember } from '../api'
import { useMe } from '../session'
import { CopyBox, ErrorText, Page, PageHeader, formatTime, initials, messageOf } from '../ui'
import { KeyList } from './Keys'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox, Input, NativeSelect } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

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

  useEffect(() => {
    load()
  }, [])

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

  const keysOf = members.find(m => m.id === openKeysFor)

  return (
    <Page>
      <PageHeader
        title="Team"
        description="Invite people, set their role, and choose which servers each person may use. The owner always has every server."
      />
      <div className="space-y-6">
        <InviteForm onInvited={load} />
        <ErrorText error={error} />

        <Card className="gap-0 py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-5">Member</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Servers</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Joined</TableHead>
                <TableHead className="pr-5" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.map(m => (
                <TableRow key={m.id} className="align-top">
                  <TableCell className="pl-5">
                    <div className="flex items-center gap-3">
                      <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-secondary text-xs font-medium">
                        {initials(m.name)}
                      </div>
                      <div className="min-w-0">
                        <div className="font-medium">
                          {m.name}
                          {m.id === me.id && <span className="ml-1.5 text-xs font-normal text-muted-foreground">(you)</span>}
                        </div>
                        <div className="truncate text-xs text-muted-foreground">{m.email}</div>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    {m.owner ? (
                      <Badge variant="secondary">Owner</Badge>
                    ) : (
                      <NativeSelect className="w-28" value={m.role} onChange={e => changeRole(m, e.target.value)}>
                        <option value="member">Member</option>
                        <option value="admin">Admin</option>
                      </NativeSelect>
                    )}
                  </TableCell>
                  <TableCell>
                    <ServerAccess
                      member={m}
                      servers={servers}
                      editable={!m.owner && m.id !== me.id}
                      onChange={(all, ids) => setServerAccess(m, all, ids)}
                    />
                  </TableCell>
                  <TableCell>
                    <Badge variant={m.status === 'active' ? 'success' : 'warning'} className="capitalize">
                      {m.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs whitespace-nowrap text-muted-foreground">{formatTime(m.created_at)}</TableCell>
                  <TableCell className="pr-5">
                    <div className="flex justify-end gap-1">
                      {m.status === 'active' && (
                        <Button
                          variant={openKeysFor === m.id ? 'secondary' : 'ghost'}
                          size="sm"
                          onClick={() => setOpenKeysFor(openKeysFor === m.id ? null : m.id)}
                        >
                          <KeyRound /> Keys
                        </Button>
                      )}
                      {m.id !== me.id && !m.owner && (
                        <Button variant="ghost-destructive" size="icon-sm" onClick={() => remove(m)} title="Remove">
                          <Trash2 />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>

        {keysOf && <KeyList userId={keysOf.id} title={`API keys of ${keysOf.name}`} />}
      </div>
    </Page>
  )
}

// "All servers", or a tick per server. Only servers the admin has are listed.
function ServerAccess({
  member,
  servers,
  editable,
  onChange,
}: {
  member: TeamMember
  servers: Server[]
  editable: boolean
  onChange: (allServers: boolean, serverIds: number[]) => void
}) {
  const names = (ids: number[]) => ids.map(id => servers.find(s => s.id === id)?.name ?? `#${id}`)

  if (member.owner) return <span className="text-xs text-muted-foreground">All servers</span>
  if (!editable) {
    return member.all_servers ? (
      <span className="text-xs text-muted-foreground">All servers</span>
    ) : (
      <div className="flex flex-wrap gap-1">
        {names(member.server_ids).map(n => (
          <Badge key={n} variant="outline" className="font-mono">
            {n}
          </Badge>
        ))}
        {member.server_ids.length === 0 && <span className="text-xs text-muted-foreground">None</span>}
      </div>
    )
  }

  const toggle = (id: number, on: boolean) =>
    onChange(false, on ? [...member.server_ids, id] : member.server_ids.filter(x => x !== id))
  return (
    <div className="space-y-1.5 text-sm">
      <label className="flex items-center gap-2">
        <Checkbox
          checked={member.all_servers}
          onChange={e => onChange(e.target.checked, e.target.checked ? [] : servers.map(s => s.id))}
        />
        All servers
      </label>
      {!member.all_servers &&
        servers.map(s => (
          <label key={s.id} className="flex items-center gap-2 pl-6 font-mono text-xs">
            <Checkbox checked={member.server_ids.includes(s.id)} onChange={e => toggle(s.id, e.target.checked)} />
            {s.name}
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
    <Card>
      <CardHeader>
        <CardTitle>Invite someone</CardTitle>
        <CardDescription>They get a one-time link, valid for 7 days, to set their password.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form className="flex flex-wrap gap-2" onSubmit={submit}>
          <Input className="min-w-48 flex-1" type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="Email" required />
          <Input className="min-w-40 flex-1" value={name} onChange={e => setName(e.target.value)} placeholder="Name" required />
          <NativeSelect className="w-32" value={role} onChange={e => setRole(e.target.value)}>
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </NativeSelect>
          <Button type="submit">
            <UserPlus /> Invite
          </Button>
        </form>
        <ErrorText error={error} />
        {inviteUrl && (
          <div className="space-y-3 rounded-lg border border-success/30 bg-success/5 p-4">
            <p className="flex items-center gap-2 text-sm font-medium">
              <CheckCircle2 className="size-4 text-success" /> Invite created. Send this link; it will not be shown again.
            </p>
            <CopyBox label="Invite link" value={inviteUrl} />
          </div>
        )}
      </CardContent>
    </Card>
  )
}
