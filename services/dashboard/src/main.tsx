import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Route, Routes } from 'react-router'
import App from './App'
import AcceptInvite from './pages/AcceptInvite'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        {/* The invite page works without being logged in. */}
        <Route path="/invite/:token" element={<AcceptInvite />} />
        {/* Everything else needs a login; App takes care of that. */}
        <Route path="/*" element={<App />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
)
