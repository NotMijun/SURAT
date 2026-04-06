import { FormEvent, useCallback, useEffect, useState } from 'react'
import { apiGet, apiPost } from '../../lib/api'
import type { GuestEntry, Me } from '../../types'
import { fmtTime, toIsoLocal, toYmd } from '../../lib/time'
import { useToast } from '../../components/ToastHost'

export default function GuestsPage({ me }: { me: Me }) {
  const toast = useToast()
  const today = toYmd(new Date())
  const [q, setQ] = useState('')
  const [loading, setLoading] = useState(true)
  const [items, setItems] = useState<GuestEntry[]>([])

  const [name, setName] = useState('')
  const [instansi, setInstansi] = useState('')
  const [purpose, setPurpose] = useState('')
  const [meet, setMeet] = useState('')
  const [time, setTime] = useState('08:00')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async (query: string) => {
    setLoading(true)
    try {
      const res = await apiGet<{ items: GuestEntry[] }>(`/api/guests?status=in&q=${encodeURIComponent(query)}`)
      setItems(res.items || [])
    } catch (err: any) {
      toast.push(String(err?.message || err || 'Gagal memuat tamu'), 'error')
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
      await apiPost('/api/guests', { name, instansi, purpose, meet_person: meet, checkin_at: toIsoLocal(today, time), notes })
      setName('')
      setInstansi('')
      setPurpose('')
      setMeet('')
      setNotes('')
      toast.push('Tamu masuk dicatat', 'success')
      await refresh(q)
    } catch (err: any) {
      toast.push(String(err?.message || err || 'Gagal menyimpan'), 'error')
    } finally {
      setBusy(false)
    }
  }

  const checkout = async (id: number) => {
    try {
      await apiPost(`/api/guests/${id}/checkout`, {})
      toast.push('Tamu checkout', 'success')
      await refresh(q)
    } catch (err: any) {
      toast.push(String(err?.message || err || 'Gagal memproses'), 'error')
    }
  }

  return (
    <section className="section">
      <div className="section-header">
        <h2 className="h2">Buku Tamu</h2>
        <div className="section-actions">
          <input className="input input-sm" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Cari tamu / instansi..." />
          <button className="button button-secondary button-sm" type="button" onClick={() => refresh(q)}>
            Refresh
          </button>
        </div>
      </div>

      <section className="card">
        <header className="card-header">
          <div className="card-title">Tamu masuk</div>
          <div className="muted">Petugas: {me.user.display_name}</div>
        </header>
        <div className="card-body">
          <form className="form grid grid-4" onSubmit={onSubmit}>
            <div className="field">
              <label className="label">Nama</label>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Nama tamu" />
            </div>
            <div className="field">
              <label className="label">Instansi</label>
              <input className="input" value={instansi} onChange={(e) => setInstansi(e.target.value)} placeholder="mis. Vendor" />
            </div>
            <div className="field">
              <label className="label">Tujuan</label>
              <input className="input" value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="mis. IT / HRD" />
            </div>
            <div className="field">
              <label className="label">Jam masuk</label>
              <input className="input" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
            </div>
            <div className="field grid-span-4">
              <label className="label">Orang yang ditemui</label>
              <input className="input" value={meet} onChange={(e) => setMeet(e.target.value)} placeholder="Nama staf/unit" />
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

      <section className="card">
        <header className="card-header">
          <div className="card-title">Daftar tamu (masih di dalam)</div>
          <div className="muted">{loading ? 'Memuat...' : `${items.length} entri`}</div>
        </header>
        <div className="card-body">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Nama</th>
                  <th>Instansi</th>
                  <th>Tujuan</th>
                  <th>Ditemui</th>
                  <th>Masuk</th>
                  <th>Aksi</th>
                </tr>
              </thead>
              <tbody>
                {items.map((r) => (
                  <tr key={r.id}>
                    <td>{r.name}</td>
                    <td>{r.instansi}</td>
                    <td>{r.purpose}</td>
                    <td>{r.meet_person}</td>
                    <td>{fmtTime(r.checkin_at)}</td>
                    <td>
                      <button className="button button-sm" type="button" onClick={() => checkout(r.id)}>
                        Keluar
                      </button>
                    </td>
                  </tr>
                ))}
                {items.length === 0 && (
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
    </section>
  )
}
