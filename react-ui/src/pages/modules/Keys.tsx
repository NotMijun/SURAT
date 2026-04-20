import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { apiGet, apiGetBlob, apiPost, apiPostForm } from '../../lib/api'
import type { KeyMasterItem, KeyTx, Me } from '../../types'
import { fmtDateTime, fmtTime, nowHm, shiftHm, toIsoLocal, toYmd } from '../../lib/time'
import { useToast } from '../../components/ToastHost'

const badge = (s: KeyTx['status']) => {
  if (s === 'closed') return <span className="badge badge-ok">Diambil</span>
  if (s === 'void') return <span className="badge badge-danger">Void</span>
  return <span className="badge badge-warn">Dititipkan</span>
}

export default function KeysPage({ me }: { me: Me }) {
  const toast = useToast()
  const today = useMemo(() => toYmd(new Date()), [])
  const draftKey = useMemo(() => `draft:keys:${me.user.id}`, [me.user.id])
  const [q, setQ] = useState('')
  const [date, setDate] = useState(today)
  const [sort, setSort] = useState<'checkout_desc' | 'checkout_asc' | 'checkin_desc' | 'checkin_asc'>('checkout_desc')
  const [limit, setLimit] = useState(200)
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState<KeyTx[]>([])
  const [closed, setClosed] = useState<KeyTx[]>([])
  const [filterBy, setFilterBy] = useState<'titip' | 'ambil'>('titip')
  const [fromHm, setFromHm] = useState('')
  const [toHm, setToHm] = useState('')

  const [borrower, setBorrower] = useState('')
  const [unit, setUnit] = useState('')
  const [keyName, setKeyName] = useState('')
  const [time, setTime] = useState(nowHm())
  const [notes, setNotes] = useState('')
  const [petugasId, setPetugasId] = useState<string>(String(me.user.id))
  const [guards, setGuards] = useState<{id: number, display_name: string}[]>([])
  const [keyMaster, setKeyMaster] = useState<KeyMasterItem[]>([])
  const [photo, setPhoto] = useState<File | null>(null)
  const [photoKey, setPhotoKey] = useState(0)
  const [photoView, setPhotoView] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState<string>('')

  useEffect(() => {
    if (me.user.role === 'admin') {
      apiGet<{items: any[]}>('/api/guards').then(res => setGuards(res.items || [])).catch(() => {})
    }
  }, [me.user.role])

  useEffect(() => {
    apiGet<{ items: KeyMasterItem[] }>('/api/keys/master')
      .then((res) => setKeyMaster(res.items || []))
      .catch(() => setKeyMaster([]))
  }, [])

  const refresh = useCallback(async (opts: { q: string; date: string; sort: string; limit: number; closedDateField?: 'checkout' | 'checkin' }) => {
    const { q, date, sort, limit } = opts
    const closedDateField = opts.closedDateField || 'checkout'
    setLoading(true)
    try {
      const [a, b] = await Promise.all([
        apiGet<{ items: KeyTx[] }>(
          `/api/keys?status=open&q=${encodeURIComponent(q)}&date=${encodeURIComponent(date)}&date_field=checkout&sort=${encodeURIComponent(sort)}&limit=${encodeURIComponent(String(limit))}`,
        ),
        apiGet<{ items: KeyTx[] }>(
          `/api/keys?status=closed&q=${encodeURIComponent(q)}&date=${encodeURIComponent(date)}&date_field=${encodeURIComponent(closedDateField)}&sort=${encodeURIComponent(sort)}&limit=${encodeURIComponent(String(limit))}`,
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
    const t = window.setTimeout(() => {
      const closedDateField = date === today && filterBy === 'ambil' ? 'checkin' : 'checkout'
      refresh({ q, date, sort, limit, closedDateField }).catch(() => {})
    }, 250)
    return () => window.clearTimeout(t)
  }, [date, limit, q, refresh, sort, filterBy, today])

  useEffect(() => {
    refresh({ q: '', date: today, sort: 'checkout_desc', limit: 200, closedDateField: 'checkout' }).catch(() => {})
  }, [refresh, today])

  useEffect(() => {
    const raw = localStorage.getItem(draftKey)
    if (!raw) return
    try {
      const d = JSON.parse(raw)
      if (d && typeof d === 'object') {
        if (typeof d.borrower === 'string') setBorrower(d.borrower)
        if (typeof d.unit === 'string') setUnit(d.unit)
        if (typeof d.keyName === 'string') setKeyName(d.keyName)
        if (typeof d.time === 'string') setTime(d.time || nowHm())
        if (typeof d.notes === 'string') setNotes(d.notes)
        if (typeof d.petugasId === 'string') setPetugasId(d.petugasId)
      }
    } catch {
      localStorage.removeItem(draftKey)
    }
  }, [draftKey])

  useEffect(() => {
    const t = window.setTimeout(() => {
      const payload = { borrower, unit, keyName, time, notes, petugasId }
      localStorage.setItem(draftKey, JSON.stringify(payload))
    }, 300)
    return () => window.clearTimeout(t)
  }, [borrower, draftKey, keyName, notes, petugasId, time, unit])

  const hmToMinutes = (hm: string) => {
    const [h, m] = String(hm || '').split(':', 2)
    const hh = Number(h)
    const mm = Number(m)
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null
    return hh * 60 + mm
  }

  const inTimeWindow = useCallback((iso: string | null | undefined) => {
    if (!iso) return false
    if (date !== today) return true
    const d = new Date(iso)
    if (isNaN(d.getTime())) return true
    const mins = d.getHours() * 60 + d.getMinutes()
    const f = hmToMinutes(fromHm)
    const t = hmToMinutes(toHm)
    if (f == null && t == null) return true
    if (f != null && mins < f) return false
    if (t != null && mins > t) return false
    return true
  }, [date, fromHm, toHm, today])

  const openView = useMemo(() => open.filter((r) => inTimeWindow(r.checkout_at)), [inTimeWindow, open])
  const closedView = useMemo(() => {
    const field = filterBy === 'ambil' ? 'checkin_at' : 'checkout_at'
    return closed.filter((r) => inTimeWindow((r as any)[field]))
  }, [closed, filterBy, inTimeWindow])

  const petugasName = useCallback((r: KeyTx) => String(r.created_by_name || '').trim() || me.user.display_name, [me.user.display_name])

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
      setFormError('')
      const payload = {
        borrower_name: borrower,
        unit,
        key_name: keyName,
        checkout_at: toIsoLocal(today, time),
        notes,
        petugas_id: parseInt(petugasId, 10),
      }
      try {
        if (photo) {
          const form = new FormData()
          form.set('borrower_name', payload.borrower_name)
          form.set('unit', payload.unit)
          form.set('key_name', payload.key_name)
          form.set('checkout_at', payload.checkout_at)
          form.set('notes', payload.notes)
          form.set('petugas_id', String(payload.petugas_id))
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
          form.set('petugas_id', String(payload.petugas_id))
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
      localStorage.removeItem(draftKey)
      toast.push('Disimpan', 'success')
      const closedDateField = date === today && filterBy === 'ambil' ? 'checkin' : 'checkout'
      await refresh({ q, date, sort, limit, closedDateField })
    } catch (err: any) {
      const msg = String(err?.message || err || 'Gagal menyimpan')
      setFormError(msg)
      toast.push(msg, 'error')
    } finally {
      setBusy(false)
    }
  }

  const doReturn = async (r: KeyTx) => {
    const ok = window.confirm(`Tandai kunci sudah diambil?\n\n${r.key_name} · ${r.borrower_name}\nTitip: ${fmtDateTime(r.checkout_at)}\n\nLanjutkan?`)
    if (!ok) return
    try {
      await apiPost(`/api/keys/${r.id}/return`, {})
      toast.push('Kunci ditandai diambil', 'success')
      const closedDateField = date === today && filterBy === 'ambil' ? 'checkin' : 'checkout'
      await refresh({ q, date, sort, limit, closedDateField })
    } catch (err: any) {
      toast.push(String(err?.message || err || 'Gagal memproses'), 'error')
    }
  }

  const doUndo = async (id: number) => {
    const ok = window.confirm('Batalkan penitipan kunci ini?')
    if (!ok) return
    try {
      await apiPost(`/api/keys/${id}/undo`, {})
      toast.push('Penitipan kunci dibatalkan', 'success')
      const closedDateField = date === today && filterBy === 'ambil' ? 'checkin' : 'checkout'
      await refresh({ q, date, sort, limit, closedDateField })
    } catch (err: any) {
      toast.push(String(err?.message || err || 'Gagal membatalkan'), 'error')
    }
  }

  const doReopen = async (r: KeyTx) => {
    const ok = window.confirm(`Undo ambil kunci ini (kembali status dipinjam)?\n\n${r.key_name} · ${r.borrower_name}\nTitip: ${fmtDateTime(r.checkout_at)}\nAmbil: ${fmtDateTime(r.checkin_at || '')}\n\nLanjutkan?`)
    if (!ok) return
    try {
      await apiPost(`/api/keys/${r.id}/reopen`, {})
      toast.push('Status dikembalikan ke dipinjam', 'success')
      const closedDateField = date === today && filterBy === 'ambil' ? 'checkin' : 'checkout'
      await refresh({ q, date, sort, limit, closedDateField })
    } catch (err: any) {
      toast.push(String(err?.message || err || 'Gagal undo ambil'), 'error')
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
        <h2 className="h2">Penitipan Kunci</h2>
        <div className="section-actions">
          <input className="input input-sm" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Cari nama, kunci, jam..." />
          <input className="input input-sm" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <select className="select select-sm" value={sort} onChange={(e) => setSort(e.target.value as any)}>
            <option value="checkout_desc">Titip terbaru</option>
            <option value="checkout_asc">Titip terlama</option>
            <option value="checkin_desc">Ambil terbaru</option>
            <option value="checkin_asc">Ambil terlama</option>
          </select>
          <select className="select select-sm" value={limit} onChange={(e) => setLimit(parseInt(e.target.value, 10))}>
            <option value={50}>50</option>
            <option value={200}>200</option>
            <option value={500}>500</option>
          </select>
          {date === today && (
            <>
              <select className="select select-sm" value={filterBy} onChange={(e) => setFilterBy(e.target.value as any)}>
                <option value="titip">Filter: Jam titip</option>
                <option value="ambil">Filter: Jam ambil</option>
              </select>
              <input className="input input-sm" type="time" value={fromHm} onChange={(e) => setFromHm(e.target.value)} title="Dari jam" />
              <input className="input input-sm" type="time" value={toHm} onChange={(e) => setToHm(e.target.value)} title="Sampai jam" />
            </>
          )}
          <button className="button button-secondary button-sm" type="button" onClick={() => setDate(today)}>
            Hari ini
          </button>
          <button className="button button-secondary button-sm" type="button" onClick={() => setDate('')}>
            Semua
          </button>
          <button
            className="button button-secondary button-sm"
            type="button"
            onClick={() => {
              const closedDateField = date === today && filterBy === 'ambil' ? 'checkin' : 'checkout'
              refresh({ q, date, sort, limit, closedDateField })
            }}
          >
            Refresh
          </button>
          <button
            className="button button-secondary button-sm"
            type="button"
            onClick={() => {
              const allRows = [...openView, ...closedView].sort((a, b) => Date.parse(b.checkout_at || '') - Date.parse(a.checkout_at || ''))
              downloadCsv(
                `kunci-${date || 'semua'}.csv`,
                [['Nama', 'Unit', 'Ruangan/Kunci', 'Jam titip', 'Jam ambil', 'Catatan', 'Foto', 'Petugas', 'Status']].concat(
                  allRows.map((r) => [
                    String(r.borrower_name || ''),
                    String(r.unit || ''),
                    String(r.key_name || ''),
                    String(fmtDateTime(r.checkout_at)),
                    String(fmtDateTime(r.checkin_at || '')),
                    String(r.notes || ''),
                    r.has_photo ? 'Ya' : 'Tidak',
                    petugasName(r),
                    String(r.status || ''),
                  ]),
                ),
              )
            }}
          >
            Export CSV
          </button>
          <button className="button button-secondary button-sm" type="button" onClick={() => window.print()}>
            Cetak
          </button>
        </div>
      </div>

      <section className="card" id="keysForm">
        <header className="card-header">
          <div className="card-title">Titip kunci</div>
          <div className="muted">
            Petugas:{' '}
            {me.user.role === 'admin' ? (
              <select className="select select-sm" style={{ display: 'inline-block', width: 'auto', marginLeft: 8 }} value={petugasId} onChange={(e) => setPetugasId(e.target.value)}>
                {guards.map(g => (
                  <option key={g.id} value={g.id}>{g.display_name}</option>
                ))}
                {!guards.some(g => String(g.id) === petugasId) && <option value={petugasId}>{me.user.display_name}</option>}
              </select>
            ) : (
              me.user.display_name
            )}
          </div>
        </header>
        <div className="card-body">
          <form className="form grid grid-4" onSubmit={onSubmit}>
            {formError && (
              <div className="grid-span-4">
                <div className="inline-error">{formError}</div>
              </div>
            )}
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
              <input className="input" id="keyName" value={keyName} onChange={(e) => setKeyName(e.target.value)} placeholder="mis. Radiologi" required list={keyMaster.length ? 'keyMasterList' : undefined} />
              {keyMaster.length > 0 && (
                <datalist id="keyMasterList">
                  {keyMaster.map((k) => (
                    <option key={k.id} value={k.name} />
                  ))}
                </datalist>
              )}
            </div>
            <div className="field field-time">
              <label className="label" htmlFor="keyTime">
                Jam titip
              </label>
              <div className="time-row">
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
              <div className="muted">Akan tersimpan: {fmtDateTime(toIsoLocal(today, time))}</div>
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
            <div className="sticky-actions grid-span-4">
              <div className="row row-right">
                <button
                  className="button button-secondary"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    const ok = window.confirm('Hapus draft penitipan kunci?')
                    if (!ok) return
                    localStorage.removeItem(draftKey)
                    setFormError('')
                    setBorrower('')
                    setUnit('')
                    setKeyName('')
                    setNotes('')
                    setTime(nowHm())
                    setPetugasId(String(me.user.id))
                    setPhoto(null)
                    setPhotoKey((x) => x + 1)
                  }}
                >
                  Reset
                </button>
                <button className="button button-primary" type="submit" disabled={busy}>
                  {busy ? 'Menyimpan...' : 'Simpan'}
                </button>
              </div>
            </div>
          </form>
          <div className="list" style={{ marginTop: 12 }}>
            <div className="list-item">
              <div className="list-title">Terakhir dicatat</div>
              <div className="list-meta">{(openView.length || closedView.length) ? '' : '—'}</div>
            </div>
            {[...openView, ...closedView]
              .sort((a, b) => new Date(b.checkout_at).getTime() - new Date(a.checkout_at).getTime())
              .slice(0, 3)
              .map((r) => (
                <div key={r.id} className="list-item">
                  <div className="list-title">
                    {r.key_name} · {r.borrower_name}
                  </div>
                  <div className="list-meta">
                    {fmtTime(r.checkout_at)} · {r.status === 'open' ? 'dititipkan' : r.status === 'closed' ? `diambil ${r.checkin_at ? fmtTime(r.checkin_at) : ''}` : 'void'}
                  </div>
                </div>
              ))}
          </div>
        </div>
      </section>

      <div className="grid grid-2">
        <section className="card">
          <header className="card-header">
            <div className="card-title">Penitipan aktif</div>
            <div className="muted">{loading ? 'Memuat...' : `${openView.length} entri`}</div>
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
                  {openView.map((r) => (
                    <tr key={r.id}>
                      <td data-label="Nama">{r.borrower_name}</td>
                      <td data-label="Ruangan">{r.key_name}</td>
                      <td data-label="Titip">{fmtDateTime(r.checkout_at)}</td>
                      <td data-label="Petugas">{petugasName(r)}</td>
                      <td data-label="Status">{badge(r.status)}</td>
                      <td data-label="Foto">
                        {r.has_photo && r.photo_url ? (
                          <button className="button button-sm button-secondary" type="button" onClick={() => openPhoto(r.photo_url!)}>
                            Foto
                          </button>
                        ) : (
                          <span className="muted">-</span>
                        )}
                      </td>
                      <td data-label="Aksi">
                        <button className="button button-sm" type="button" onClick={() => doReturn(r)} style={{ marginRight: 8 }}>
                          Ambil
                        </button>
                        <button className="button button-sm button-danger" type="button" onClick={() => doUndo(r.id)}>
                          Undo
                        </button>
                      </td>
                    </tr>
                  ))}
                  {openView.length === 0 && (
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
            <div className="muted">{loading ? 'Memuat...' : `${closedView.length} entri`}</div>
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
                    <th>Aksi</th>
                  </tr>
                </thead>
                <tbody>
                  {closedView.slice(0, 120).map((r) => (
                    <tr key={r.id}>
                      <td data-label="Nama">{r.borrower_name}</td>
                      <td data-label="Ruangan">{r.key_name}</td>
                      <td data-label="Titip">{fmtDateTime(r.checkout_at)}</td>
                      <td data-label="Ambil">{fmtDateTime(r.checkin_at || '')}</td>
                      <td data-label="Status">{badge(r.status)}</td>
                      <td data-label="Foto">
                        {r.has_photo && r.photo_url ? (
                          <button className="button button-sm button-secondary" type="button" onClick={() => openPhoto(r.photo_url!)}>
                            Foto
                          </button>
                        ) : (
                          <span className="muted">-</span>
                        )}
                      </td>
                      <td data-label="Aksi">
                        {r.status === 'closed' ? (
                          <button className="button button-sm button-secondary" type="button" onClick={() => doReopen(r)}>
                            Undo ambil
                          </button>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                  {closedView.length === 0 && (
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
      </div>

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

      <button className="fab" type="button" onClick={() => document.getElementById('keysForm')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
        + Titip
      </button>
    </section>
  )
}
