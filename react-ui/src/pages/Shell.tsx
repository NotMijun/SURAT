import { useEffect, useMemo, useState } from 'react'
import { Navigate, NavLink, Route, Routes, useNavigate } from 'react-router-dom'
import { apiGet, apiPost } from '../lib/api'
import { clearToken, compactKey, themeKey, tokenKey } from '../lib/storage'
import type { Me } from '../types'
import { useConfirm, useToast } from '../components/ToastHost'
import LoadingScreen from '../components/LoadingScreen'
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
  const confirm = useConfirm()
  const token = useMemo(() => localStorage.getItem(tokenKey) || '', [])
  const [me, setMe] = useState<Me | null>(null)
  const [loading, setLoading] = useState(true)
  const [navCounts, setNavCounts] = useState<{ keysOpen: number | null; guestsIn: number | null }>({ keysOpen: null, guestsIn: null })
  const [theme, setTheme] = useState<'light' | 'dark'>(localStorage.getItem(themeKey) === 'light' ? 'light' : 'dark')
  const [compact] = useState(localStorage.getItem(compactKey) === 'true')
  const [menuOpen, setMenuOpen] = useState(false)
  const [themeAnimKey, setThemeAnimKey] = useState(0)

  useEffect(() => {
    const root = document.documentElement
    root.dataset.focus = 'pointer'
    const onKeyDown = (e: KeyboardEvent) => {
      const k = e.key || ''
      if (k === 'Tab' || k.startsWith('Arrow')) root.dataset.focus = 'keyboard'
    }
    const onPointerDown = () => {
      root.dataset.focus = 'pointer'
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    window.addEventListener('pointerdown', onPointerDown, { capture: true })
    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true } as any)
      window.removeEventListener('pointerdown', onPointerDown, { capture: true } as any)
    }
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem(themeKey, theme)
  }, [theme])

  const toggleTheme = () => {
    const root = document.documentElement
    root.classList.add('theme-transition')
    setTheme((t) => (t === 'light' ? 'dark' : 'light'))
    setThemeAnimKey((x) => x + 1)
  }

  useEffect(() => {
    if (!themeAnimKey) return
    const root = document.documentElement
    const t = window.setTimeout(() => root.classList.remove('theme-transition'), 220)
    return () => {
      window.clearTimeout(t)
      root.classList.remove('theme-transition')
    }
  }, [themeAnimKey])

  useEffect(() => {
    document.documentElement.dataset.compact = compact ? 'true' : 'false'
    localStorage.setItem(compactKey, String(compact))
  }, [compact])

  useEffect(() => {
    document.documentElement.dataset.accent = 'bsh'
  }, [])

  useEffect(() => {
    const handleAuthError = () => {
      toast.push('Sesi telah berakhir, silakan login kembali', 'error')
      clearToken()
      nav('/login', { replace: true })
    }
    window.addEventListener('auth:unauthorized', handleAuthError)
    return () => window.removeEventListener('auth:unauthorized', handleAuthError)
  }, [nav, toast])

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

  useEffect(() => {
    if (loading) return
    const t = window.setTimeout(() => {
      const el = document.activeElement
      if (!el || el === document.body) return
      if (!(el instanceof HTMLElement)) return
      const tag = el.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (el.isContentEditable) return
      el.blur()
    }, 0)
    return () => window.clearTimeout(t)
  }, [loading])

  useEffect(() => {
    if (loading) return
    if (!me) return
    let cancelled = false
    const load = async () => {
      try {
        const h = await apiGet<{ open_keys_count?: number; guests_in_count?: number }>('/api/handover')
        if (cancelled) return
        const keysOpen = typeof h.open_keys_count === 'number' ? h.open_keys_count : null
        const guestsIn = typeof h.guests_in_count === 'number' ? h.guests_in_count : null
        setNavCounts({ keysOpen, guestsIn })
      } catch {
        if (cancelled) return
        setNavCounts({ keysOpen: null, guestsIn: null })
      }
    }
    load()
    const t = window.setInterval(load, 60_000)
    const onFocus = () => load()
    window.addEventListener('focus', onFocus)
    return () => {
      cancelled = true
      window.clearInterval(t)
      window.removeEventListener('focus', onFocus)
    }
  }, [loading, me])

  const logout = async () => {
    try {
      await apiPost('/api/logout', {})
    } finally {
      clearToken()
      nav('/login', { replace: true })
    }
  }

  const logoutAll = async () => {
    const ok = await confirm.confirm({ title: 'Keluar Semua', message: 'Keluar dari semua perangkat?', confirmText: 'Keluar Semua' })
    if (!ok) return
    try {
      await apiPost('/api/logout_all', {})
    } finally {
      clearToken()
      nav('/login', { replace: true })
    }
  }

  const sessionLabel = useMemo(() => {
    const ttl = me?.session_ttl_seconds
    if (!ttl || !Number.isFinite(ttl)) return ''
    const mins = Math.round(ttl / 60)
    if (mins < 60) return `${mins} menit`
    const h = Math.floor(mins / 60)
    const m = mins % 60
    return m ? `${h}j ${m}m` : `${h} jam`
  }, [me?.session_ttl_seconds])

  const sessionExpiresLabel = useMemo(() => {
    const iso = me?.session_expires_at_iso
    if (!iso) return ''
    const d = new Date(iso)
    if (isNaN(d.getTime())) return iso
    return new Intl.DateTimeFormat('id-ID', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(d)
  }, [me?.session_expires_at_iso])

  if (!token) return <Navigate to="/login" replace />

  return (
    <div className="shell">
      {loading && <LoadingScreen mode="overlay" label="Loading..." />}
      <div className="topbar">
        <div className="topbar-left">
          <div className="brand">
            <div className="brand-mark">
              <img src="/api/brand/logo.png" alt="BSH" />
            </div>
            <div className="topbar-title">
              <div className="title">Logbook Security RS</div>
            </div>
          </div>
        </div>
        <div className="topbar-right">
          <div className="pill">{me ? `Shift: ${me.shift} · Pos: ${me.post}` : 'Shift: -'}</div>
          <div className="pill pill-muted">{me ? `Petugas: ${me.user.display_name}` : 'Petugas: -'}</div>
          {me && sessionLabel && (
            <div className="pill pill-muted" title={sessionExpiresLabel ? `Perkiraan berakhir: ${sessionExpiresLabel}` : undefined}>
              Sesi: {sessionLabel}
            </div>
          )}
          <button className="button button-secondary button-sm topbar-menu" type="button" onClick={() => setMenuOpen(true)}>
            ⋯
          </button>
          <button className="button button-secondary button-sm topbar-action" type="button" onClick={toggleTheme}>
            {theme === 'light' ? 'Mode: Terang' : 'Mode: Gelap'}
          </button>
          <button className="button button-ghost topbar-logout" type="button" onClick={logoutAll}>
            Keluar Semua
          </button>
          <button className="button button-ghost topbar-logout" type="button" onClick={logout}>
            Keluar
          </button>
        </div>
      </div>
      {menuOpen && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Menu" onClick={(e) => (e.currentTarget === e.target ? setMenuOpen(false) : null)}>
          <div className="modal">
            <div className="modal-header">
              <div className="modal-title">Menu</div>
              <button className="button button-secondary button-sm" type="button" onClick={() => setMenuOpen(false)}>
                Tutup
              </button>
            </div>
            <div className="modal-body">
              <div className="row" style={{ flexWrap: 'wrap' }}>
                <button className="button button-secondary" type="button" onClick={toggleTheme}>
                  {theme === 'light' ? 'Mode: Terang' : 'Mode: Gelap'}
                </button>
              </div>
              <div className="row" style={{ marginTop: 10, flexWrap: 'wrap' }}>
                <button className="button button-secondary" type="button" onClick={() => logoutAll().finally(() => setMenuOpen(false))}>
                  Keluar Semua
                </button>
                <button className="button button-danger" type="button" onClick={() => logout().finally(() => setMenuOpen(false))}>
                  Keluar
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="tabsbar">
        <div className="tabs">
          <NavLink className={tabClass} to="/">
            Dashboard
          </NavLink>
          <NavLink className={tabClass} to="/kunci">
            Kunci
            {typeof navCounts.keysOpen === 'number' && navCounts.keysOpen > 0 && <span className="tab-count">{navCounts.keysOpen > 99 ? '99+' : String(navCounts.keysOpen)}</span>}
          </NavLink>
          <NavLink className={tabClass} to="/tamu">
            Tamu
            {typeof navCounts.guestsIn === 'number' && navCounts.guestsIn > 0 && <span className="tab-count">{navCounts.guestsIn > 99 ? '99+' : String(navCounts.guestsIn)}</span>}
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
