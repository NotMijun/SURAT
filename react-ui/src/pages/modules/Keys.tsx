import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { apiGet, apiGetBlob, apiPatch, apiPost, apiPostForm } from '../../lib/api'
import type { AttachmentItem, KeyMasterItem, KeyTx, Me } from '../../types'
import { compressImageFile } from '../../lib/image'
import { fmtDateTime, fmtTime, nowHm, shiftHm, toIsoLocal, toYmd } from '../../lib/time'
import { useConfirm, useToast } from '../../components/ToastHost'
import LoadingScreen from '../../components/LoadingScreen'

const badge = (s: KeyTx['status']) => {
  if (s === 'closed') return <span className="badge badge-ok">Diambil</span>
  if (s === 'void') return <span className="badge badge-danger">Deleted</span>
  return <span className="badge badge-warn">Dititipkan</span>
}

export default function KeysPage({ me }: { me: Me }) {
  const toast = useToast()
  const confirm = useConfirm()
  const today = useMemo(() => toYmd(new Date()), [])
  const draftKey = useMemo(() => `draft:keys:${me.user.id}`, [me.user.id])
  const [q, setQ] = useState('')
  const [date, setDate] = useState(today)
  const [formDate, setFormDate] = useState(today)
  const [sort, setSort] = useState<'checkout_desc' | 'checkout_asc' | 'checkin_desc' | 'checkin_asc'>('checkout_desc')
  const [limit, setLimit] = useState(200)
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState<KeyTx[]>([])
  const [closed, setClosed] = useState<KeyTx[]>([])
  const [openOffset, setOpenOffset] = useState(0)
  const [closedOffset, setClosedOffset] = useState(0)
  const [openHasMore, setOpenHasMore] = useState(false)
  const [closedHasMore, setClosedHasMore] = useState(false)
  const [loadingMoreOpen, setLoadingMoreOpen] = useState(false)
  const [loadingMoreClosed, setLoadingMoreClosed] = useState(false)
  const [editRow, setEditRow] = useState<KeyTx | null>(null)
  const [editBorrower, setEditBorrower] = useState('')
  const [editUnit, setEditUnit] = useState('')
  const [editKeyName, setEditKeyName] = useState('')
  const [editNotes, setEditNotes] = useState('')
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
  const [photos, setPhotos] = useState<Array<{ file: File; kind: string; previewUrl: string }>>([])
  const [photoKey, setPhotoKey] = useState(0)
  const [attachments, setAttachments] = useState<AttachmentItem[]>([])
  const [activeAttachment, setActiveAttachment] = useState<AttachmentItem | null>(null)
  const [photoView, setPhotoView] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState<string>('')
  const photoModalRef = useRef<HTMLDivElement | null>(null)
  const editModalRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (me.user.role === 'admin') {
      apiGet<{items: any[]}>('/api/guards').then(res => setGuards(res.items || [])).catch(() => {})
    }
  }, [me.user.role])

  useEffect(() => {
    if (!photoView) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const modalEl = photoModalRef.current
    const doClose = () => {
      if (photoView) URL.revokeObjectURL(photoView)
      setPhotoView(null)
      setAttachments([])
      setActiveAttachment(null)
    }
    const focusables = () =>
      Array.from(
        (modalEl || document).querySelectorAll<HTMLElement>(
          'a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute('disabled') && el.tabIndex !== -1)
    window.setTimeout(() => {
      const first = focusables()[0]
      first?.focus()
    }, 0)
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        doClose()
        return
      }
      if (e.key !== 'Tab') return
      const list = focusables()
      if (!list.length) return
      const first = list[0]
      const last = list[list.length - 1]
      const active = document.activeElement as HTMLElement | null
      if (e.shiftKey) {
        if (!active || active === first || !modalEl?.contains(active)) {
          e.preventDefault()
          last.focus()
        }
      } else {
        if (!active || active === last || !modalEl?.contains(active)) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true } as any)
      previous?.focus()
    }
  }, [photoView])

  useEffect(() => {
    if (!editRow) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const modalEl = editModalRef.current
    const focusables = () =>
      Array.from(
        (modalEl || document).querySelectorAll<HTMLElement>(
          'a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute('disabled') && el.tabIndex !== -1)
    window.setTimeout(() => {
      const first = focusables()[0]
      first?.focus()
    }, 0)
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setEditRow(null)
        return
      }
      if (e.key !== 'Tab') return
      const list = focusables()
      if (!list.length) return
      const first = list[0]
      const last = list[list.length - 1]
      const active = document.activeElement as HTMLElement | null
      if (e.shiftKey) {
        if (!active || active === first || !modalEl?.contains(active)) {
          e.preventDefault()
          last.focus()
        }
      } else {
        if (!active || active === last || !modalEl?.contains(active)) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true } as any)
      previous?.focus()
    }
  }, [editRow])

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
          `/api/keys?status=open&q=${encodeURIComponent(q)}&date=${encodeURIComponent(date)}&date_field=checkout&sort=${encodeURIComponent(sort)}&limit=${encodeURIComponent(String(limit))}&offset=0`,
        ),
        apiGet<{ items: KeyTx[] }>(
          `/api/keys?status=closed&q=${encodeURIComponent(q)}&date=${encodeURIComponent(date)}&date_field=${encodeURIComponent(closedDateField)}&sort=${encodeURIComponent(sort)}&limit=${encodeURIComponent(String(limit))}&offset=0`,
        ),
      ])
      const openItems = a.items || []
      const closedItems = b.items || []
      setOpen(openItems)
      setClosed(closedItems)
      setOpenOffset(openItems.length)
      setClosedOffset(closedItems.length)
      setOpenHasMore(openItems.length >= limit)
      setClosedHasMore(closedItems.length >= limit)
    } catch (err: any) {
      toast.push(String(err?.message || err || 'Gagal memuat data kunci'), 'error')
    } finally {
      setLoading(false)
    }
  }, [toast])

  const loadMoreOpen = useCallback(async () => {
    setLoadingMoreOpen(true)
    try {
      const res = await apiGet<{ items: KeyTx[] }>(
        `/api/keys?status=open&q=${encodeURIComponent(q)}&date=${encodeURIComponent(date)}&date_field=checkout&sort=${encodeURIComponent(sort)}&limit=${encodeURIComponent(String(limit))}&offset=${encodeURIComponent(String(openOffset))}`,
      )
      const next = res.items || []
      setOpenHasMore(next.length >= limit)
      setOpen((prev) => prev.concat(next))
      setOpenOffset((prev) => prev + next.length)
    } catch (err: any) {
      toast.push(String(err?.message || err || 'Gagal memuat data kunci'), 'error')
    } finally {
      setLoadingMoreOpen(false)
    }
  }, [date, limit, openOffset, q, sort, toast])

  const loadMoreClosed = useCallback(async (closedDateField: 'checkout' | 'checkin') => {
    setLoadingMoreClosed(true)
    try {
      const res = await apiGet<{ items: KeyTx[] }>(
        `/api/keys?status=closed&q=${encodeURIComponent(q)}&date=${encodeURIComponent(date)}&date_field=${encodeURIComponent(closedDateField)}&sort=${encodeURIComponent(sort)}&limit=${encodeURIComponent(String(limit))}&offset=${encodeURIComponent(String(closedOffset))}`,
      )
      const next = res.items || []
      setClosedHasMore(next.length >= limit)
      setClosed((prev) => prev.concat(next))
      setClosedOffset((prev) => prev + next.length)
    } catch (err: any) {
      toast.push(String(err?.message || err || 'Gagal memuat data kunci'), 'error')
    } finally {
      setLoadingMoreClosed(false)
    }
  }, [closedOffset, date, limit, q, sort, toast])

  useEffect(() => {
    const t = window.setTimeout(() => {
      const closedDateField = date === today && filterBy === 'ambil' ? 'checkin' : 'checkout'
      refresh({ q, date, sort, limit, closedDateField }).catch(() => {})
    }, 250)
    return () => window.clearTimeout(t)
  }, [date, limit, q, refresh, sort, filterBy, today])

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
        checkout_at: toIsoLocal(formDate, time),
        notes,
        petugas_id: parseInt(petugasId, 10),
      }
      let createdId: number | null = null
      try {
        const res = await apiPost<{ ok: boolean; id: number }>('/api/keys', payload)
        createdId = res.id
      } catch (err: any) {
        const msg = String(err?.message || err || '')
        const ok = await confirm.confirm({ title: 'Konfirmasi Simpan', message: `${msg}\n\nTetap simpan?`, confirmText: 'Tetap Simpan' })
        if (!ok) throw err
        const res = await apiPost<{ ok: boolean; id: number }>('/api/keys', { ...payload, force: true })
        createdId = res.id
      }
      if (createdId && photos.length > 0) {
        try {
          const form = new FormData()
          for (const p of photos) {
            form.append('photos', p.file, p.file.name)
            form.append('kind', p.kind)
          }
          await apiPostForm(`/api/attachments/key_transactions/${createdId}`, form)
        } catch (err: any) {
          toast.push(`Data tersimpan, tapi upload foto gagal: ${String(err?.message || err || '')}`, 'error')
        }
      }
      setBorrower('')
      setUnit('')
      setKeyName('')
      setNotes('')
      for (const p of photos) URL.revokeObjectURL(p.previewUrl)
      setPhotos([])
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
    const ok = await confirm.confirm({
      title: 'Ambil Kunci',
      message: `Tandai kunci sudah diambil?\n\n${r.borrower_name} · ${r.key_name}\nTitip: ${fmtDateTime(r.checkout_at)}\n\nLanjutkan?`,
      confirmText: 'Tandai Diambil',
    })
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
    const ok = await confirm.confirm({ title: 'Delete Penitipan', message: 'Hapus data penitipan ini secara permanen? Tindakan ini tidak bisa dibatalkan.', confirmText: 'Delete', cancelText: 'Batal' })
    if (!ok) return
    try {
      await apiPost(`/api/keys/${id}/undo`, {})
      toast.push('Penitipan kunci dihapus', 'success')
      const closedDateField = date === today && filterBy === 'ambil' ? 'checkin' : 'checkout'
      await refresh({ q, date, sort, limit, closedDateField })
    } catch (err: any) {
      toast.push(String(err?.message || err || 'Gagal membatalkan'), 'error')
    }
  }

  const doVoid = async (r: KeyTx) => {
    const ok = await confirm.confirm({ title: 'Delete Transaksi', message: 'Hapus transaksi ini secara permanen? Tindakan ini tidak bisa dibatalkan.', confirmText: 'Delete', cancelText: 'Batal' })
    if (!ok) return
    try {
      await apiPost(`/api/keys/${r.id}/delete`, {})
      toast.push('Transaksi dihapus', 'success')
      const closedDateField = date === today && filterBy === 'ambil' ? 'checkin' : 'checkout'
      await refresh({ q, date, sort, limit, closedDateField })
    } catch (err: any) {
      toast.push(String(err?.message || err || 'Gagal delete transaksi'), 'error')
    }
  }

  const canCorrect = (r: KeyTx) => me.user.role === 'admin' || me.user.role === 'supervisor' || (typeof r.created_by === 'number' && r.created_by === me.user.id)

  const openEdit = (r: KeyTx) => {
    setEditRow(r)
    setEditBorrower(r.borrower_name || '')
    setEditUnit(r.unit || '')
    setEditKeyName(r.key_name || '')
    setEditNotes(r.notes || '')
  }

  const saveEdit = async () => {
    if (!editRow) return
    try {
      await apiPatch(`/api/keys/${editRow.id}`, { borrower_name: editBorrower, unit: editUnit, key_name: editKeyName, notes: editNotes })
      toast.push('Transaksi diperbarui', 'success')
      const closedDateField = date === today && filterBy === 'ambil' ? 'checkin' : 'checkout'
      await refresh({ q, date, sort, limit, closedDateField })
      setEditRow(null)
    } catch (err: any) {
      toast.push(String(err?.message || err || 'Gagal edit transaksi'), 'error')
    }
  }

  const doReopen = async (r: KeyTx) => {
    const ok = await confirm.confirm({
      title: 'Batal Ambil',
      message: `Batal ambil kunci ini (kembali status dipinjam)?\n\n${r.borrower_name} · ${r.key_name}\nTitip: ${fmtDateTime(r.checkout_at)}\nAmbil: ${fmtDateTime(r.checkin_at || '')}\n\nLanjutkan?`,
      confirmText: 'Batal Ambil',
    })
    if (!ok) return
    try {
      await apiPost(`/api/keys/${r.id}/reopen`, {})
      toast.push('Status dikembalikan ke dipinjam', 'success')
      const closedDateField = date === today && filterBy === 'ambil' ? 'checkin' : 'checkout'
      await refresh({ q, date, sort, limit, closedDateField })
    } catch (err: any) {
      toast.push(String(err?.message || err || 'Gagal membatalkan ambil'), 'error')
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

  const openKeyPhotos = useCallback(async (r: KeyTx) => {
    try {
      const res = await apiGet<{ items: AttachmentItem[] }>(`/api/attachments/key_transactions/${r.id}`)
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
      <div className="section-header">
        <h2 className="h2">Penitipan Kunci</h2>
        <div className="section-actions">
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
                Nama
              </label>
              <input className="input" id="keyBorrower" value={borrower} onChange={(e) => setBorrower(e.target.value)} placeholder="Instansi / Nama penitip" />
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
                Waktu Titip
              </label>
              <div className="time-row">
                <input className="input" type="date" value={formDate} onChange={(e) => setFormDate(e.target.value)} style={{ width: 'auto' }} />
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
              <div className="muted">Akan tersimpan: {fmtDateTime(toIsoLocal(formDate, time))}</div>
            </div>
            <div className="field grid-span-4">
              <label className="label" htmlFor="keyNotes">
                Catatan
              </label>
              <input className="input" id="keyNotes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="opsional" />
            </div>
            <div className="field grid-span-4">
              <label className="label" htmlFor="keyPhoto">
                Lampiran foto (opsional)
              </label>
              <input
                key={photoKey}
                className="input"
                id="keyPhoto"
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
            <div className="sticky-actions grid-span-4">
              <div className="row row-right">
                <button
                  className="button button-secondary"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    ;(async () => {
                      const ok = await confirm.confirm({ title: 'Reset Draft', message: 'Hapus draft penitipan kunci?', confirmText: 'Hapus' })
                      if (!ok) return
                      localStorage.removeItem(draftKey)
                      setFormError('')
                      setBorrower('')
                      setUnit('')
                      setKeyName('')
                      setNotes('')
                      setTime(nowHm())
                      setPetugasId(String(me.user.id))
                      for (const p of photos) URL.revokeObjectURL(p.previewUrl)
                      setPhotos([])
                      setPhotoKey((x) => x + 1)
                    })().catch(() => {})
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
                    {r.borrower_name} · {r.key_name}
                  </div>
                  <div className="list-meta">
                    {fmtTime(r.checkout_at)} · {r.status === 'open' ? 'dititipkan' : r.status === 'closed' ? `diambil ${r.checkin_at ? fmtTime(r.checkin_at) : ''}` : 'deleted'}
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
            {loading && <LoadingScreen mode="inline" label="Loading..." minHeight={280} />}
            <div className="table-wrap" aria-hidden={loading}>
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
                    <tr key={r.id} className="table-row-active">
                      <td data-label="Nama">{r.borrower_name}</td>
                      <td data-label="Ruangan">{r.key_name}</td>
                      <td data-label="Titip">{fmtDateTime(r.checkout_at)}</td>
                      <td data-label="Petugas">{petugasName(r)}</td>
                      <td data-label="Status">{badge(r.status)}</td>
                      <td data-label="Foto">
                        {r.has_photo && r.photo_url ? (
                          <button className="button button-sm button-secondary" type="button" onClick={() => openKeyPhotos(r)}>
                            {typeof r.photo_count === 'number' && r.photo_count > 1 ? `Foto (${r.photo_count})` : 'Foto'}
                          </button>
                        ) : (
                          <span className="muted">-</span>
                        )}
                      </td>
                      <td data-label="Aksi">
                        <div className="row" style={{ flexWrap: 'wrap' }}>
                          <button className="button button-sm button-primary" type="button" onClick={() => doReturn(r)}>
                            ↗ Ambil
                          </button>
                          {canCorrect(r) ? (
                            <button className="button button-sm button-secondary" type="button" onClick={() => openEdit(r)}>
                              ✎ Edit
                            </button>
                          ) : null}
                          {canCorrect(r) ? (
                            <button className="button button-sm button-danger" type="button" onClick={() => doUndo(r.id)}>
                              Delete
                            </button>
                          ) : null}
                        </div>
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
            {openHasMore && (
              <div className="row row-right" style={{ marginTop: 12 }}>
                <button className="button button-secondary" type="button" disabled={loading || loadingMoreOpen} onClick={loadMoreOpen}>
                  {loadingMoreOpen ? 'Memuat...' : 'Muat lebih banyak'}
                </button>
              </div>
            )}
          </div>
        </section>

        <section className="card">
          <header className="card-header">
            <div className="card-title">Riwayat (closed)</div>
            <div className="muted">{loading ? 'Memuat...' : `${closedView.length} entri`}</div>
          </header>
          <div className="card-body">
            {loading && <LoadingScreen mode="inline" label="Loading..." minHeight={280} />}
            <div className="table-footer-filters">
              <div className="filter-group">
                <label className="label-sm">Cari</label>
                <input className="input input-sm" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Cari nama, kunci, jam..." />
              </div>
              <div className="filter-group">
                <label className="label-sm">Tanggal</label>
                <input className="input input-sm" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </div>
              <div className="filter-group">
                <label className="label-sm">Urutan</label>
                <select className="select select-sm" value={sort} onChange={(e) => setSort(e.target.value as any)}>
                  <option value="checkout_desc">Titip terbaru</option>
                  <option value="checkout_asc">Titip terlama</option>
                  <option value="checkin_desc">Ambil terbaru</option>
                  <option value="checkin_asc">Ambil terlama</option>
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
              {date === today && (
                <>
                  <div className="filter-group">
                    <label className="label-sm">Filter Jam</label>
                    <select className="select select-sm" value={filterBy} onChange={(e) => setFilterBy(e.target.value as any)}>
                      <option value="titip">Jam titip</option>
                      <option value="ambil">Jam ambil</option>
                    </select>
                  </div>
                  <div className="filter-group">
                    <label className="label-sm">Dari</label>
                    <input className="input input-sm" type="time" value={fromHm} onChange={(e) => setFromHm(e.target.value)} />
                  </div>
                  <div className="filter-group">
                    <label className="label-sm">Sampai</label>
                    <input className="input input-sm" type="time" value={toHm} onChange={(e) => setToHm(e.target.value)} />
                  </div>
                </>
              )}
              <div className="filter-actions">
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
                      [['Instansi', 'Unit', 'Ruangan/Kunci', 'Jam titip', 'Jam ambil', 'Catatan', 'Foto', 'Petugas', 'Status']].concat(
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
              </div>
            </div>
            <div className="table-wrap" aria-hidden={loading}>
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
                  {closedView.map((r) => (
                    <tr key={r.id} className={r.status === 'void' ? 'table-row-void' : undefined}>
                      <td data-label="Nama">{r.borrower_name}</td>
                      <td data-label="Ruangan">{r.key_name}</td>
                      <td data-label="Titip">{fmtDateTime(r.checkout_at)}</td>
                      <td data-label="Ambil">{fmtDateTime(r.checkin_at || '')}</td>
                      <td data-label="Status">
                        {badge(r.status)}
                        {r.status === 'void' ? <div className="muted">Deleted</div> : null}
                      </td>
                      <td data-label="Foto">
                        {r.has_photo && r.photo_url ? (
                          <button className="button button-sm button-secondary" type="button" onClick={() => openKeyPhotos(r)}>
                            {typeof r.photo_count === 'number' && r.photo_count > 1 ? `Foto (${r.photo_count})` : 'Foto'}
                          </button>
                        ) : (
                          <span className="muted">-</span>
                        )}
                      </td>
                      <td data-label="Aksi">
                        {r.status === 'void' ? (
                          <span className="muted">—</span>
                        ) : (
                          <div className="row" style={{ flexWrap: 'wrap' }}>
                            {r.status === 'closed' ? (
                            <button className="button button-sm button-secondary" type="button" onClick={() => doReopen(r)}>
                              ↩ Batal ambil
                            </button>
                          ) : null}
                            {canCorrect(r) ? (
                              <button className="button button-sm button-secondary" type="button" onClick={() => openEdit(r)}>
                                ✎ Edit
                              </button>
                            ) : null}
                            {canCorrect(r) ? (
                              <button className="button button-sm button-danger" type="button" onClick={() => doVoid(r)}>
                                Delete
                              </button>
                            ) : null}
                          </div>
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
            {closedHasMore && (
              <div className="row row-right" style={{ marginTop: 12 }}>
                <button
                  className="button button-secondary"
                  type="button"
                  disabled={loading || loadingMoreClosed}
                  onClick={() => loadMoreClosed(date === today && filterBy === 'ambil' ? 'checkin' : 'checkout')}
                >
                  {loadingMoreClosed ? 'Memuat...' : 'Muat lebih banyak'}
                </button>
              </div>
            )}
          </div>
        </section>
      </div>

      {photoView && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Foto" onClick={(e) => e.currentTarget === e.target && closePhoto()}>
          <div className="modal" ref={photoModalRef}>
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
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Edit transaksi kunci" onClick={(e) => (e.currentTarget === e.target ? setEditRow(null) : null)}>
          <div className="modal" ref={editModalRef}>
            <div className="modal-header">
              <div className="modal-title">Edit Transaksi</div>
              <button className="button button-secondary button-sm" type="button" onClick={() => setEditRow(null)}>
                Tutup
              </button>
            </div>
            <div className="modal-body">
              <div className="grid" style={{ gap: 10 }}>
                <input className="input" value={editBorrower} onChange={(e) => setEditBorrower(e.target.value)} placeholder="Nama penitip" />
                <input className="input" value={editUnit} onChange={(e) => setEditUnit(e.target.value)} placeholder="Unit/Divisi" />
                <input className="input" value={editKeyName} onChange={(e) => setEditKeyName(e.target.value)} placeholder="Ruangan/Kunci" />
                <input className="input" value={editNotes} onChange={(e) => setEditNotes(e.target.value)} placeholder="Catatan" />
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

      <button className="fab" type="button" onClick={() => document.getElementById('keysForm')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
        + Titip
      </button>
    </section>
  )
}
