import { ChevronsUpDown, KeyRound, LogOut, MessageSquare, ScrollText, Server, UserRound, Users, Waypoints } from 'lucide-react'
import { useEffect, useState } from 'react'
import { NavLink, Navigate, Route, Routes, useNavigate } from 'react-router'
import { api, type Me } from './api'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import Account from './pages/Account'
import Audit from './pages/Audit'
import AuthorizeApp from './pages/AuthorizeApp'
import Chat from './pages/Chat'
import Keys from './pages/Keys'
import Login from './pages/Login'
import Servers from './pages/Servers'
import Team from './pages/Team'
import { MeContext } from './session'
import { initials } from './ui'

// Checks who is logged in, then shows either the login page or the dashboard.
export default function App() {
  const [me, setMe] = useState<Me | null>(null)
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    api<Me>('/api/auth/me')
      .then(setMe)
      .catch(() => setMe(null)) // 401: not logged in
      .finally(() => setChecking(false))
  }, [])

  async function logout() {
    await api('/api/auth/logout', { method: 'POST' })
    setMe(null)
  }

  if (checking) return null
  if (!me) return <Login onLogin={setMe} />

  const nav = [
    { to: '/chat', label: 'Chat', icon: MessageSquare },
    { to: '/', label: 'Servers', icon: Server, end: true },
    ...(me.role === 'admin' ? [{ to: '/team', label: 'Team', icon: Users }] : []),
    { to: '/keys', label: 'API keys', icon: KeyRound },
    { to: '/audit', label: 'Audit log', icon: ScrollText },
  ]

  return (
    <MeContext.Provider value={me}>
      <div className="flex h-dvh flex-col md:flex-row">
        {/* Sidebar on wide screens, a top bar on narrow ones. */}
        <aside className="flex shrink-0 flex-col border-b bg-sidebar md:w-60 md:border-r md:border-b-0">
          <div className="flex h-14 items-center gap-2.5 px-4">
            <div className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <Waypoints className="size-4" />
            </div>
            <div className="leading-tight">
              <div className="text-sm font-semibold">MCP Gateway</div>
              <div className="text-xs text-muted-foreground">Team workspace</div>
            </div>
            <div className="ml-auto md:hidden">
              <UserMenu me={me} onLogout={logout} compact />
            </div>
          </div>
          <nav className="flex gap-1 overflow-x-auto px-3 pb-2 md:flex-1 md:flex-col md:overflow-visible md:pt-2">
            {nav.map(item => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm whitespace-nowrap text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
                    isActive && 'bg-accent font-medium text-foreground',
                  )
                }
              >
                <item.icon className="size-4" />
                {item.label}
              </NavLink>
            ))}
          </nav>
          <div className="hidden p-3 md:block">
            <UserMenu me={me} onLogout={logout} />
          </div>
        </aside>

        <main className="min-h-0 flex-1 overflow-y-auto">
          <Routes>
            <Route path="/" element={<Servers />} />
            <Route path="/chat" element={<Chat />} />
            {me.role === 'admin' && <Route path="/team" element={<Team />} />}
            <Route path="/keys" element={<Keys />} />
            <Route path="/audit" element={<Audit />} />
            <Route path="/account" element={<Account />} />
            <Route path="/authorize-app" element={<AuthorizeApp />} />
            <Route path="*" element={<Navigate to="/" />} />
          </Routes>
        </main>
      </div>
    </MeContext.Provider>
  )
}

function UserMenu({ me, onLogout, compact = false }: { me: Me; onLogout: () => void; compact?: boolean }) {
  const navigate = useNavigate()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex w-full items-center gap-2.5 rounded-md p-2 text-left outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-secondary text-xs font-medium">
          {initials(me.name)}
        </div>
        {!compact && (
          <>
            <div className="min-w-0 flex-1 leading-tight">
              <div className="truncate text-sm font-medium">{me.name}</div>
              <div className="truncate text-xs text-muted-foreground capitalize">{me.role}</div>
            </div>
            <ChevronsUpDown className="size-4 text-muted-foreground" />
          </>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent side={compact ? 'bottom' : 'top'} align={compact ? 'end' : 'start'} className="w-56">
        <DropdownMenuLabel>
          <div className="font-medium">{me.name}</div>
          <div className="truncate text-xs font-normal text-muted-foreground">{me.email}</div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate('/account')}>
          <UserRound /> Account
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onLogout}>
          <LogOut /> Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
