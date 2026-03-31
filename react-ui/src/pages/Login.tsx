import { FormEvent, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiPost } from '../lib/api'
import { setToken, themeKey } from '../lib/storage'
import { useToast } from '../components/ToastHost'

type LoginRes = {
  ok: boolean
  token: string
  user: { id: number; username: string; display_name: string; role: string }
  shift: string
  post: string
}

export default function LoginPage() {
  const nav = useNavigate()
  const toast = useToast()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [shift, setShift] = useState('Pagi')
  const [post, setPost] = useState('IGD')
  const [busy, setBusy] = useState(false)

  const theme = useMemo(() => (localStorage.getItem(themeKey) === 'light' ? 'light' : 'dark'), [])
  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    try {
      const res = await apiPost<LoginRes>('/api/login', { username, password, shift, post })
      if (!res.token) throw new Error('Token tidak valid')
      setToken(res.token)
      nav('/', { replace: true })
    } catch (err: any) {
      toast.push(String(err?.message || err || 'Login gagal'), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page page-center">
      <main className="card card-lg">
        <header className="card-header">
          <div className="brand">
            <div className="brand-mark">LB</div>
            <div className="brand-title">Logbook Security RS</div>
          </div>
        </header>
        <div className="card-body">
          <form className="form" onSubmit={onSubmit}>
            <div className="field">
              <label className="label" htmlFor="username">
                Username
              </label>
              <input className="input" id="username" name="username" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required autoFocus />
            </div>
            <div className="field">
              <label className="label" htmlFor="password">
                Password
              </label>
              <input className="input" id="password" name="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </div>
            <div className="grid grid-2">
              <div className="field">
                <label className="label" htmlFor="shift">
                  Shift
                </label>
                <select className="select" id="shift" name="shift" value={shift} onChange={(e) => setShift(e.target.value)}>
                  <option value="Pagi">Pagi</option>
                  <option value="Sore">Sore</option>
                  <option value="Malam">Malam</option>
                </select>
              </div>
              <div className="field">
                <label className="label" htmlFor="post">
                  Pos
                </label>
                <input className="input" id="post" name="post" value={post} onChange={(e) => setPost(e.target.value)} />
              </div>
            </div>
            <button className="button button-primary" type="submit" disabled={busy}>
              {busy ? 'Masuk...' : 'Masuk'}
            </button>
          </form>
        </div>
      </main>
    </div>
  )
}

