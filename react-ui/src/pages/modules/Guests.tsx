import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { apiGet, apiGetBlob, apiPatch, apiPost, apiPostForm } from '../../lib/api'
import type { GuestEntry, Me } from '../../types'
import { fmtDateTime, fmtTime, nowHm, shiftHm, toIsoLocal, toYmd } from '../../lib/time'
import { useConfirm, useToast } from '../../components/ToastHost'

export default function GuestsPage({ me }: { me: Me }) {
  const toast = useToast()
  const confirm = useConfirm()
  const today = useMemo(() => toYmd(new Date()), [])
  const draftKey = useMemo(() => `draft:guests:${me.user.id}`, [me.user.id])
  const [q, setQ] = useState('')
  const [postFilter, setPostFilter] = useState<'IGD' | 'Pintu Utama'>(() => (/^igd$/i.test((me.post || '').trim()) ? 'IGD' : 'Pintu Utama'))
  const [date, setDate] = useState(today)
  const [sort, setSort] = useState<'checkin_desc' | 'checkin_asc'>('checkin_desc')
  const [limit, setLimit] = useState(200)
  const [loading, setLoading] = useState(true)
  const [items, setItems] = useState<GuestEntry[]>([])
  const [filtersOpen, setFiltersOpen] = useState(() => (typeof window !== 'undefined' ? !window.matchMedia('(max-width: 560px)').matches : true))
  const [offset, setOffset] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [editRow, setEditRow] = useState<GuestEntry | null>(null)
  const [editName, setEditName] = useState('')
  const [editInstansi, setEditInstansi] = useState('')
  const [editPurpose, setEditPurpose] = useState('')
  const [editMeet, setEditMeet] = useState('')
  const [editNotes, setEditNotes] = useState('')

  const [name, setName] = useState('')
  const [instansi, setInstansi] = useState('')
  const [purpose, setPurpose] = useState('')
  const [meet, setMeet] = useState('')
  const [time, setTime] = useState(nowHm())
  const [notes, setNotes] = useState('')
  const [photo, setPhoto] = useState<File | null>(null)
  const [photoKey, setPhotoKey] = useState(0)
  const [photoView, setPhotoView] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState<string>('')

  const refresh = useCallback(async (opts: { q: string; date: string; sort: string; limit: number; post: string; offset?: number; append?: boolean }) => {
    const { q, date, sort, limit, post } = opts
    const nextOffset = Math.max(0, opts.offset || 0)
    const append = Boolean(opts.append)
    if (append) setLoadingMore(true)
    else setLoading(true)
    try {
      const res = await apiGet<{ items: GuestEntry[] }>(
        `/api/guests?status=all&q=${encodeURIComponent(q)}&date=${encodeURIComponent(date)}&sort=${encodeURIComponent(sort)}&limit=${encodeURIComponent(String(limit))}&post=${encodeURIComponent(post)}&offset=${encodeURIComponent(String(nextOffset))}`,
      )
      const nextItems = res.items || []
      setHasMore(nextItems.length >= limit)
      if (append) {
        setItems((prev) => prev.concat(nextItems))
        setOffset((prev) => prev + nextItems.length)
      } else {
        setItems(nextItems)
        setOffset(nextItems.length)
      }
    } catch (err: any) {
      toast.push(String(err?.message || err || 'Gagal memuat tamu'), 'error')
    } finally {
      setLoading(false)
      setLoadingMore(false)
    }
  }, [toast])

  useEffect(() => {
    const t = window.setTimeout(() => refresh({ q, date, sort, limit, post: postFilter, offset: 0, append: false }).catch(() => {}), 250)
    return () => window.clearTimeout(t)
  }, [date, limit, q, refresh, sort, postFilter])

  useEffect(() => {
    const raw = localStorage.getItem(draftKey)
    if (!raw) return
    try {
      const d = JSON.parse(raw)
      if (typeof d.name === 'string') setName(d.name)
      if (typeof d.instansi === 'string') setInstansi(d.instansi)
      if (typeof d.purpose === 'string') setPurpose(d.purpose)
      if (typeof d.meet === 'string') setMeet(d.meet)
      if (typeof d.time === 'string') setTime(d.time || nowHm())
      if (typeof d.notes === 'string') setNotes(d.notes)
    } catch {
      localStorage.removeItem(draftKey)
    }
  }, [draftKey])

  useEffect(() => {
    const t = window.setTimeout(() => {
      const payload = { name, instansi, purpose, meet, time, notes }
      localStorage.setItem(draftKey, JSON.stringify(payload))
    }, 300)
    return () => window.clearTimeout(t)
  }, [draftKey, instansi, meet, name, notes, purpose, time])

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
      const payload = { name, instansi, purpose, meet_person: meet, checkin_at: toIsoLocal(today, time), notes, post: postFilter }
      try {
        if (photo) {
          const form = new FormData()
          form.set('name', payload.name)
          form.set('instansi', payload.instansi)
          form.set('purpose', payload.purpose)
          form.set('meet_person', payload.meet_person)
          form.set('checkin_at', payload.checkin_at)
          form.set('notes', payload.notes)
          form.set('post', payload.post)
          form.set('photo', photo)
          await apiPostForm('/api/guests_with_photo', form)
        } else {
          await apiPost('/api/guests', payload)
        }
      } catch (err: any) {
        if (err?.status === 409) {
          const ok = await confirm.confirm({
            title: 'Konfirmasi Simpan',
            message: `${String(err?.message || 'Data serupa sudah ada')}\n\nTetap simpan?`,
            confirmText: 'Tetap Simpan',
          })
          if (!ok) throw err
          if (photo) {
            const form = new FormData()
            form.set('name', payload.name)
            form.set('instansi', payload.instansi)
            form.set('purpose', payload.purpose)
            form.set('meet_person', payload.meet_person)
            form.set('checkin_at', payload.checkin_at)
            form.set('notes', payload.notes)
            form.set('post', payload.post)
            form.set('force', 'true')
            form.set('photo', photo)
            await apiPostForm('/api/guests_with_photo', form)
          } else {
            await apiPost('/api/guests', { ...payload, force: true })
          }
        } else {
          throw err
        }
      }
      setName('')
      setInstansi('')
      setPurpose('')
      setMeet('')
      setNotes('')
      setPhoto(null)
      setPhotoKey((x) => x + 1)
      localStorage.removeItem(draftKey)
      toast.push('Tamu masuk dicatat', 'success')
      await refresh({ q, date, sort, limit, post: postFilter })
    } catch (err: any) {
      const msg = String(err?.message || err || 'Gagal menyimpan')
      setFormError(msg)
      toast.push(msg, 'error')
    } finally {
      setBusy(false)
    }
  }

  const canCorrect = (r: GuestEntry) => me.user.role === 'admin' || me.user.role === 'supervisor' || (typeof r.created_by === 'number' && r.created_by === me.user.id)

  const openEdit = (r: GuestEntry) => {
    setEditRow(r)
    setEditName(r.name || '')
    setEditInstansi(r.instansi || '')
    setEditPurpose(r.purpose || '')
    setEditMeet(r.meet_person || '')
    setEditNotes(r.notes || '')
  }

  const saveEdit = async () => {
    if (!editRow) return
    try {
      await apiPatch(`/api/guests/${editRow.id}`, {
        name: editName,
        instansi: editInstansi,
        purpose: editPurpose,
        meet_person: editMeet,
        notes: editNotes,
      })
      toast.push('Tamu diperbarui', 'success')
      setItems((prev) =>
        prev.map((x) =>
          x.id === editRow.id
            ? { ...x, name: editName, instansi: editInstansi, purpose: editPurpose, meet_person: editMeet, notes: editNotes }
            : x,
        ),
      )
      setEditRow(null)
    } catch (err: any) {
      toast.push(String(err?.message || err || 'Gagal edit tamu'), 'error')
    }
  }

  const voidGuest = async (r: GuestEntry) => {
    const reason = await confirm.prompt({ title: 'Void Tamu', message: 'Alasan void:', initialValue: '', confirmText: 'Void', cancelText: 'Batal', required: true })
    if (!reason) return
    try {
      await apiPost(`/api/guests/${r.id}/void`, { reason })
      toast.push('Tamu di-void', 'success')
      setItems((prev) => prev.map((x) => (x.id === r.id ? { ...x, status: 'void', void_reason: reason } : x)))
    } catch (err: any) {
      toast.push(String(err?.message || err || 'Gagal void tamu'), 'error')
    }
  }

  const undoCheckout = async (r: GuestEntry) => {
    const reason = await confirm.prompt({
      title: 'Batal Checkout',
      message: 'Alasan batal checkout:',
      initialValue: '',
      confirmText: 'Batal Checkout',
      cancelText: 'Kembali',
      required: true,
    })
    if (!reason) return
    try {
      await apiPost(`/api/guests/${r.id}/undo_checkout`, { reason })
      toast.push('Checkout dibatalkan', 'success')
      setItems((prev) => prev.map((x) => (x.id === r.id ? { ...x, status: 'in', checkout_at: null } : x)))
    } catch (err: any) {
      toast.push(String(err?.message || err || 'Gagal membatalkan checkout'), 'error')
    }
  }

  const checkout = async (r: GuestEntry) => {
    const ok = await confirm.confirm({
      title: 'Checkout Tamu',
      message: `Checkout tamu ini?\n\n${r.name} · ${r.instansi}\nMasuk: ${fmtDateTime(r.checkin_at)}\n\nLanjutkan?`,
      confirmText: 'Checkout',
    })
    if (!ok) return
    try {
      await apiPost(`/api/guests/${r.id}/checkout`, {})
      const nowIso = new Date().toISOString()
      setItems((prev) => prev.map((x) => (x.id === r.id ? { ...x, status: 'out', checkout_at: nowIso } : x)))
      toast.push('Tamu checkout', 'success')
      await refresh({ q, date, sort, limit, post: postFilter })
    } catch (err: any) {
      toast.push(String(err?.message || err || 'Gagal memproses'), 'error')
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
      <div className="tabsbar" style={{ marginBottom: 16 }}>
        <div className="tabs">
          <button className={`tab${postFilter === 'IGD' ? ' tab-active' : ''}`} onClick={() => setPostFilter('IGD')}>Pos IGD</button>
          <button className={`tab${postFilter === 'Pintu Utama' ? ' tab-active' : ''}`} onClick={() => setPostFilter('Pintu Utama')}>Pos Pintu Utama</button>
        </div>
      </div>
      <div className="section-header">
        <h2 className="h2">Buku Tamu ({postFilter})</h2>
        <div className="section-actions">
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
            {formError && (
              <div className="grid-span-4">
                <div className="inline-error">{formError}</div>
              </div>
            )}
            <div className="field">
              <label className="label" htmlFor="guestName">
                Nama
              </label>
              <input className="input" id="guestName" value={name} onChange={(e) => setName(e.target.value)} placeholder="Nama tamu" required />
            </div>
            <div className="field">
              <label className="label" htmlFor="guestInstansi">
                Instansi
              </label>
              <input className="input" id="guestInstansi" value={instansi} onChange={(e) => setInstansi(e.target.value)} placeholder="mis. Vendor" required />
            </div>
            <div className="field">
              <label className="label" htmlFor="guestPurpose">
                Divisi Tujuan
              </label>
              <input className="input" id="guestPurpose" value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="mis. IT / HRD" required />
            </div>
            <div className="field field-time">
              <label className="label" htmlFor="guestTime">
                Jam masuk
              </label>
              <div className="time-row">
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
              <div className="muted">Akan tersimpan: {fmtDateTime(toIsoLocal(today, time))}</div>
            </div>
            <div className="field grid-span-4">
              <label className="label" htmlFor="guestMeet">
                Orang yang ditemui
              </label>
              <input className="input" id="guestMeet" value={meet} onChange={(e) => setMeet(e.target.value)} placeholder="Nama staf/unit" required />
            </div>
            <div className="field grid-span-4">
              <label className="label" htmlFor="guestNotes">
                Keperluan
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
                  onClick={() => {
                    ;(async () => {
                      const ok = await confirm.confirm({ title: 'Reset Draft', message: 'Hapus draft input tamu?', confirmText: 'Hapus' })
                      if (!ok) return
                      localStorage.removeItem(draftKey)
                      setName('')
                      setInstansi('')
                      setPurpose('')
                      setMeet('')
                      setNotes('')
                      setTime(nowHm())
                      setFormError('')
                      setPhoto(null)
                      setPhotoKey((x) => x + 1)
                    })().catch(() => {})
                  }}
                  disabled={busy}
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
              <div className="list-meta">{items.slice(0, 3).length ? '' : '—'}</div>
            </div>
            {items.slice(0, 3).map((r) => (
              <div key={r.id} className="list-item">
                <div className="list-title">
                  {r.name} · {r.instansi}
                </div>
                <div className="list-meta">
                  {fmtTime(r.checkin_at)} {r.status === 'out' && r.checkout_at ? `· keluar ${fmtTime(r.checkout_at)}` : '· masih di dalam'}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="card">
        <header className="card-header">
          <div className="card-title">Daftar tamu</div>
          <div className="muted">{loading ? 'Memuat...' : `${items.length} entri`}</div>
        </header>
        <div className="card-body">
          <div className="table-wrap">
            <table className="table table-mobile-cards">
              <thead>
                <tr>
                  <th>Nama</th>
                  <th>Instansi</th>
                  <th>Divisi Tujuan</th>
                  <th>Ditemui</th>
                  <th>Masuk</th>
                  <th>Keluar</th>
                  <th>Foto</th>
                  <th>Aksi</th>
                </tr>
              </thead>
              <tbody>
                {items.map((r) => (
                  <tr key={r.id} className={r.status === 'in' ? 'table-row-active' : r.status === 'void' ? 'table-row-void' : undefined}>
                    <td data-label="Nama">{r.name}</td>
                    <td data-label="Instansi">{r.instansi}</td>
                    <td data-label="Divisi Tujuan">{r.purpose}</td>
                    <td data-label="Ditemui">{r.meet_person}</td>
                    <td data-label="Masuk">{fmtTime(r.checkin_at)}</td>
                    <td data-label="Keluar">{fmtTime(r.checkout_at)}</td>
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
                      {r.status === 'void' ? (
                        <span className="muted">Void{r.void_reason ? `: ${r.void_reason}` : ''}</span>
                      ) : (
                        <div className="row" style={{ flexWrap: 'wrap' }}>
                          {r.status === 'in' ? (
                            <button className="button button-sm" type="button" onClick={() => checkout(r)}>
                              ↗ Keluar
                            </button>
                          ) : canCorrect(r) ? (
                            <button className="button button-sm button-secondary" type="button" onClick={() => undoCheckout(r)}>
                              ↩ Batal checkout
                            </button>
                          ) : null}
                          {canCorrect(r) ? (
                            <button className="button button-sm button-secondary" type="button" onClick={() => openEdit(r)}>
                              ✎ Edit
                            </button>
                          ) : null}
                          {canCorrect(r) ? (
                            <button className="button button-sm button-danger" type="button" onClick={() => voidGuest(r)}>
                              ⨯ Void
                            </button>
                          ) : null}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
                {items.length === 0 && (
                  <tr>
                    <td className="muted" colSpan={8}>
                      Tidak ada data.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="table-footer-filters">
            <div className="filter-group">
              <label className="label-sm">Cari</label>
              <input className="input input-sm" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Cari tamu / instansi..." />
            </div>
            <div className="filter-group">
              <label className="label-sm">Tanggal</label>
              <input className="input input-sm" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div className="filter-group">
              <label className="label-sm">Urutan</label>
              <select className="select select-sm" value={sort} onChange={(e) => setSort(e.target.value as any)}>
                <option value="checkin_desc">Masuk terbaru</option>
                <option value="checkin_asc">Masuk terlama</option>
              </select>
            </div>
            <div className="filter-group">
              <label className="label-sm">Limit</label>
              <select className="select select-sm" value={limit} onChange={(e) => setLimit(parseInt(e.target.value, 10))}>
                <option value={50}>50</option>
                <option value={200}>200</option>
                <option value={500}>500</option>
              </select>
            </div>
            <div className="filter-actions">
              <button className="button button-secondary button-sm" type="button" onClick={() => setDate(today)}>
                Hari ini
              </button>
              <button className="button button-secondary button-sm" type="button" onClick={() => setDate('')}>
                Semua
              </button>
              <button className="button button-secondary button-sm" type="button" onClick={() => refresh({ q, date, sort, limit, post: postFilter, offset: 0, append: false })}>
                Refresh
              </button>
              <button
                className="button button-secondary button-sm"
                type="button"
                onClick={() =>
                  downloadCsv(
                    `tamu-${postFilter}-${date || 'semua'}.csv`,
                    [['Nama', 'Instansi', 'Divisi Tujuan', 'Ditemui', 'Masuk', 'Keluar', 'Keperluan', 'Foto', 'Petugas', 'Status', 'Alasan void']].concat(
                      items.map((r) => [
                        r.name,
                        r.instansi,
                        r.purpose,
                        r.meet_person,
                        fmtDateTime(r.checkin_at),
                        fmtDateTime(r.checkout_at),
                        r.notes || '',
                        r.has_photo ? 'Ya' : 'Tidak',
                        r.created_by_name || '-',
                        r.status,
                        r.void_reason || '',
                      ]),
                    ),
                  )
                }
              >
                Export CSV
              </button>
            </div>
          </div>

          {hasMore && (
            <div className="row" style={{ justifyContent: 'center', marginTop: 12 }}>
              <button
                className="button button-secondary"
                type="button"
                disabled={loading || loadingMore}
                onClick={() => refresh({ q, date, sort, limit, post: postFilter, offset, append: true })}
              >
                {loadingMore ? 'Memuat...' : 'Muat lebih banyak'}
              </button>
            </div>
          )}
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

      {editRow && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Edit tamu" onClick={(e) => (e.currentTarget === e.target ? setEditRow(null) : null)}>
          <div className="modal">
            <div className="modal-header">
              <div className="modal-title">Edit Tamu</div>
              <button className="button button-secondary button-sm" type="button" onClick={() => setEditRow(null)}>
                Tutup
              </button>
            </div>
            <div className="modal-body">
              <div className="grid" style={{ gap: 10 }}>
                <input className="input" value={editName} onChange={(e) => setEditName(e.target.value)} placeholder="Nama" />
                <input className="input" value={editInstansi} onChange={(e) => setEditInstansi(e.target.value)} placeholder="Instansi" />
                <input className="input" value={editPurpose} onChange={(e) => setEditPurpose(e.target.value)} placeholder="Divisi tujuan" />
                <input className="input" value={editMeet} onChange={(e) => setEditMeet(e.target.value)} placeholder="Ditemui" />
                <textarea className="textarea" value={editNotes} onChange={(e) => setEditNotes(e.target.value)} placeholder="Keperluan" />
              </div>
              <div className="row row-right" style={{ marginTop: 14 }}>
                <button className="button button-secondary" type="button" onClick={() => setEditRow(null)}>
                  Batal
                </button>
                <button className="button button-primary" type="button" onClick={saveEdit}>
                  Simpan
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <button className="fab" type="button" onClick={() => document.getElementById('guestsForm')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
        + Tamu
      </button>
    </section>
  )
}
