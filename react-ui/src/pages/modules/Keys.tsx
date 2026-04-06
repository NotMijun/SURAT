import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { apiGet, apiPost } from '../../lib/api'
import type { KeyTx, Me } from '../../types'
import { fmtTime, toIsoLocal, toYmd } from '../../lib/time'
import { useToast } from '../../components/ToastHost'

const badge = (s: KeyTx['status']) => {
  if (s === 'closed') return <span className="badge badge-ok">Diambil</span>
  if (s === 'void') return <span className="badge badge-danger">Void</span>
  return <span className="badge badge-warn">Dititipkan</span>
}

export default function KeysPage({ me }: { me: Me }) {
  const toast = useToast()
  const today = useMemo(() => toYmd(new Date()), [])
  const [q, setQ] = useState('')
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState<KeyTx[]>([])
  const [closed, setClosed] = useState<KeyTx[]>([])

  const [borrower, setBorrower] = useState('')
  const [unit, setUnit] = useState('')
  const [keyName, setKeyName] = useState('')
  const [time, setTime] = useState('08:00')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async (query: string) => {
    setLoading(true)
    try {
      const [a, b] = await Promise.all([
        apiGet<{ items: KeyTx[] }>(`/api/keys?status=open&q=${encodeURIComponent(query)}`),
        apiGet<{ items: KeyTx[] }>(`/api/keys?status=closed&q=${encodeURIComponent(query)}`),
      ])
      setOpen(a.items || [])
      setClosed(b.items || [])
    } catch (err: any) {
      toast.push(String(err?.message || err || 'Gagal memuat data kunci'), 'error')
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    const t = window.setTimeout(() => refresh(q).catch(() => {}), 250)
    return () => window.clearTimeout(t)
  }, [q, refresh])

  useEffect(() => {
    refresh('').catch(() => {})
  }, [refresh])

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    try {
      const payload = {
        borrower_name: borrower,
        unit,
        key_name: keyName,
        checkout_at: toIsoLocal(today, time),
        notes,
      }
      try {
        await apiPost('/api/keys', payload)
      } catch (err: any) {
        const msg = String(err?.message || err || '')
        const ok = window.confirm(`${msg}\n\nTetap simpan?`)
        if (!ok) throw err
        await apiPost('/api/keys', { ...payload, force: true })
      }
      setBorrower('')
      setUnit('')
      setKeyName('')
      setNotes('')
      toast.push('Disimpan', 'success')
      await refresh(q)
    } catch (err: any) {
      toast.push(String(err?.message || err || 'Gagal menyimpan'), 'error')
    } finally {
      setBusy(false)
    }
  }

  const doReturn = async (id: number) => {
    try {
      await apiPost(`/api/keys/${id}/return`, {})
      toast.push('Kunci ditandai diambil', 'success')
      await refresh(q)
    } catch (err: any) {
      toast.push(String(err?.message || err || 'Gagal memproses'), 'error')
    }
  }

  return (
    <section className="section">
      <div className="section-header">
        <h2 className="h2">Penitipan Kunci</h2>
        <div className="section-actions">
          <input className="input input-sm" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Cari nama / kunci..." />
          <button className="button button-secondary button-sm" type="button" onClick={() => refresh(q)}>
            Refresh
          </button>
        </div>
      </div>

      <section className="card">
        <header className="card-header">
          <div className="card-title">Titip kunci</div>
          <div className="muted">Petugas: {me.user.display_name}</div>
        </header>
        <div className="card-body">
          <form className="form grid grid-4" onSubmit={onSubmit}>
            <div className="field">
              <label className="label">Nama penitip</label>
              <input className="input" value={borrower} onChange={(e) => setBorrower(e.target.value)} placeholder="Nama penitip" />
            </div>
            <div className="field">
              <label className="label">Unit/Divisi</label>
              <input className="input" value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="mis. Perawat" />
            </div>
            <div className="field">
              <label className="label">Ruangan/Kunci</label>
              <input className="input" value={keyName} onChange={(e) => setKeyName(e.target.value)} placeholder="mis. Radiologi" required />
            </div>
            <div className="field">
              <label className="label">Jam titip</label>
              <input className="input" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
            </div>
            <div className="field grid-span-4">
              <label className="label">Catatan</label>
              <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="opsional" />
            </div>
            <div className="row row-right grid-span-4">
              <button className="button button-primary" type="submit" disabled={busy}>
                {busy ? 'Menyimpan...' : 'Simpan'}
              </button>
            </div>
          </form>
        </div>
      </section>

      <div className="grid grid-2">
        <section className="card">
          <header className="card-header">
            <div className="card-title">Penitipan aktif</div>
            <div className="muted">{loading ? 'Memuat...' : `${open.length} entri`}</div>
          </header>
          <div className="card-body">
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Nama</th>
                    <th>Ruangan</th>
                    <th>Titip</th>
                    <th>Petugas</th>
                    <th>Status</th>
                    <th>Aksi</th>
                  </tr>
                </thead>
                <tbody>
                  {open.map((r) => (
                    <tr key={r.id}>
                      <td>{r.borrower_name}</td>
                      <td>{r.key_name}</td>
                      <td>{fmtTime(r.checkout_at)}</td>
                      <td>{r.created_by_name || '-'}</td>
                      <td>{badge(r.status)}</td>
                      <td>
                        <button className="button button-sm" type="button" onClick={() => doReturn(r.id)}>
                          Ambil
                        </button>
                      </td>
                    </tr>
                  ))}
                  {open.length === 0 && (
                    <tr>
                      <td className="muted" colSpan={6}>
                        Tidak ada data.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section className="card">
          <header className="card-header">
            <div className="card-title">Riwayat (closed)</div>
            <div className="muted">{loading ? 'Memuat...' : `${closed.length} entri`}</div>
          </header>
          <div className="card-body">
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Nama</th>
                    <th>Ruangan</th>
                    <th>Titip</th>
                    <th>Ambil</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {closed.slice(0, 120).map((r) => (
                    <tr key={r.id}>
                      <td>{r.borrower_name}</td>
                      <td>{r.key_name}</td>
                      <td>{fmtTime(r.checkout_at)}</td>
                      <td>{fmtTime(r.checkin_at || '')}</td>
                      <td>{badge(r.status)}</td>
                    </tr>
                  ))}
                  {closed.length === 0 && (
                    <tr>
                      <td className="muted" colSpan={5}>
                        Tidak ada data.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      </div>
    </section>
  )
}
