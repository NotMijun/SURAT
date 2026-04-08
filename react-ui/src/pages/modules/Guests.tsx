import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { apiGet, apiPost, apiPostForm } from '../../lib/api'
import type { GuestEntry, Me } from '../../types'
import { fmtTime, nowHm, shiftHm, toIsoLocal, toYmd } from '../../lib/time'
import { useToast } from '../../components/ToastHost'

export default function GuestsPage({ me }: { me: Me }) {
  const toast = useToast()
  const today = useMemo(() => toYmd(new Date()), [])
  const [q, setQ] = useState('')
  const [status, setStatus] = useState<'in' | 'out'>('in')
  const [date, setDate] = useState(today)
  const [sort, setSort] = useState<'checkin_desc' | 'checkin_asc'>('checkin_desc')
  const [limit, setLimit] = useState(200)
  const [loading, setLoading] = useState(true)
  const [items, setItems] = useState<GuestEntry[]>([])

  const [name, setName] = useState('')
  const [instansi, setInstansi] = useState('')
  const [purpose, setPurpose] = useState('')
  const [meet, setMeet] = useState('')
  const [time, setTime] = useState(nowHm())
  const [notes, setNotes] = useState('')
  const [photo, setPhoto] = useState<File | null>(null)
  const [photoKey, setPhotoKey] = useState(0)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async (opts: { q: string; status: string; date: string; sort: string; limit: number }) => {
    const { q, status, date, sort, limit } = opts
    setLoading(true)
    try {
      const res = await apiGet<{ items: GuestEntry[] }>(
        `/api/guests?status=${encodeURIComponent(status)}&q=${encodeURIComponent(q)}&date=${encodeURIComponent(date)}&sort=${encodeURIComponent(sort)}&limit=${encodeURIComponent(String(limit))}`,
      )
      setItems(res.items || [])
    } catch (err: any) {
      toast.push(String(err?.message || err || 'Gagal memuat tamu'), 'error')
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    const t = window.setTimeout(() => refresh({ q, status, date, sort, limit }).catch(() => {}), 250)
    return () => window.clearTimeout(t)
  }, [date, limit, q, refresh, sort, status])

  useEffect(() => {
    refresh({ q: '', status: 'in', date: today, sort: 'checkin_desc', limit: 200 }).catch(() => {})
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
        form.set('name', name)
        form.set('instansi', instansi)
        form.set('purpose', purpose)
        form.set('meet_person', meet)
        form.set('checkin_at', toIsoLocal(today, time))
        form.set('notes', notes)
        form.set('photo', photo)
        await apiPostForm('/api/guests_with_photo', form)
      } else {
        await apiPost('/api/guests', { name, instansi, purpose, meet_person: meet, checkin_at: toIsoLocal(today, time), notes })
      }
      setName('')
      setInstansi('')
      setPurpose('')
      setMeet('')
      setNotes('')
      setPhoto(null)
      setPhotoKey((x) => x + 1)
      toast.push('Tamu masuk dicatat', 'success')
      await refresh({ q, status, date, sort, limit })
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
      await refresh({ q, status, date, sort, limit })
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
          <select className="select select-sm" value={status} onChange={(e) => setStatus(e.target.value as any)}>
            <option value="in">Masih di dalam</option>
            <option value="out">Sudah keluar</option>
          </select>
          <input className="input input-sm" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <select className="select select-sm" value={sort} onChange={(e) => setSort(e.target.value as any)}>
            <option value="checkin_desc">Masuk terbaru</option>
            <option value="checkin_asc">Masuk terlama</option>
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
          <button className="button button-secondary button-sm" type="button" onClick={() => refresh({ q, status, date, sort, limit })}>
            Refresh
          </button>
          <button
            className="button button-secondary button-sm"
            type="button"
            onClick={() =>
              downloadCsv(
                `tamu-${status}-${date || 'semua'}.csv`,
                [['Nama', 'Instansi', 'Tujuan', 'Ditemui', 'Masuk', 'Keluar', 'Catatan', 'Foto', 'Petugas', 'Status']].concat(
                  items.map((r) => [
                    r.name,
                    r.instansi,
                    r.purpose,
                    r.meet_person,
                    fmtTime(r.checkin_at),
                    fmtTime(r.checkout_at),
                    r.notes || '',
                    r.has_photo ? 'Ya' : 'Tidak',
                    r.created_by_name || '-',
                    r.status,
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

      <section className="card" id="guestsForm">
        <header className="card-header">
          <div className="card-title">Tamu masuk</div>
          <div className="muted">Petugas: {me.user.display_name}</div>
        </header>
        <div className="card-body">
          <form className="form grid grid-4" onSubmit={onSubmit}>
            <div className="field">
              <label className="label" htmlFor="guestName">
                Nama
              </label>
              <input className="input" id="guestName" value={name} onChange={(e) => setName(e.target.value)} placeholder="Nama tamu" />
            </div>
            <div className="field">
              <label className="label" htmlFor="guestInstansi">
                Instansi
              </label>
              <input className="input" id="guestInstansi" value={instansi} onChange={(e) => setInstansi(e.target.value)} placeholder="mis. Vendor" />
            </div>
            <div className="field">
              <label className="label" htmlFor="guestPurpose">
                Tujuan
              </label>
              <input className="input" id="guestPurpose" value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="mis. IT / HRD" />
            </div>
            <div className="field">
              <label className="label" htmlFor="guestTime">
                Jam masuk
              </label>
              <input className="input" id="guestTime" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
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
            <div className="field grid-span-4">
              <label className="label" htmlFor="guestMeet">
                Orang yang ditemui
              </label>
              <input className="input" id="guestMeet" value={meet} onChange={(e) => setMeet(e.target.value)} placeholder="Nama staf/unit" />
            </div>
            <div className="field grid-span-4">
              <label className="label" htmlFor="guestNotes">
                Catatan
              </label>
              <input className="input" id="guestNotes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="opsional" />
            </div>
            <div className="field grid-span-4">
              <label className="label" htmlFor="guestPhoto">
                Foto (opsional)
              </label>
              <input
                key={photoKey}
                className="input"
                id="guestPhoto"
                type="file"
                accept="image/*"
                onChange={(e) => setPhoto(e.target.files?.[0] || null)}
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
          <div className="card-title">{status === 'in' ? 'Daftar tamu (masih di dalam)' : 'Daftar tamu (sudah keluar)'}</div>
          <div className="muted">{loading ? 'Memuat...' : `${items.length} entri`}</div>
        </header>
        <div className="card-body">
          <div className="table-wrap">
            <table className="table table-mobile-cards">
              <thead>
                <tr>
                  <th>Nama</th>
                  <th>Instansi</th>
                  <th>Tujuan</th>
                  <th>Ditemui</th>
                  <th>Masuk</th>
                  <th>Foto</th>
                  <th>{status === 'in' ? 'Aksi' : 'Keluar'}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((r) => (
                  <tr key={r.id}>
                    <td data-label="Nama">{r.name}</td>
                    <td data-label="Instansi">{r.instansi}</td>
                    <td data-label="Tujuan">{r.purpose}</td>
                    <td data-label="Ditemui">{r.meet_person}</td>
                    <td data-label="Masuk">{fmtTime(r.checkin_at)}</td>
                    <td data-label="Foto">
                      {r.has_photo && r.photo_url ? (
                        <a className="button button-sm button-secondary" href={r.photo_url} target="_blank" rel="noreferrer">
                          Foto
                        </a>
                      ) : (
                        <span className="muted">-</span>
                      )}
                    </td>
                    <td data-label={status === 'in' ? 'Aksi' : 'Keluar'}>
                      {status === 'in' ? (
                        <button className="button button-sm" type="button" onClick={() => checkout(r.id)}>
                          Keluar
                        </button>
                      ) : (
                        <span className="muted">{fmtTime(r.checkout_at)}</span>
                      )}
                    </td>
                  </tr>
                ))}
                {items.length === 0 && (
                  <tr>
                    <td className="muted" colSpan={7}>
                      Tidak ada data.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <button className="fab" type="button" onClick={() => document.getElementById('guestsForm')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
        + Tamu
      </button>
    </section>
  )
}
