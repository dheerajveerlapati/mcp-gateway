import { Search } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api, type AuditRow, type ServerStats } from '../api'
import { useMe } from '../session'
import { EmptyRow, ErrorText, Page, PageHeader, StatusBadge, formatTime, messageOf } from '../ui'
import { Badge } from '@/components/ui/badge'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input, NativeSelect } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { cn } from '@/lib/utils'

const SOURCE_LABEL: Record<string, string> = { chat: 'Chat', api_key: 'API key', oauth: 'OAuth app' }

// Every tool call: who, which server and tool, when, how long, and the outcome.
// Admins see everyone; members see their own calls.
export default function Audit() {
  const me = useMe()
  const [rows, setRows] = useState<AuditRow[]>([])
  const [server, setServer] = useState('')
  const [outcome, setOutcome] = useState('')
  const [userEmail, setUserEmail] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const params = new URLSearchParams()
    if (server) params.set('server', server)
    if (outcome) params.set('outcome', outcome)
    if (userEmail) params.set('user_email', userEmail)

    async function load() {
      try {
        setRows(await api<AuditRow[]>(`/api/audit?${params}`))
        setError(null)
      } catch (e) {
        setError(messageOf(e))
      }
    }
    load()
    const timer = setInterval(load, 5000) // live view while demoing
    return () => clearInterval(timer)
  }, [server, outcome, userEmail])

  return (
    <Page>
      <PageHeader
        title="Audit log"
        description={
          me.role === 'admin'
            ? 'Every tool call by everyone: who, which server and tool, when, how long, and the outcome. Updates live.'
            : 'Every tool call you made, through your keys, apps or the chat. Updates live.'
        }
      />
      <div className="space-y-6">
        {me.role === 'admin' && <ServerStatsCards />}

        <Card className="gap-0 py-0">
          <div className="flex flex-wrap items-center gap-2 border-b p-3">
            <div className="relative min-w-48 flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input className="pl-8" value={server} onChange={e => setServer(e.target.value)} placeholder="Server, e.g. woo" />
            </div>
            {me.role === 'admin' && (
              <Input className="min-w-48 flex-1" value={userEmail} onChange={e => setUserEmail(e.target.value)} placeholder="User email" />
            )}
            <NativeSelect className="w-40" value={outcome} onChange={e => setOutcome(e.target.value)}>
              <option value="">Any outcome</option>
              <option value="ok">Ok</option>
              <option value="error">Error</option>
              <option value="timeout">Timeout</option>
              <option value="denied">Denied</option>
            </NativeSelect>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-5">When</TableHead>
                <TableHead>Who</TableHead>
                <TableHead>Via</TableHead>
                <TableHead>Tool</TableHead>
                <TableHead className="text-right">Duration</TableHead>
                <TableHead>Outcome</TableHead>
                <TableHead className="pr-5">Detail</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(r => (
                <TableRow key={r.id}>
                  <TableCell className="pl-5 text-xs whitespace-nowrap text-muted-foreground">{formatTime(r.created_at)}</TableCell>
                  <TableCell className="text-xs">{r.user_email}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className="font-normal">
                      {SOURCE_LABEL[r.source] ?? r.source}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs whitespace-nowrap">
                    <span className="text-muted-foreground">{r.server_name}__</span>
                    {r.tool_name}
                  </TableCell>
                  <TableCell className="text-right text-xs tabular-nums">{r.duration_ms} ms</TableCell>
                  <TableCell>
                    <StatusBadge status={r.outcome} />
                  </TableCell>
                  <TableCell className="max-w-xs pr-5 text-xs text-muted-foreground">
                    <span className="line-clamp-2" title={r.error ?? undefined}>
                      {r.error}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && <EmptyRow colSpan={7}>No tool calls yet.</EmptyRow>}
            </TableBody>
          </Table>
        </Card>
        <ErrorText error={error} />
      </div>
    </Page>
  )
}

// Calls, error rate and latency per server over the last 24 hours (admins).
function ServerStatsCards() {
  const [stats, setStats] = useState<ServerStats[]>([])

  useEffect(() => {
    const load = () => api<ServerStats[]>('/api/audit/stats').then(setStats).catch(() => setStats([]))
    load()
    const timer = setInterval(load, 10000)
    return () => clearInterval(timer)
  }, [])

  return (
    <Card className="gap-0 pb-0">
      <CardHeader className="pb-4">
        <CardTitle>Last 24 hours by server</CardTitle>
        <CardDescription>Calls, failures and latency, from the audit log.</CardDescription>
      </CardHeader>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="pl-6">Server</TableHead>
            <TableHead className="text-right">Calls</TableHead>
            <TableHead className="text-right">Not ok</TableHead>
            <TableHead className="text-right">Error rate</TableHead>
            <TableHead className="text-right">Avg</TableHead>
            <TableHead className="pr-6 text-right">p95</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {stats.map(s => (
            <TableRow key={s.server_name}>
              <TableCell className="pl-6 font-mono text-xs font-medium">{s.server_name}</TableCell>
              <TableCell className="text-right tabular-nums">{s.calls}</TableCell>
              <TableCell className="text-right tabular-nums">{s.errors}</TableCell>
              <TableCell className={cn('text-right tabular-nums', s.error_rate > 0.1 && 'text-destructive')}>
                {Math.round(s.error_rate * 100)}%
              </TableCell>
              <TableCell className="text-right tabular-nums text-muted-foreground">{s.avg_ms} ms</TableCell>
              <TableCell className="pr-6 text-right tabular-nums text-muted-foreground">{s.p95_ms} ms</TableCell>
            </TableRow>
          ))}
          {stats.length === 0 && <EmptyRow colSpan={6}>No calls yet.</EmptyRow>}
        </TableBody>
      </Table>
    </Card>
  )
}
