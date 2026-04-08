import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { apiGet, apiPost, apiPostForm } from '../../lib/api'
import type { KeyTx, Me } from '../../types'
import { fmtTime, nowHm, shiftHm, toIsoLocal, toYmd } from '../../lib/time'
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
  const [date, setDate] = useState(today)
  const [sort, setSort] = useState<'checkout_desc' | 'checkout_asc'>('checkout_desc')
  const [limit, setLimit] = useState(200)
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState<KeyTx[]>([])
  const [closed, setClosed] = useState<KeyTx[]>([])

  const [borrower, setBorrower] = useState('')
  const [unit, setUnit] = useState('')
  const [keyName, setKeyName] = useState('')
  const [time, setTime] = useState(nowHm())
  const [notes, setNotes] = useState('')
  const [photo, setPhoto] = useState<File | null>(null)
  const [photoKey, setPhotoKey] = useState(0)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async (opts: { q: string; date: string; sort: string; limit: number }) => {
    const { q, date, sort, limit } = opts
    setLoading(true)
    try {
      const [a, b] = await Promise.all([
        apiGet<{ items: KeyTx[] }>(
          `/api/keys?status=open&q=${encodeURIComponent(q)}&date=${encodeURIComponent(date)}&sort=${encodeURIComponent(sort)}&limit=${encodeURIComponent(String(limit))}`,
        ),
        apiGet<{ items: KeyTx[] }>(
          `/api/keys?status=closed&q=${encodeURIComponent(q)}&date=${encodeURIComponent(date)}&sort=${encodeURIComponent(sort)}&limit=${encodeURIComponent(String(limit))}`,
        ),
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
    const t = window.setTimeout(() => refresh({ q, date, sort, limit }).catch(() => {}), 250)
    return () => window.clearTimeout(t)
  }, [date, limit, q, refresh, sort])

  useEffect(() => {
    refresh({ q: '', date: today, sort: 'checkout_desc', limit: 200 }).catch(() => {})
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
      const payload = {
        borrower_name: borrower,
        unit,
        key_name: keyName,
        checkout_at: toIsoLocal(today, time),
        notes,
      }
      try {
        if (photo) {
          const form = new FormData()
          form.set('borrower_name', payload.borrower_name)
          form.set('unit', payload.unit)
          form.set('key_name', payload.key_name)
          form.set('checkout_at', payload.checkout_at)
          form.set('notes', payload.notes)
          form.set('photo', photo)
          await apiPostForm('/api/keys_with_photo', form)
        } else {
          await apiPost('/api/keys', payload)
        }
      } catch (err: any) {
        const msg = String(err?.message || err || '')
        const ok = window.confirm(`${msg}\n\nTetap simpan?`)
        if (!ok) throw err
        if (photo) {
          const form = new FormData()
          form.set('borrower_name', payload.borrower_name)
          form.set('unit', payload.unit)
          form.set('key_name', payload.key_name)
          form.set('checkout_at', payload.checkout_at)
          form.set('notes', payload.notes)
          form.set('force', 'true')
          form.set('photo', photo)
          await apiPostForm('/api/keys_with_photo', form)
        } else {
          await apiPost('/api/keys', { ...payload, force: true })
        }
      }
      setBorrower('')
      setUnit('')
      setKeyName('')
      setNotes('')
      setPhoto(null)
      setPhotoKey((x) => x + 1)
      toast.push('Disimpan', 'success')
      await refresh({ q, date, sort, limit })
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
      await refresh({ q, date, sort, limit })
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
          <input className="input input-sm" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <select className="select select-sm" value={sort} onChange={(e) => setSort(e.target.value as any)}>
            <option value="checkout_desc">Titip terbaru</option>
            <option value="checkout_asc">Titip terlama</option>
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
                `kunci-open-${date || 'semua'}.csv`,
                [['Nama', 'Unit', 'Ruangan/Kunci', 'Jam titip', 'Catatan', 'Foto', 'Petugas', 'Status']].concat(
                  open.map((r) => [
                    String(r.borrower_name || ''),
                    String(r.unit || ''),
                    String(r.key_name || ''),
                    String(fmtTime(r.checkout_at)),
                    String(r.notes || ''),
                    r.has_photo ? 'Ya' : 'Tidak',
                    String(r.created_by_name || '-'),
                    String(r.status || ''),
                  ]),
                ),
              )
            }
          >
            Export Open
          </button>
          <button className="button button-secondary button-sm" type="button" onClick={() => window.print()}>
            Cetak
          </button>
        </div>
      </div>

      <section className="card" id="keysForm">
        <header className="card-header">
          <div className="card-title">Titip kunci</div>
          <div className="muted">Petugas: {me.user.display_name}</div>
        </header>
        <div className="card-body">
          <form className="form grid grid-4" onSubmit={onSubmit}>
            <div className="field">
              <label className="label" htmlFor="keyBorrower">
                Nama penitip
              </label>
              <input className="input" id="keyBorrower" value={borrower} onChange={(e) => setBorrower(e.target.value)} placeholder="Nama penitip" />
            </div>
            <div className="field">
              <label className="label" htmlFor="keyUnit">
                Unit/Divisi
              </label>
              <input className="input" id="keyUnit" value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="mis. Perawat" />
            </div>
            <div className="field">
              <label className="label" htmlFor="keyName">
                Ruangan/Kunci
              </label>
              <input className="input" id="keyName" value={keyName} onChange={(e) => setKeyName(e.target.value)} placeholder="mis. Radiologi" required />
            </div>
            <div className="field">
              <label className="label" htmlFor="keyTime">
                Jam titip
              </label>
              <input className="input" id="keyTime" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
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
              <label className="label" htmlFor="keyNotes">
                Catatan
              </label>
              <input className="input" id="keyNotes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="opsional" />
            </div>
            <div className="field grid-span-4">
              <label className="label" htmlFor="keyPhoto">
                Foto (opsional)
              </label>
              <input
                key={photoKey}
                className="input"
                id="keyPhoto"
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

      <div className="grid grid-2">
        <section className="card">
          <header className="card-header">
            <div className="card-title">Penitipan aktif</div>
            <div className="muted">{loading ? 'Memuat...' : `${open.length} entri`}</div>
          </header>
          <div className="card-body">
            <div className="table-wrap">
              <table className="table table-mobile-cards">
                <thead>
                  <tr>
                    <th>Nama</th>
                    <th>Ruangan</th>
                    <th>Titip</th>
                    <th>Petugas</th>
                    <th>Status</th>
                    <th>Foto</th>
                    <th>Aksi</th>
                  </tr>
                </thead>
                <tbody>
                  {open.map((r) => (
                    <tr key={r.id}>
                      <td data-label="Nama">{r.borrower_name}</td>
                      <td data-label="Ruangan">{r.key_name}</td>
                      <td data-label="Titip">{fmtTime(r.checkout_at)}</td>
                      <td data-label="Petugas">{r.created_by_name || '-'}</td>
                      <td data-label="Status">{badge(r.status)}</td>
                      <td data-label="Foto">
                        {r.has_photo && r.photo_url ? (
                          <a className="button button-sm button-secondary" href={r.photo_url} target="_blank" rel="noreferrer">
                            Foto
                          </a>
                        ) : (
                          <span className="muted">-</span>
                        )}
                      </td>
                      <td data-label="Aksi">
                        <button className="button button-sm" type="button" onClick={() => doReturn(r.id)}>
                          Ambil
                        </button>
                      </td>
                    </tr>
                  ))}
                  {open.length === 0 && (
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

        <section className="card">
          <header className="card-header">
            <div className="card-title">Riwayat (closed)</div>
            <div className="muted">{loading ? 'Memuat...' : `${closed.length} entri`}</div>
          </header>
          <div className="card-body">
            <div className="table-wrap">
              <table className="table table-mobile-cards">
                <thead>
                  <tr>
                    <th>Nama</th>
                    <th>Ruangan</th>
                    <th>Titip</th>
                    <th>Ambil</th>
                    <th>Status</th>
                    <th>Foto</th>
                  </tr>
                </thead>
                <tbody>
                  {closed.slice(0, 120).map((r) => (
                    <tr key={r.id}>
                      <td data-label="Nama">{r.borrower_name}</td>
                      <td data-label="Ruangan">{r.key_name}</td>
                      <td data-label="Titip">{fmtTime(r.checkout_at)}</td>
                      <td data-label="Ambil">{fmtTime(r.checkin_at || '')}</td>
                      <td data-label="Status">{badge(r.status)}</td>
                      <td data-label="Foto">
                        {r.has_photo && r.photo_url ? (
                          <a className="button button-sm button-secondary" href={r.photo_url} target="_blank" rel="noreferrer">
                            Foto
                          </a>
                        ) : (
                          <span className="muted">-</span>
                        )}
                      </td>
                    </tr>
                  ))}
                  {closed.length === 0 && (
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
      </div>

      <button className="fab" type="button" onClick={() => document.getElementById('keysForm')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
        + Titip
      </button>
    </section>
  )
}
