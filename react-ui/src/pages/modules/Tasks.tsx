import { FormEvent, useCallback, useEffect, useState } from 'react'
import { apiGet, apiPost } from '../../lib/api'
import type { Me, TaskEntry } from '../../types'
import { fmtTime, toIsoLocal, toYmd } from '../../lib/time'
import { useToast } from '../../components/ToastHost'

export default function TasksPage({ me }: { me: Me }) {
  const toast = useToast()
  const today = toYmd(new Date())
  const [q, setQ] = useState('')
  const [items, setItems] = useState<TaskEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  const [kind, setKind] = useState('Antar sampel')
  const [time, setTime] = useState('08:00')
  const [destination, setDestination] = useState('')
  const [notes, setNotes] = useState('')

  const refresh = useCallback(async (query: string) => {
    setLoading(true)
    try {
      const res = await apiGet<{ items: TaskEntry[] }>(`/api/tasks?q=${encodeURIComponent(query)}`)
      setItems(res.items || [])
    } catch (err: any) {
      toast.push(String(err?.message || err || 'Gagal memuat tugas'), 'error')
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
      await apiPost('/api/tasks', {
        kind,
        occurred_at: toIsoLocal(today, time),
        destination,
        notes,
      })
      setDestination('')
      setNotes('')
      toast.push('Tugas dicatat', 'success')
      await refresh(q)
    } catch (err: any) {
      toast.push(String(err?.message || err || 'Gagal menyimpan'), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="section">
      <div className="section-header">
        <h2 className="h2">Tugas Operasional Security</h2>
        <div className="section-actions">
          <input className="input input-sm" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Cari tugas..." />
          <button className="button button-secondary button-sm" type="button" onClick={() => refresh(q)}>
            Refresh
          </button>
        </div>
      </div>

      <section className="card">
        <header className="card-header">
          <div className="card-title">Catat tugas</div>
          <div className="muted">Petugas: {me.user.display_name}</div>
        </header>
        <div className="card-body">
          <form className="form grid grid-4" onSubmit={onSubmit}>
            <div className="field">
              <label className="label">Jenis tugas</label>
              <select className="select" value={kind} onChange={(e) => setKind(e.target.value)}>
                <option>Antar sampel</option>
                <option>Antar surat</option>
                <option>Pom catering</option>
                <option>Galon</option>
                <option>Antar berkas</option>
                <option>Lainnya</option>
              </select>
            </div>
            <div className="field">
              <label className="label">Jam</label>
              <input className="input" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
            </div>
            <div className="field">
              <label className="label">Tujuan</label>
              <input className="input" value={destination} onChange={(e) => setDestination(e.target.value)} placeholder="mis. Lab / Poli" required />
            </div>
            <div className="field">
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

      <section className="card">
        <header className="card-header">
          <div className="card-title">Daftar tugas</div>
          <div className="muted">{loading ? 'Memuat...' : `${items.length} entri`}</div>
        </header>
        <div className="card-body">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Jam</th>
                  <th>Jenis</th>
                  <th>Tujuan</th>
                  <th>Catatan</th>
                  <th>Petugas</th>
                </tr>
              </thead>
              <tbody>
                {items.map((r) => (
                  <tr key={r.id}>
                    <td>{fmtTime(r.occurred_at)}</td>
                    <td>{r.kind}</td>
                    <td>{r.destination}</td>
                    <td>{r.notes}</td>
                    <td>{r.created_by_name || '-'}</td>
                  </tr>
                ))}
                {items.length === 0 && (
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
    </section>
  )
}
