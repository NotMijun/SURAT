import { FormEvent, useEffect, useState } from 'react'
import { apiGet, apiPost } from '../../lib/api'
import type { Me, MutasiEntry } from '../../types'
import { fmtTime, toIsoLocal, toYmd } from '../../lib/time'
import { useToast } from '../../components/ToastHost'

export default function MutasiPage({ me }: { me: Me }) {
  const toast = useToast()
  const today = toYmd(new Date())
  const [q, setQ] = useState('')
  const [items, setItems] = useState<MutasiEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  const [kind, setKind] = useState('Kejadian khusus')
  const [time, setTime] = useState('08:00')
  const [desc, setDesc] = useState('')

  const refresh = async () => {
    setLoading(true)
    try {
      const res = await apiGet<{ items: MutasiEntry[] }>(`/api/mutasi?q=${encodeURIComponent(q)}`)
      setItems(res.items || [])
    } catch (err: any) {
      toast.push(String(err?.message || err || 'Gagal memuat mutasi'), 'error')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    const t = window.setTimeout(() => refresh().catch(() => {}), 250)
    return () => window.clearTimeout(t)
  }, [q])

  useEffect(() => {
    refresh().catch(() => {})
  }, [])

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    try {
      await apiPost('/api/mutasi', { kind, occurred_at: toIsoLocal(today, time), description: desc })
      setDesc('')
      toast.push('Mutasi dicatat', 'success')
      await refresh()
    } catch (err: any) {
      toast.push(String(err?.message || err || 'Gagal menyimpan'), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="section">
      <div className="section-header">
        <h2 className="h2">Buku Mutasi</h2>
        <div className="section-actions">
          <input className="input input-sm" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Cari kejadian..." />
          <button className="button button-secondary button-sm" type="button" onClick={() => refresh()}>
            Refresh
          </button>
        </div>
      </div>

      <section className="card">
        <header className="card-header">
          <div className="card-title">Catat kejadian</div>
          <div className="muted">Petugas: {me.user.display_name}</div>
        </header>
        <div className="card-body">
          <form className="form grid grid-3" onSubmit={onSubmit}>
            <div className="field">
              <label className="label">Jenis</label>
              <select className="select" value={kind} onChange={(e) => setKind(e.target.value)}>
                <option>Kejadian khusus</option>
                <option>Ronda</option>
                <option>Katering</option>
                <option>Komplain</option>
                <option>Lainnya</option>
              </select>
            </div>
            <div className="field">
              <label className="label">Jam</label>
              <input className="input" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
            </div>
            <div className="field grid-span-3">
              <label className="label">Deskripsi</label>
              <input className="input" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Ringkasan kejadian" required />
            </div>
            <div className="row row-right grid-span-3">
              <button className="button button-primary" type="submit" disabled={busy}>
                {busy ? 'Menyimpan...' : 'Simpan'}
              </button>
            </div>
          </form>
        </div>
      </section>

      <section className="card">
        <header className="card-header">
          <div className="card-title">Daftar mutasi</div>
          <div className="muted">{loading ? 'Memuat...' : `${items.length} entri`}</div>
        </header>
        <div className="card-body">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Jam</th>
                  <th>Jenis</th>
                  <th>Deskripsi</th>
                  <th>Petugas</th>
                </tr>
              </thead>
              <tbody>
                {items.map((r) => (
                  <tr key={r.id}>
                    <td>{fmtTime(r.occurred_at)}</td>
                    <td>{r.kind}</td>
                    <td>{r.description}</td>
                    <td>{r.created_by_name || '-'}</td>
                  </tr>
                ))}
                {items.length === 0 && (
                  <tr>
                    <td className="muted" colSpan={4}>
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

