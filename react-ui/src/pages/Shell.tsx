import { useEffect, useMemo, useState } from 'react'
import { Navigate, NavLink, Route, Routes, useNavigate } from 'react-router-dom'
import { apiGet, apiPost } from '../lib/api'
import { clearToken, compactKey, themeKey, tokenKey } from '../lib/storage'
import type { Me } from '../types'
import { useToast } from '../components/ToastHost'
import DashboardPage from './modules/Dashboard'
import KeysPage from './modules/Keys'
import GuestsPage from './modules/Guests'
import TasksPage from './modules/Tasks'
import MutasiPage from './modules/Mutasi'
import AdminPage from './modules/Admin'

const tabClass = ({ isActive }: { isActive: boolean }) => `tab${isActive ? ' tab-active' : ''}`

export default function Shell() {
  const nav = useNavigate()
  const toast = useToast()
  const token = useMemo(() => localStorage.getItem(tokenKey) || '', [])
  const [me, setMe] = useState<Me | null>(null)
  const [loading, setLoading] = useState(true)
  const [theme, setTheme] = useState<'light' | 'dark'>(localStorage.getItem(themeKey) === 'light' ? 'light' : 'dark')
  const [compact, setCompact] = useState(localStorage.getItem(compactKey) === 'true')

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem(themeKey, theme)
  }, [theme])

  useEffect(() => {
    document.documentElement.dataset.compact = compact ? 'true' : 'false'
    localStorage.setItem(compactKey, String(compact))
  }, [compact])

  useEffect(() => {
    if (!token) return
    let cancelled = false
    setLoading(true)
    apiGet<Me>('/api/me')
      .then((x) => {
        if (cancelled) return
        setMe(x)
      })
      .catch((err: any) => {
        if (cancelled) return
        const msg = String(err?.message || err || '')
        if (/harus login/i.test(msg) || err?.status === 401) {
          clearToken()
          nav('/login', { replace: true })
          return
        }
        toast.push(msg || 'Gagal memuat sesi', 'error')
      })
      .finally(() => {
        if (cancelled) return
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [nav, toast, token])

  if (!token) return <Navigate to="/login" replace />

  const logout = async () => {
    try {
      await apiPost('/api/logout', {})
    } finally {
      clearToken()
      nav('/login', { replace: true })
    }
  }

  return (
    <div className="shell">
      <div className="topbar">
        <div className="topbar-left">
          <div className="brand">
            <div className="brand-mark">LB</div>
            <div className="topbar-title">
              <div className="title">Logbook Security RS</div>
            </div>
          </div>
        </div>
        <div className="topbar-right">
          <div className="pill">{me ? `Shift: ${me.shift} · Pos: ${me.post}` : 'Shift: -'}</div>
          <div className="pill pill-muted">{me ? `Petugas: ${me.user.display_name}` : 'Petugas: -'}</div>
          <button className="button button-secondary button-sm topbar-action" type="button" onClick={() => setTheme((t) => (t === 'light' ? 'dark' : 'light'))}>
            {theme === 'light' ? 'Mode: Terang' : 'Mode: Gelap'}
          </button>
          <button className="button button-secondary button-sm topbar-action topbar-compact-toggle" type="button" onClick={() => setCompact((x) => !x)}>
            {compact ? 'Ringkas: On' : 'Ringkas: Off'}
          </button>
          <button className="button button-ghost" type="button" onClick={logout}>
            Keluar
          </button>
        </div>
      </div>

      <div className="tabsbar">
        <div className="tabs">
          <NavLink className={tabClass} to="/">
            Dashboard
          </NavLink>
          <NavLink className={tabClass} to="/kunci">
            Kunci
          </NavLink>
          <NavLink className={tabClass} to="/tamu">
            Tamu
          </NavLink>
          <NavLink className={tabClass} to="/tugas">
            Tugas
          </NavLink>
          <NavLink className={tabClass} to="/mutasi">
            Mutasi
          </NavLink>
          {me?.user.role === 'admin' && (
            <NavLink className={tabClass} to="/admin">
              Admin
            </NavLink>
          )}
        </div>
      </div>

      <main className="content" id="main">
        {loading && (
          <div className="card">
            <div className="card-body">
              <span className="shimmer shimmer-inline" />
            </div>
          </div>
        )}
        {!loading && (
          <Routes>
            <Route path="/" element={<DashboardPage me={me!} />} />
            <Route path="/kunci" element={<KeysPage me={me!} />} />
            <Route path="/tamu" element={<GuestsPage me={me!} />} />
            <Route path="/tugas" element={<TasksPage me={me!} />} />
            <Route path="/mutasi" element={<MutasiPage me={me!} />} />
            <Route path="/admin" element={me?.user.role === 'admin' ? <AdminPage me={me!} /> : <Navigate to="/" replace />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        )}
      </main>
    </div>
  )
}
