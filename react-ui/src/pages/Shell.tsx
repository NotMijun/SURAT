import { FormEvent, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Navigate, NavLink, Route, Routes, useNavigate } from 'react-router-dom'
import { apiGet, apiPost } from '../lib/api'
import { clearToken, compactKey, themeKey, tokenKey } from '../lib/storage'
import type { Me } from '../types'
import { useConfirm, useToast } from '../components/ToastHost'
import Modal from '../components/Modal'
import LoadingScreen from '../components/LoadingScreen'

const DashboardPage = lazy(() => import('./modules/Dashboard'))
const KeysPage = lazy(() => import('./modules/Keys'))
const GuestsPage = lazy(() => import('./modules/Guests'))
const TasksPage = lazy(() => import('./modules/Tasks'))
const MutasiPage = lazy(() => import('./modules/Mutasi'))
const PatrolsPage = lazy(() => import('./modules/Patrols'))
const AdminPage = lazy(() => import('./modules/Admin'))

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
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQ, setSearchQ] = useState('')
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchRes, setSearchRes] = useState<{
    keys: Array<{ id: number; key_name?: string; borrower_name?: string; unit?: string; checkout_at?: string; status?: string }>
    guests: Array<{ id: number; name?: string; instansi?: string; purpose?: string; checkin_at?: string; status?: string }>
    tasks: Array<{ id: number; kind?: string; destination?: string; occurred_at?: string; status?: string; created_by_name?: string }>
    mutasi: Array<{ id: number; kind?: string; description?: string; occurred_at?: string; status?: string; created_by_name?: string }>
    patrols: Array<{ id: number; security_name?: string; location?: string; findings?: string; patrol_date?: string; patrol_time?: string; status?: string; created_by_name?: string }>
  }>({ keys: [], guests: [], tasks: [], mutasi: [], patrols: [] })
  const searchReqIdRef = useRef(0)
  const suppressSearchFocusRef = useRef(false)
  const themeTimeoutRef = useRef<number | null>(null)
  const themeRafRef = useRef<number | null>(null)
  const themeLabel = theme === 'light' ? 'Terang' : 'Gelap'

  const openSearch = useCallback(() => {
    setMenuOpen(false)
    setSearchOpen(true)
  }, [])

  const closeSearch = useCallback(() => {
    suppressSearchFocusRef.current = true
    setSearchOpen(false)
  }, [])

  useEffect(() => {
    if (searchOpen) return
    searchReqIdRef.current += 1
    setSearchLoading(false)
    const t = window.setTimeout(() => {
      const el = document.activeElement as HTMLElement | null
      if (!el) return
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || (el as any).isContentEditable) el.blur()
    }, 0)
    return () => window.clearTimeout(t)
  }, [searchOpen])

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
    if (themeTimeoutRef.current) window.clearTimeout(themeTimeoutRef.current)
    if (themeRafRef.current) window.cancelAnimationFrame(themeRafRef.current)
    themeRafRef.current = window.requestAnimationFrame(() => {
      setTheme((t) => (t === 'light' ? 'dark' : 'light'))
      themeRafRef.current = null
    })
    themeTimeoutRef.current = window.setTimeout(() => {
      root.classList.remove('theme-transition')
      themeTimeoutRef.current = null
    }, 1100)
  }

  useEffect(() => {
    const root = document.documentElement
    return () => {
      if (themeTimeoutRef.current) window.clearTimeout(themeTimeoutRef.current)
      if (themeRafRef.current) window.cancelAnimationFrame(themeRafRef.current)
      root.classList.remove('theme-transition')
    }
  }, [])

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
    const onKeyDown = (e: KeyboardEvent) => {
      const key = String(e.key || '')
      const target = e.target as HTMLElement | null
      const tag = target?.tagName || ''
      const typing =
        tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (target && (target as any).isContentEditable) || target?.getAttribute('role') === 'textbox'

      const combo = (e.ctrlKey || e.metaKey) && (key === 'k' || key === 'K')
      if (combo && !typing) {
        e.preventDefault()
        openSearch()
        return
      }
      if (key === '/' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault()
        openSearch()
      }
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true } as any)
  }, [openSearch])

  useEffect(() => {
    if (!searchOpen) return
    const q = searchQ.trim()
    if (q.length < 2) {
      setSearchRes({ keys: [], guests: [], tasks: [], mutasi: [], patrols: [] })
      setSearchLoading(false)
      return
    }
    const t = window.setTimeout(() => {
      const reqId = (searchReqIdRef.current += 1)
      setSearchLoading(true)
      Promise.all([
        apiGet<{ items: any[] }>(
          `/api/keys?status=open&q=${encodeURIComponent(q)}&date=&date_field=checkout&from_hm=&to_hm=&sort=checkout_desc&limit=5&offset=0`,
        ).catch(() => ({ items: [] })),
        apiGet<{ items: any[] }>(`/api/guests?status=in&q=${encodeURIComponent(q)}&date=&sort=checkin_desc&limit=5&post=&offset=0`).catch(() => ({ items: [] })),
        apiGet<{ items: any[] }>(`/api/tasks?q=${encodeURIComponent(q)}&date=&sort=occurred_desc&limit=5&offset=0&status=active&tab=umum`).catch(() => ({ items: [] })),
        apiGet<{ items: any[] }>(`/api/mutasi?q=${encodeURIComponent(q)}&kategori=&sub=&date=&sort=occurred_desc&limit=5&offset=0&status=active`).catch(() => ({ items: [] })),
        apiGet<{ items: any[] }>(`/api/patrols?q=${encodeURIComponent(q)}&date=&sort=date_desc&limit=5&offset=0&status=active`).catch(() => ({ items: [] })),
      ])
        .then(([keys, guests, tasks, mutasi, patrols]) => {
          if (searchReqIdRef.current !== reqId) return
          setSearchRes({
            keys: (keys.items || []) as any,
            guests: (guests.items || []) as any,
            tasks: (tasks.items || []) as any,
            mutasi: (mutasi.items || []) as any,
            patrols: (patrols.items || []) as any,
          })
        })
        .finally(() => {
          if (searchReqIdRef.current !== reqId) return
          setSearchLoading(false)
        })
    }, 220)
    return () => {
      window.clearTimeout(t)
    }
  }, [searchOpen, searchQ])

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
          <NavLink className="brand" to="/" aria-label="Ke Dashboard" style={{ textDecoration: 'none', color: 'inherit' }}>
            <div className="brand-mark">
              <img src="/api/brand/logo.png" alt="BSH" />
            </div>
            <div className="topbar-title">
              <div className="title">Logbook Security RS</div>
            </div>
          </NavLink>
        </div>
        <div className="topbar-center">
          <div className="search topbar-search">
            <span className="search-icon">⌕</span>
            <input
              className="search-input"
              value={searchQ}
              onChange={(e) => {
                setSearchQ(e.target.value)
              }}
              onFocus={() => {
                if (suppressSearchFocusRef.current) {
                  suppressSearchFocusRef.current = false
                  return
                }
                openSearch()
              }}
              placeholder="Cari (Ctrl+K)"
            />
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
          <button className="topbar-search-btn" type="button" onClick={openSearch} aria-haspopup="dialog" aria-expanded={searchOpen}>
            Cari
          </button>
          <button className="button button-secondary button-sm topbar-menu" type="button" onClick={() => setMenuOpen(true)} aria-haspopup="dialog" aria-expanded={menuOpen}>
            ⋯
          </button>
          <button className="button button-secondary button-sm topbar-action theme-toggle" type="button" onClick={toggleTheme} aria-label={`Mode: ${themeLabel}`} title={`Mode: ${themeLabel}`}>
            <span className="theme-toggle-text">Mode:</span>
            <span className="theme-toggle-swap" aria-hidden="true">
              <span className="theme-toggle-icon theme-toggle-icon-sun">☀</span>
              <span className="theme-toggle-icon theme-toggle-icon-moon">☾</span>
            </span>
          </button>
          <button className="button button-ghost topbar-logout" type="button" onClick={logoutAll}>
            Keluar Semua
          </button>
          <button className="button button-ghost topbar-logout" type="button" onClick={logout}>
            Keluar
          </button>
        </div>
      </div>
      <Modal open={menuOpen} ariaLabel="Menu" onClose={() => setMenuOpen(false)}>
        <div className="modal-header">
          <div className="modal-title">Menu</div>
          <button className="button button-secondary button-sm" type="button" onClick={() => setMenuOpen(false)}>
            Tutup
          </button>
        </div>
        <div className="modal-body">
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <button className="button button-secondary theme-toggle" type="button" onClick={toggleTheme} aria-label={`Mode: ${themeLabel}`} title={`Mode: ${themeLabel}`}>
              <span className="theme-toggle-text">Mode:</span>
              <span className="theme-toggle-swap" aria-hidden="true">
                <span className="theme-toggle-icon theme-toggle-icon-sun">☀</span>
                <span className="theme-toggle-icon theme-toggle-icon-moon">☾</span>
              </span>
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
      </Modal>

      <Modal open={searchOpen} ariaLabel="Cari" onClose={closeSearch} variant="sheet">
        <div className="modal-header">
          <div className="modal-title">Cari</div>
          <button className="button button-secondary button-sm" type="button" onClick={closeSearch}>
            Tutup
          </button>
        </div>
        <div className="modal-body">
          <form
            className="row"
            onSubmit={(e: FormEvent) => {
              e.preventDefault()
            }}
            style={{ marginBottom: 10 }}
          >
            <input className="input" data-autofocus="true" value={searchQ} onChange={(e) => setSearchQ(e.target.value)} placeholder="Cari nama, ruangan, tugas, mutasi..." />
          </form>
          {searchQ.trim().length < 2 ? (
            <div className="muted">Ketik minimal 2 karakter.</div>
          ) : searchLoading ? (
            <div className="muted">Mencari...</div>
          ) : (
            <div className="grid" style={{ gap: 10 }}>
              <div>
                <div className="label-sm" style={{ marginBottom: 6 }}>
                  Kunci
                </div>
                {searchRes.keys.length === 0 ? (
                  <div className="muted">Tidak ada hasil.</div>
                ) : (
                  <div className="grid" style={{ gap: 8 }}>
                    {searchRes.keys.map((r) => (
                      <button
                        key={`k-${r.id}`}
                        type="button"
                        className="button button-secondary"
                        style={{ justifyContent: 'space-between', textAlign: 'left' }}
                        onClick={() => {
                          closeSearch()
                          nav(`/kunci?q=${encodeURIComponent(searchQ.trim())}`)
                        }}
                      >
                        <span style={{ display: 'grid' }}>
                          <span style={{ fontWeight: 850 }}>{r.key_name || '-'}</span>
                          <span className="muted" style={{ fontSize: 12 }}>
                            {r.borrower_name ? `${r.borrower_name}${r.unit ? ` · ${r.unit}` : ''}` : '-'}
                          </span>
                        </span>
                        <span className="muted" style={{ fontSize: 12 }}>
                          {r.checkout_at ? String(r.checkout_at).slice(0, 16).replace('T', ' ') : ''}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div>
                <div className="label-sm" style={{ marginBottom: 6 }}>
                  Tamu
                </div>
                {searchRes.guests.length === 0 ? (
                  <div className="muted">Tidak ada hasil.</div>
                ) : (
                  <div className="grid" style={{ gap: 8 }}>
                    {searchRes.guests.map((r) => (
                      <button
                        key={`g-${r.id}`}
                        type="button"
                        className="button button-secondary"
                        style={{ justifyContent: 'space-between', textAlign: 'left' }}
                        onClick={() => {
                          closeSearch()
                          nav(`/tamu?q=${encodeURIComponent(searchQ.trim())}`)
                        }}
                      >
                        <span style={{ display: 'grid' }}>
                          <span style={{ fontWeight: 850 }}>{r.name || '-'}</span>
                          <span className="muted" style={{ fontSize: 12 }}>
                            {r.instansi ? `${r.instansi}${r.purpose ? ` · ${r.purpose}` : ''}` : r.purpose || '-'}
                          </span>
                        </span>
                        <span className="muted" style={{ fontSize: 12 }}>
                          {r.checkin_at ? String(r.checkin_at).slice(0, 16).replace('T', ' ') : ''}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div>
                <div className="label-sm" style={{ marginBottom: 6 }}>
                  Tugas
                </div>
                {searchRes.tasks.length === 0 ? (
                  <div className="muted">Tidak ada hasil.</div>
                ) : (
                  <div className="grid" style={{ gap: 8 }}>
                    {searchRes.tasks.map((r) => (
                      <button
                        key={`t-${r.id}`}
                        type="button"
                        className="button button-secondary"
                        style={{ justifyContent: 'space-between', textAlign: 'left' }}
                        onClick={() => {
                          closeSearch()
                          nav(`/tugas?q=${encodeURIComponent(searchQ.trim())}`)
                        }}
                      >
                        <span style={{ display: 'grid' }}>
                          <span style={{ fontWeight: 850 }}>{r.kind || '-'}</span>
                          <span className="muted" style={{ fontSize: 12 }}>
                            {r.destination || '-'}
                          </span>
                        </span>
                        <span className="muted" style={{ fontSize: 12 }}>
                          {r.occurred_at ? String(r.occurred_at).slice(0, 16).replace('T', ' ') : ''}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div>
                <div className="label-sm" style={{ marginBottom: 6 }}>
                  Mutasi
                </div>
                {searchRes.mutasi.length === 0 ? (
                  <div className="muted">Tidak ada hasil.</div>
                ) : (
                  <div className="grid" style={{ gap: 8 }}>
                    {searchRes.mutasi.map((r) => (
                      <button
                        key={`m-${r.id}`}
                        type="button"
                        className="button button-secondary"
                        style={{ justifyContent: 'space-between', textAlign: 'left' }}
                        onClick={() => {
                          closeSearch()
                          nav(`/mutasi?q=${encodeURIComponent(searchQ.trim())}`)
                        }}
                      >
                        <span style={{ display: 'grid' }}>
                          <span style={{ fontWeight: 850 }}>{r.kind || '-'}</span>
                          <span className="muted" style={{ fontSize: 12 }}>
                            {r.description ? String(r.description).slice(0, 80) : '-'}
                          </span>
                        </span>
                        <span className="muted" style={{ fontSize: 12 }}>
                          {r.occurred_at ? String(r.occurred_at).slice(0, 16).replace('T', ' ') : ''}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div>
                <div className="label-sm" style={{ marginBottom: 6 }}>
                  Patroli
                </div>
                {searchRes.patrols.length === 0 ? (
                  <div className="muted">Tidak ada hasil.</div>
                ) : (
                  <div className="grid" style={{ gap: 8 }}>
                    {searchRes.patrols.map((r) => (
                      <button
                        key={`p-${r.id}`}
                        type="button"
                        className="button button-secondary"
                        style={{ justifyContent: 'space-between', textAlign: 'left' }}
                        onClick={() => {
                          closeSearch()
                          nav(`/patrols?q=${encodeURIComponent(searchQ.trim())}`)
                        }}
                      >
                        <span style={{ display: 'grid' }}>
                          <span style={{ fontWeight: 850 }}>{r.security_name || '-'}</span>
                          <span className="muted" style={{ fontSize: 12 }}>
                            {r.location ? `${r.location} · ${r.findings ? String(r.findings).slice(0, 40) : '-'}` : r.findings || '-'}
                          </span>
                        </span>
                        <span className="muted" style={{ fontSize: 12 }}>
                          {r.patrol_date ? `${r.patrol_date} ${r.patrol_time || ''}` : ''}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </Modal>

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
          <NavLink className={tabClass} to="/patrols">
            Patroli
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
            <Route
              path="/"
              element={
                <Suspense fallback={<LoadingScreen mode="inline" label="Memuat Dashboard..." minHeight={260} />}>
                  <DashboardPage me={me!} />
                </Suspense>
              }
            />
            <Route
              path="/kunci"
              element={
                <Suspense fallback={<LoadingScreen mode="inline" label="Memuat modul Kunci..." minHeight={260} />}>
                  <KeysPage me={me!} />
                </Suspense>
              }
            />
            <Route
              path="/tamu"
              element={
                <Suspense fallback={<LoadingScreen mode="inline" label="Memuat modul Tamu..." minHeight={260} />}>
                  <GuestsPage me={me!} />
                </Suspense>
              }
            />
            <Route
              path="/tugas"
              element={
                <Suspense fallback={<LoadingScreen mode="inline" label="Memuat modul Tugas..." minHeight={260} />}>
                  <TasksPage me={me!} />
                </Suspense>
              }
            />
            <Route
              path="/mutasi"
              element={
                <Suspense fallback={<LoadingScreen mode="inline" label="Memuat modul Mutasi..." minHeight={260} />}>
                  <MutasiPage me={me!} />
                </Suspense>
              }
            />
            <Route
              path="/patrols"
              element={
                <Suspense fallback={<LoadingScreen mode="inline" label="Memuat modul Patroli..." minHeight={260} />}>
                  <PatrolsPage me={me!} />
                </Suspense>
              }
            />
            <Route
              path="/admin"
              element={
                me?.user.role === 'admin' ? (
                  <Suspense fallback={<LoadingScreen mode="inline" label="Memuat modul Admin..." minHeight={260} />}>
                    <AdminPage me={me!} />
                  </Suspense>
                ) : (
                  <Navigate to="/" replace />
                )
              }
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        )}
      </main>
    </div>
  )
}
