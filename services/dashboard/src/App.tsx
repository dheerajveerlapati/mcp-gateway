import { useEffect, useState } from 'react'
import { NavLink, Navigate, Route, Routes } from 'react-router'
import { api, type Me } from './api'
import Account from './pages/Account'
import Audit from './pages/Audit'
import AuthorizeApp from './pages/AuthorizeApp'
import Chat from './pages/Chat'
import Keys from './pages/Keys'
import Login from './pages/Login'
import Servers from './pages/Servers'
import Team from './pages/Team'
import { MeContext } from './session'

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

  return (
    <MeContext.Provider value={me}>
      <header className="topbar">
        <strong>MCP Gateway</strong>
        <nav>
          <NavLink to="/chat">Chat</NavLink>
          <NavLink to="/" end>Servers</NavLink>
          {me.role === 'admin' && <NavLink to="/team">Team</NavLink>}
          <NavLink to="/keys">API keys</NavLink>
          <NavLink to="/audit">Audit log</NavLink>
        </nav>
        <span className="muted">
          <NavLink to="/account">{me.name}</NavLink> ({me.role}){' '}
          <button className="link" onClick={logout}>Log out</button>
        </span>
      </header>
      <main>
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
    </MeContext.Provider>
  )
}
