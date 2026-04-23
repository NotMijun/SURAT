import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { apiGet, apiGetBlob, apiPatch, apiPost, apiPostForm } from '../../lib/api'
import type { AttachmentItem, GuestEntry, Me } from '../../types'
import { compressImageFile } from '../../lib/image'
import { fmtDateTime, fmtTime, nowHm, shiftHm, toIsoLocal, toYmd } from '../../lib/time'
import { useConfirm, useToast } from '../../components/ToastHost'
import LoadingScreen from '../../components/LoadingScreen'

export default function GuestsPage({ me }: { me: Me }) {
  const toast = useToast()
  const confirm = useConfirm()
  const today = useMemo(() => toYmd(new Date()), [])
  const draftKey = useMemo(() => `draft:guests:${me.user.id}`, [me.user.id])
  type GuestView = 'inhouse' | 'riwayat'
  const [view, setView] = useState<GuestView>('inhouse')
  type RoomMasterItem = { id: number; name: string }
  const [roomMaster, setRoomMaster] = useState<RoomMasterItem[]>([])
  const [q, setQ] = useState('')
  const [postFilter, setPostFilter] = useState<'IGD' | 'Pintu Utama'>(() => (/^igd$/i.test((me.post || '').trim()) ? 'IGD' : 'Pintu Utama'))
  const [date, setDate] = useState(today)
  const [formDate, setFormDate] = useState(today)
  const [sort, setSort] = useState<'checkin_desc' | 'checkin_asc'>('checkin_desc')
  const [limit, setLimit] = useState(200)
  const [loading, setLoading] = useState(true)
  const [items, setItems] = useState<GuestEntry[]>([])
  const [offset, setOffset] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [editRow, setEditRow] = useState<GuestEntry | null>(null)
  const [editName, setEditName] = useState('')
  const [editInstansi, setEditInstansi] = useState('')
  const [editPurpose, setEditPurpose] = useState('')
  const [editMeet, setEditMeet] = useState('')
  const [editNotes, setEditNotes] = useState('')
  const [editDestinationRoom, setEditDestinationRoom] = useState('')
  const [editVisitorCardNo, setEditVisitorCardNo] = useState('')

  const [name, setName] = useState('')
  const [instansi, setInstansi] = useState('')
  const [purpose, setPurpose] = useState('')
  const [meet, setMeet] = useState('')
  const [time, setTime] = useState(nowHm())
  const [notes, setNotes] = useState('')
  const [destinationRoom, setDestinationRoom] = useState('')
  const [visitorCardNo, setVisitorCardNo] = useState('')
  const [photos, setPhotos] = useState<Array<{ file: File; kind: string; previewUrl: string }>>([])
  const [photoKey, setPhotoKey] = useState(0)
  const [attachments, setAttachments] = useState<AttachmentItem[]>([])
  const [activeAttachment, setActiveAttachment] = useState<AttachmentItem | null>(null)
  const [photoView, setPhotoView] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState<string>('')

  const refresh = useCallback(async (opts: { q: string; date: string; sort: string; limit: number; post: string; status: string; offset?: number; append?: boolean }) => {
    const { q, date, sort, limit, post, status } = opts
    const nextOffset = Math.max(0, opts.offset || 0)
    const append = Boolean(opts.append)
    if (append) setLoadingMore(true)
    else setLoading(true)
    try {
      const res = await apiGet<{ items: GuestEntry[] }>(
        `/api/guests?status=${encodeURIComponent(status)}&q=${encodeURIComponent(q)}&date=${encodeURIComponent(date)}&sort=${encodeURIComponent(sort)}&limit=${encodeURIComponent(String(limit))}&post=${encodeURIComponent(post)}&offset=${encodeURIComponent(String(nextOffset))}`,
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
    const status = view === 'inhouse' ? 'in' : 'all'
    const effectiveDate = view === 'inhouse' ? '' : date
    const effectiveSort = view === 'inhouse' ? 'checkin_asc' : sort
    const t = window.setTimeout(
      () => refresh({ q, date: effectiveDate, sort: effectiveSort, limit, post: postFilter, status, offset: 0, append: false }).catch(() => {}),
      250,
    )
    return () => window.clearTimeout(t)
  }, [date, limit, q, refresh, sort, postFilter, view])

  useEffect(() => {
    const raw = localStorage.getItem(draftKey)
    if (!raw) return
    try {
      const d = JSON.parse(raw)
      if (typeof d.name === 'string') setName(d.name)
      if (typeof d.instansi === 'string') setInstansi(d.instansi)
      if (typeof d.purpose === 'string') setPurpose(d.purpose)
      if (typeof d.meet === 'string') setMeet(d.meet)
      if (typeof d.destinationRoom === 'string') setDestinationRoom(d.destinationRoom)
      if (typeof d.visitorCardNo === 'string') setVisitorCardNo(d.visitorCardNo)
      if (typeof d.time === 'string') setTime(d.time || nowHm())
      if (typeof d.notes === 'string') setNotes(d.notes)
    } catch {
      localStorage.removeItem(draftKey)
    }
  }, [draftKey])

  useEffect(() => {
    apiGet<{ items: RoomMasterItem[] }>('/api/rooms/master')
      .then((res) => setRoomMaster(res.items || []))
      .catch(() => setRoomMaster([]))
  }, [])

  useEffect(() => {
    const t = window.setTimeout(() => {
      const payload = { name, instansi, purpose, meet, destinationRoom, visitorCardNo, time, notes }
      localStorage.setItem(draftKey, JSON.stringify(payload))
    }, 300)
    return () => window.clearTimeout(t)
  }, [draftKey, destinationRoom, instansi, meet, name, notes, purpose, time, visitorCardNo])

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
      const payload: any = { name, checkin_at: toIsoLocal(formDate, time), notes, post: postFilter }
      if (postFilter === 'Pintu Utama') {
        payload.destination_room = destinationRoom
        payload.visitor_card_no = visitorCardNo
        payload.ktp_exchanged = true
      } else {
        payload.instansi = instansi
        payload.purpose = purpose
        payload.meet_person = meet
      }
      let createdId: number | null = null
      try {
        const res = await apiPost<{ ok: boolean; id: number }>('/api/guests', payload)
        createdId = res.id
      } catch (err: any) {
        if (err?.status === 409) {
          const ok = await confirm.confirm({
            title: 'Konfirmasi Simpan',
            message: `${String(err?.message || 'Data serupa sudah ada')}\n\nTetap simpan?`,
            confirmText: 'Tetap Simpan',
          })
          if (!ok) throw err
          const res = await apiPost<{ ok: boolean; id: number }>('/api/guests', { ...payload, force: true })
          createdId = res.id
        } else {
          throw err
        }
      }
      if (createdId && photos.length > 0) {
        try {
          const form = new FormData()
          for (const p of photos) {
            form.append('photos', p.file, p.file.name)
            form.append('kind', p.kind)
          }
          await apiPostForm(`/api/attachments/guest_entries/${createdId}`, form)
        } catch (err: any) {
          toast.push(`Data tersimpan, tapi upload foto gagal: ${String(err?.message || err || '')}`, 'error')
        }
      }
      setName('')
      setInstansi('')
      setPurpose('')
      setMeet('')
      setNotes('')
      setDestinationRoom('')
      setVisitorCardNo('')
      for (const p of photos) URL.revokeObjectURL(p.previewUrl)
      setPhotos([])
      setPhotoKey((x) => x + 1)
      localStorage.removeItem(draftKey)
      toast.push('Tamu masuk dicatat', 'success')
      const status = view === 'inhouse' ? 'in' : 'all'
      const effectiveDate = view === 'inhouse' ? '' : date
      const effectiveSort = view === 'inhouse' ? 'checkin_asc' : sort
      await refresh({ q, date: effectiveDate, sort: effectiveSort, limit, post: postFilter, status })
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
    setEditDestinationRoom(String(r.destination_room || ''))
    setEditVisitorCardNo(String(r.visitor_card_no || ''))
  }

  const saveEdit = async () => {
    if (!editRow) return
    try {
      const patch: any = { name: editName, notes: editNotes }
      if (editRow.post === 'Pintu Utama' || editRow.post === 'Lobby') {
        patch.destination_room = editDestinationRoom
        patch.visitor_card_no = editVisitorCardNo
        patch.ktp_exchanged = true
      } else {
        patch.instansi = editInstansi
        patch.purpose = editPurpose
        patch.meet_person = editMeet
      }
      await apiPatch(`/api/guests/${editRow.id}`, patch)
      toast.push('Tamu diperbarui', 'success')
      setItems((prev) =>
        prev.map((x) =>
          x.id === editRow.id
            ? {
                ...x,
                name: editName,
                instansi: editRow.post === 'Pintu Utama' || editRow.post === 'Lobby' ? '' : editInstansi,
                purpose: editRow.post === 'Pintu Utama' || editRow.post === 'Lobby' ? x.purpose : editPurpose,
                meet_person: editRow.post === 'Pintu Utama' || editRow.post === 'Lobby' ? x.meet_person : editMeet,
                destination_room: editRow.post === 'Pintu Utama' || editRow.post === 'Lobby' ? editDestinationRoom : x.destination_room,
                visitor_card_no: editRow.post === 'Pintu Utama' || editRow.post === 'Lobby' ? editVisitorCardNo : x.visitor_card_no,
                ktp_exchanged: editRow.post === 'Pintu Utama' || editRow.post === 'Lobby' ? true : x.ktp_exchanged,
                notes: editNotes,
              }
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
    const detail = r.post === 'Pintu Utama' || r.post === 'Lobby' ? (r.destination_room || '-') : (r.instansi || '-')
    const ok = await confirm.confirm({
      title: 'Checkout Tamu',
      message: `Checkout tamu ini?\n\n${r.name} · ${detail}\nMasuk: ${fmtDateTime(r.checkin_at)}\n\nLanjutkan?`,
      confirmText: 'Checkout',
    })
    if (!ok) return
    try {
      await apiPost(`/api/guests/${r.id}/checkout`, {})
      const nowIso = new Date().toISOString()
      setItems((prev) => prev.map((x) => (x.id === r.id ? { ...x, status: 'out', checkout_at: nowIso } : x)))
      toast.push('Tamu checkout', 'success')
      const status = view === 'inhouse' ? 'in' : 'all'
      const effectiveDate = view === 'inhouse' ? '' : date
      const effectiveSort = view === 'inhouse' ? 'checkin_asc' : sort
      await refresh({ q, date: effectiveDate, sort: effectiveSort, limit, post: postFilter, status })
    } catch (err: any) {
      toast.push(String(err?.message || err || 'Gagal memproses'), 'error')
    }
  }

  const closePhoto = () => {
    if (photoView) URL.revokeObjectURL(photoView)
    setPhotoView(null)
    setAttachments([])
    setActiveAttachment(null)
  }

  const loadPhotoUrl = useCallback(async (url: string) => {
    const blob = await apiGetBlob(url)
    if (photoView) URL.revokeObjectURL(photoView)
    setPhotoView(URL.createObjectURL(blob))
  }, [photoView])

  const openGuestPhotos = useCallback(async (r: GuestEntry) => {
    try {
      const res = await apiGet<{ items: AttachmentItem[] }>(`/api/attachments/guest_entries/${r.id}`)
      const list = res.items || []
      if (list.length > 0) {
        setAttachments(list)
        setActiveAttachment(list[0])
        await loadPhotoUrl(list[0].url)
        return
      }
      if (r.photo_url) {
        await loadPhotoUrl(r.photo_url)
        return
      }
      toast.push('Foto tidak ditemukan', 'error')
    } catch (err: any) {
      toast.push(String(err?.message || err || 'Gagal memuat foto'), 'error')
    }
  }, [loadPhotoUrl, toast])

  const attachmentKinds = useMemo(() => ['Foto', 'Surat Jalan', 'Kondisi Barang', 'Lokasi'], [])

  const addSelectedPhotos = useCallback(
    async (fileList: FileList | null) => {
      const files = Array.from(fileList || [])
      if (files.length === 0) return
      const remaining = Math.max(0, 6 - photos.length)
      const picked = files.slice(0, remaining)
      if (picked.length < files.length) toast.push('Maksimal 6 foto per entri', 'error')
      const next: Array<{ file: File; kind: string; previewUrl: string }> = []
      for (const f of picked) {
        if (!String(f.type || '').toLowerCase().startsWith('image/')) {
          toast.push('File foto harus gambar', 'error')
          continue
        }
        const cf = await compressImageFile(f).catch(() => f)
        if (cf.size > 3 * 1024 * 1024) {
          toast.push('Ukuran foto setelah kompres masih terlalu besar (maks 3MB)', 'error')
          continue
        }
        next.push({ file: cf, kind: 'Foto', previewUrl: URL.createObjectURL(cf) })
      }
      if (next.length > 0) setPhotos((prev) => prev.concat(next))
    },
    [photos.length, toast],
  )

  return (
    <section className="section">
      <div className="tabsbar tabsbar-sub" style={{ marginBottom: 16 }}>
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
          <form className="form grid grid-2" onSubmit={onSubmit}>
            {formError && (
              <div className="grid-span-2">
                <div className="inline-error">{formError}</div>
              </div>
            )}
            <div className="field">
              <label className="label" htmlFor="guestName">
                Nama
              </label>
              <input className="input" id="guestName" value={name} onChange={(e) => setName(e.target.value)} placeholder="Nama tamu" required />
            </div>
            {postFilter !== 'Pintu Utama' && (
              <div className="field">
                <label className="label" htmlFor="guestInstansi">
                  Instansi
                </label>
                <input className="input" id="guestInstansi" value={instansi} onChange={(e) => setInstansi(e.target.value)} placeholder="mis. Vendor" required />
              </div>
            )}
            <div className="field">
              <label className="label" htmlFor="guestPurpose">
                {postFilter === 'Pintu Utama' ? 'Ruang Tujuan' : 'Divisi Tujuan'}
              </label>
              <input
                className="input"
                id="guestPurpose"
                value={postFilter === 'Pintu Utama' ? destinationRoom : purpose}
                onChange={(e) => (postFilter === 'Pintu Utama' ? setDestinationRoom(e.target.value) : setPurpose(e.target.value))}
                placeholder={postFilter === 'Pintu Utama' ? 'mis. Ruang 204 / Anak / ICU' : 'mis. IT / HRD'}
                required
                list={postFilter === 'Pintu Utama' && roomMaster.length ? 'roomMasterList' : undefined}
              />
            </div>
            <div className="field field-time">
              <label className="label" htmlFor="guestTime">
                Waktu masuk
              </label>
              <div className="time-row">
                <input className="input" type="date" value={formDate} onChange={(e) => setFormDate(e.target.value)} style={{ width: 'auto' }} />
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
              <div className="muted">Akan tersimpan: {fmtDateTime(toIsoLocal(formDate, time))}</div>
            </div>
            {postFilter === 'Pintu Utama' ? (
              <div className="field grid-span-2">
                <label className="label" htmlFor="guestCard">
                  No Kartu Penunggu Pasien
                </label>
                <input className="input" id="guestCard" value={visitorCardNo} onChange={(e) => setVisitorCardNo(e.target.value)} placeholder="Nomor kartu" required />
              </div>
            ) : (
              <div className="field grid-span-2">
                <label className="label" htmlFor="guestMeet">
                  Orang yang ditemui
                </label>
                <input className="input" id="guestMeet" value={meet} onChange={(e) => setMeet(e.target.value)} placeholder="Nama staf/unit" required />
              </div>
            )}
            <div className="field grid-span-2">
              <label className="label" htmlFor="guestNotes">
                Keperluan
              </label>
              <textarea className="input textarea" id="guestNotes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="opsional" />
            </div>
            <div className="field grid-span-2">
              <label className="label" htmlFor="guestPhoto">
                Lampiran foto (opsional)
              </label>
              <input
                key={photoKey}
                className="input"
                id="guestPhoto"
                type="file"
                accept="image/*"
                multiple
                onChange={(e) => {
                  ;(async () => {
                    await addSelectedPhotos(e.target.files)
                    setPhotoKey((x) => x + 1)
                  })().catch(() => {})
                }}
              />
              <div className="attachments-grid">
                {photos.map((p, idx) => (
                  <div className="attachment-item" key={p.previewUrl}>
                    <img className="attachment-thumb" src={p.previewUrl} alt={p.kind} />
                    <div className="attachment-meta">
                      <select
                        className="select select-sm"
                        value={p.kind}
                        onChange={(e) => setPhotos((prev) => prev.map((x, i) => (i === idx ? { ...x, kind: e.target.value } : x)))}
                      >
                        {attachmentKinds.map((k) => (
                          <option key={k} value={k}>
                            {k}
                          </option>
                        ))}
                      </select>
                      <button
                        className="button button-sm button-secondary"
                        type="button"
                        onClick={() => {
                          URL.revokeObjectURL(p.previewUrl)
                          setPhotos((prev) => prev.filter((_, i) => i !== idx))
                        }}
                      >
                        Hapus
                      </button>
                    </div>
                    <div className="muted">{p.file.name}</div>
                  </div>
                ))}
                {photos.length === 0 && <div className="muted">Tidak ada foto</div>}
              </div>
            </div>
            <div className="sticky-actions grid-span-2">
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
                      for (const p of photos) URL.revokeObjectURL(p.previewUrl)
                      setPhotos([])
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
                  {r.name} · {r.post === 'Pintu Utama' || r.post === 'Lobby' ? (r.destination_room || '-') : (r.instansi || '-')}
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
          <div>
            <div className="card-title">{view === 'inhouse' ? 'Tamu masih di dalam' : 'Riwayat tamu'}</div>
            <div className="muted">{loading ? 'Memuat...' : `${items.length} entri`}</div>
          </div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <button
              className={`tab${view === 'inhouse' ? ' tab-active' : ''}`}
              type="button"
              onClick={() => {
                setView('inhouse')
                setOffset(0)
              }}
            >
              Masih di dalam
            </button>
            <button
              className={`tab${view === 'riwayat' ? ' tab-active' : ''}`}
              type="button"
              onClick={() => {
                setView('riwayat')
                setOffset(0)
              }}
            >
              Riwayat
            </button>
          </div>
        </header>
        <div className="card-body">
          {loading && <LoadingScreen mode="inline" label="Loading..." minHeight={320} />}
          <div className="table-wrap" aria-hidden={loading}>
            <table className="table table-mobile-cards">
              <thead>
                <tr>
                  <th>Nama</th>
                  {view === 'riwayat' && postFilter === 'IGD' && <th>Instansi</th>}
                  <th>Tujuan</th>
                  {view === 'riwayat' && <th>Kartu</th>}
                  {view === 'riwayat' && <th>Ditemui</th>}
                  <th>Masuk</th>
                  {view === 'riwayat' && <th>Keluar</th>}
                  <th>Foto</th>
                  <th>Aksi</th>
                </tr>
              </thead>
              <tbody>
                {items.map((r) => (
                  <tr key={r.id} className={r.status === 'in' ? 'table-row-active' : r.status === 'void' ? 'table-row-void' : undefined}>
                    <td data-label="Nama">{r.name}</td>
                    {view === 'riwayat' && postFilter === 'IGD' && <td data-label="Instansi">{r.instansi}</td>}
                    <td data-label="Tujuan">{r.post === 'Pintu Utama' || r.post === 'Lobby' ? (r.destination_room || '-') : (r.purpose || '-')}</td>
                    {view === 'riwayat' && (
                      <td data-label="Kartu">{r.post === 'Pintu Utama' || r.post === 'Lobby' ? (r.visitor_card_no || '-') : '-'}</td>
                    )}
                    {view === 'riwayat' && (
                      <td data-label="Ditemui">{r.post === 'Pintu Utama' || r.post === 'Lobby' ? '-' : (r.meet_person || '-')}</td>
                    )}
                    <td data-label="Masuk">{fmtTime(r.checkin_at)}</td>
                    {view === 'riwayat' && <td data-label="Keluar">{fmtTime(r.checkout_at)}</td>}
                    <td data-label="Foto">
                      {r.has_photo && r.photo_url ? (
                        <button className="button button-sm button-secondary" type="button" onClick={() => openGuestPhotos(r)}>
                          {typeof r.photo_count === 'number' && r.photo_count > 1 ? `Foto (${r.photo_count})` : 'Foto'}
                        </button>
                      ) : (
                        <span className="muted">-</span>
                      )}
                    </td>
                    <td data-label="Aksi">
                      {r.status === 'void' ? (
                        <span className="muted">Void{r.void_reason ? `: ${r.void_reason}` : ''}</span>
                      ) : (
                        <div className="card-actions">
                          {r.status === 'in' ? (
                            <button className="button button-sm button-primary" type="button" onClick={() => checkout(r)} style={view === 'inhouse' ? { minHeight: 46, fontSize: 15 } : undefined}>
                              Checkout
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
                            <button className="button button-sm button-void" type="button" onClick={() => voidGuest(r)}>
                              ✕ Void
                            </button>
                          ) : null}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
                {items.length === 0 && (
                  <tr>
                    <td className="muted" colSpan={view === 'riwayat' ? (postFilter === 'IGD' ? 9 : 8) : 5}>
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
              <input className="input input-sm" value={q} onChange={(e) => setQ(e.target.value)} placeholder={postFilter === 'IGD' ? 'Cari tamu / instansi...' : 'Cari tamu...'} />
            </div>
            {view === 'riwayat' && (
              <div className="filter-group">
                <label className="label-sm">Tanggal</label>
                <input className="input input-sm" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </div>
            )}
            {view === 'riwayat' && (
              <div className="filter-group">
                <label className="label-sm">Urutan</label>
                <select className="select select-sm" value={sort} onChange={(e) => setSort(e.target.value as any)}>
                  <option value="checkin_desc">Masuk terbaru</option>
                  <option value="checkin_asc">Masuk terlama</option>
                </select>
              </div>
            )}
            <div className="filter-group">
              <label className="label-sm">Limit</label>
              <select className="select select-sm" value={limit} onChange={(e) => setLimit(parseInt(e.target.value, 10))}>
                <option value={50}>50</option>
                <option value={200}>200</option>
                <option value={500}>500</option>
              </select>
            </div>
            <div className="filter-actions">
              {view === 'riwayat' && (
                <button className="button button-secondary button-sm" type="button" onClick={() => setDate(today)}>
                  Hari ini
                </button>
              )}
              {view === 'riwayat' && (
                <button className="button button-secondary button-sm" type="button" onClick={() => setDate('')}>
                  Semua
                </button>
              )}
              <button
                className="button button-secondary button-sm"
                type="button"
                onClick={() => {
                  const status = view === 'inhouse' ? 'in' : 'all'
                  const effectiveDate = view === 'inhouse' ? '' : date
                  const effectiveSort = view === 'inhouse' ? 'checkin_asc' : sort
                  refresh({ q, date: effectiveDate, sort: effectiveSort, limit, post: postFilter, status, offset: 0, append: false }).catch(() => {})
                }}
              >
                Refresh
              </button>
              {view === 'riwayat' && (
                <button
                  className="button button-secondary button-sm"
                  type="button"
                  onClick={() =>
                    downloadCsv(
                      `tamu-${postFilter}-${date || 'semua'}.csv`,
                      [['Nama', 'Instansi', 'Tujuan', 'Kartu', 'Ditemui', 'Masuk', 'Keluar', 'Keperluan', 'Foto', 'Petugas', 'Status', 'Alasan void']].concat(
                        items.map((r) => [
                          r.name,
                          r.instansi,
                          r.post === 'Pintu Utama' || r.post === 'Lobby' ? String(r.destination_room || '') : r.purpose,
                          r.post === 'Pintu Utama' || r.post === 'Lobby' ? String(r.visitor_card_no || '') : '',
                          r.post === 'Pintu Utama' || r.post === 'Lobby' ? '' : r.meet_person,
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
              )}
            </div>
          </div>

          {view === 'riwayat' && hasMore && (
            <div className="row" style={{ justifyContent: 'center', marginTop: 12 }}>
              <button
                className="button button-secondary"
                type="button"
                disabled={loading || loadingMore}
                onClick={() => refresh({ q, date, sort, limit, post: postFilter, status: 'all', offset, append: true })}
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
              <div className="modal-title">{activeAttachment?.kind ? `Foto · ${activeAttachment.kind}` : 'Foto'}</div>
              <button className="button button-secondary button-sm" type="button" onClick={closePhoto}>
                Tutup
              </button>
            </div>
            <div className="modal-body">
              {attachments.length > 1 && (
                <div className="attachment-strip">
                  {attachments.map((a) => (
                    <button
                      key={a.id}
                      className={`button button-sm button-secondary${activeAttachment?.id === a.id ? ' button-active' : ''}`}
                      type="button"
                      onClick={() => {
                        ;(async () => {
                          setActiveAttachment(a)
                          await loadPhotoUrl(a.url)
                        })().catch(() => {})
                      }}
                    >
                      {a.kind}
                    </button>
                  ))}
                </div>
              )}
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
                {editRow.post === 'Pintu Utama' || editRow.post === 'Lobby' ? (
                  <>
                    <input
                      className="input"
                      value={editDestinationRoom}
                      onChange={(e) => setEditDestinationRoom(e.target.value)}
                      placeholder="Ruang tujuan"
                      list={roomMaster.length ? 'roomMasterList' : undefined}
                    />
                    <input className="input" value={editVisitorCardNo} onChange={(e) => setEditVisitorCardNo(e.target.value)} placeholder="No kartu penunggu" />
                  </>
                ) : (
                  <>
                    <input className="input" value={editInstansi} onChange={(e) => setEditInstansi(e.target.value)} placeholder="Instansi" />
                    <input className="input" value={editPurpose} onChange={(e) => setEditPurpose(e.target.value)} placeholder="Divisi tujuan" />
                    <input className="input" value={editMeet} onChange={(e) => setEditMeet(e.target.value)} placeholder="Ditemui" />
                  </>
                )}
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
      {roomMaster.length > 0 && (
        <datalist id="roomMasterList">
          {roomMaster.map((r) => (
            <option key={r.id} value={r.name} />
          ))}
        </datalist>
      )}
    </section>
  )
}
