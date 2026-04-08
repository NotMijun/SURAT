import { FormEvent, useCallback, useEffect, useState } from 'react'
import { apiGet, apiGetBlob, apiPost, apiPostForm } from '../../lib/api'
import type { Me, TaskEntry } from '../../types'
import { fmtTime, nowHm, shiftHm, toIsoLocal, toYmd } from '../../lib/time'
import { useToast } from '../../components/ToastHost'

export default function TasksPage({ me }: { me: Me }) {
  const toast = useToast()
  const today = toYmd(new Date())
  const [q, setQ] = useState('')
  const [date, setDate] = useState(today)
  const [sort, setSort] = useState<'occurred_desc' | 'occurred_asc'>('occurred_desc')
  const [limit, setLimit] = useState(200)
  const [items, setItems] = useState<TaskEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  const [kind, setKind] = useState('Antar sampel')
  const [time, setTime] = useState(nowHm())
  const [destination, setDestination] = useState('')
  const [notes, setNotes] = useState('')
  const [photo, setPhoto] = useState<File | null>(null)
  const [photoKey, setPhotoKey] = useState(0)
  const [photoView, setPhotoView] = useState<string | null>(null)

  const refresh = useCallback(async (opts: { q: string; date: string; sort: string; limit: number }) => {
    const { q, date, sort, limit } = opts
    setLoading(true)
    try {
      const res = await apiGet<{ items: TaskEntry[] }>(
        `/api/tasks?q=${encodeURIComponent(q)}&date=${encodeURIComponent(date)}&sort=${encodeURIComponent(sort)}&limit=${encodeURIComponent(String(limit))}`,
      )
      setItems(res.items || [])
    } catch (err: any) {
      toast.push(String(err?.message || err || 'Gagal memuat tugas'), 'error')
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    const t = window.setTimeout(() => refresh({ q, date, sort, limit }).catch(() => {}), 250)
    return () => window.clearTimeout(t)
  }, [date, limit, q, refresh, sort])

  useEffect(() => {
    refresh({ q: '', date: today, sort: 'occurred_desc', limit: 200 }).catch(() => {})
  }, [refresh, today])

  const downloadCsv = (filename: string, rows: Array<Array<string | number>>) => {
    const lines = rows.map((r) => r.map((x) => `"${String(x ?? '').replace(/"/g, '""')}"`).join(','))
    const csv = `\ufeff${lines.join('\n')}`
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 500)
  }

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    try {
      if (photo) {
        const form = new FormData()
        form.set('kind', kind)
        form.set('occurred_at', toIsoLocal(today, time))
        form.set('destination', destination)
        form.set('notes', notes)
        form.set('photo', photo)
        await apiPostForm('/api/tasks_with_photo', form)
      } else {
        await apiPost('/api/tasks', { kind, occurred_at: toIsoLocal(today, time), destination, notes })
      }
      setDestination('')
      setNotes('')
      setPhoto(null)
      setPhotoKey((x) => x + 1)
      toast.push('Tugas dicatat', 'success')
      await refresh({ q, date, sort, limit })
    } catch (err: any) {
      toast.push(String(err?.message || err || 'Gagal menyimpan'), 'error')
    } finally {
      setBusy(false)
    }
  }

  const closePhoto = () => {
    if (photoView) URL.revokeObjectURL(photoView)
    setPhotoView(null)
  }

  const openPhoto = async (url: string) => {
    try {
      const blob = await apiGetBlob(url)
      if (photoView) URL.revokeObjectURL(photoView)
      setPhotoView(URL.createObjectURL(blob))
    } catch (err: any) {
      toast.push(String(err?.message || err || 'Gagal memuat foto'), 'error')
    }
  }

  return (
    <section className="section">
      <div className="section-header">
        <h2 className="h2">Tugas Operasional Security</h2>
        <div className="section-actions">
          <input className="input input-sm" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Cari tugas..." />
          <input className="input input-sm" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <select className="select select-sm" value={sort} onChange={(e) => setSort(e.target.value as any)}>
            <option value="occurred_desc">Terbaru</option>
            <option value="occurred_asc">Terlama</option>
          </select>
          <select className="select select-sm" value={limit} onChange={(e) => setLimit(parseInt(e.target.value, 10))}>
            <option value={50}>50</option>
            <option value={200}>200</option>
            <option value={500}>500</option>
          </select>
          <button className="button button-secondary button-sm" type="button" onClick={() => setDate(today)}>
            Hari ini
          </button>
          <button className="button button-secondary button-sm" type="button" onClick={() => setDate('')}>
            Semua
          </button>
          <button className="button button-secondary button-sm" type="button" onClick={() => refresh({ q, date, sort, limit })}>
            Refresh
          </button>
          <button
            className="button button-secondary button-sm"
            type="button"
            onClick={() =>
              downloadCsv(
                `tugas-${date || 'semua'}.csv`,
                [['Jam', 'Jenis', 'Tujuan', 'Catatan', 'Foto', 'Petugas', 'Shift', 'Pos']].concat(
                  items.map((r) => [
                    fmtTime(r.occurred_at),
                    r.kind,
                    r.destination,
                    r.notes || '',
                    r.has_photo ? 'Ya' : 'Tidak',
                    r.created_by_name || '-',
                    r.shift || '-',
                    r.post || '-',
                  ]),
                ),
              )
            }
          >
            Export CSV
          </button>
          <button className="button button-secondary button-sm" type="button" onClick={() => window.print()}>
            Cetak
          </button>
        </div>
      </div>

      <section className="card" id="tasksForm">
        <header className="card-header">
          <div className="card-title">Catat tugas</div>
          <div className="muted">Petugas: {me.user.display_name}</div>
        </header>
        <div className="card-body">
          <form className="form grid grid-4" onSubmit={onSubmit}>
            <div className="field">
              <label className="label" htmlFor="taskKind">
                Jenis tugas
              </label>
              <select className="select" id="taskKind" value={kind} onChange={(e) => setKind(e.target.value)}>
                <option>Antar sampel</option>
                <option>Antar surat</option>
                <option>Pom catering</option>
                <option>Galon</option>
                <option>Antar berkas</option>
                <option>Lainnya</option>
              </select>
            </div>
            <div className="field">
              <label className="label" htmlFor="taskTime">
                Jam
              </label>
              <input className="input" id="taskTime" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
              <div className="chips">
                <button className="chip" type="button" onClick={() => setTime(shiftHm(time, -5))}>
                  -5m
                </button>
                <button className="chip" type="button" onClick={() => setTime(nowHm())}>
                  Sekarang
                </button>
                <button className="chip" type="button" onClick={() => setTime(shiftHm(time, 5))}>
                  +5m
                </button>
              </div>
            </div>
            <div className="field">
              <label className="label" htmlFor="taskDestination">
                Tujuan
              </label>
              <input className="input" id="taskDestination" value={destination} onChange={(e) => setDestination(e.target.value)} placeholder="mis. Lab / Poli" required />
            </div>
            <div className="field">
              <label className="label" htmlFor="taskNotes">
                Catatan
              </label>
              <input className="input" id="taskNotes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="opsional" />
            </div>
            <div className="field grid-span-4">
              <label className="label" htmlFor="taskPhoto">
                Foto (opsional)
              </label>
              <input
                key={photoKey}
                className="input"
                id="taskPhoto"
                type="file"
                accept="image/*"
                capture="environment"
                onChange={(e) => {
                  const f = e.target.files?.[0] || null
                  if (f && !String(f.type || '').toLowerCase().startsWith('image/')) {
                    toast.push('File foto harus gambar', 'error')
                    setPhoto(null)
                    setPhotoKey((x) => x + 1)
                    return
                  }
                  if (f && f.size > 3 * 1024 * 1024) {
                    toast.push('Ukuran foto maksimal 3MB', 'error')
                    setPhoto(null)
                    setPhotoKey((x) => x + 1)
                    return
                  }
                  setPhoto(f)
                }}
              />
              <div className="muted">{photo ? `Dipilih: ${photo.name}` : 'Tidak ada foto'}</div>
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
            <table className="table table-mobile-cards">
              <thead>
                <tr>
                  <th>Jam</th>
                  <th>Jenis</th>
                  <th>Tujuan</th>
                  <th>Catatan</th>
                  <th>Foto</th>
                  <th>Petugas</th>
                </tr>
              </thead>
              <tbody>
                {items.map((r) => (
                  <tr key={r.id}>
                    <td data-label="Jam">{fmtTime(r.occurred_at)}</td>
                    <td data-label="Jenis">{r.kind}</td>
                    <td data-label="Tujuan">{r.destination}</td>
                    <td data-label="Catatan">{r.notes}</td>
                    <td data-label="Foto">
                      {r.has_photo && r.photo_url ? (
                        <button className="button button-sm button-secondary" type="button" onClick={() => openPhoto(r.photo_url!)}>
                          Foto
                        </button>
                      ) : (
                        <span className="muted">-</span>
                      )}
                    </td>
                    <td data-label="Petugas">{r.created_by_name || '-'}</td>
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

      {photoView && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Foto" onClick={(e) => e.currentTarget === e.target && closePhoto()}>
          <div className="modal">
            <div className="modal-header">
              <div className="modal-title">Foto</div>
              <button className="button button-secondary button-sm" type="button" onClick={closePhoto}>
                Tutup
              </button>
            </div>
            <div className="modal-body">
              <img className="modal-photo" src={photoView} alt="Foto" />
            </div>
          </div>
        </div>
      )}

      <button className="fab" type="button" onClick={() => document.getElementById('tasksForm')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
        + Tugas
      </button>
    </section>
  )
}
