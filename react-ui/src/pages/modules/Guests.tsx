import { FormEvent, type KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useLocation } from 'react-router-dom'
import { apiGet, apiGetBlob, apiPatch, apiPost, apiPostForm } from '../../lib/api'
import type { AttachmentItem, GuestEntry, Me } from '../../types'
import { compressImageFile } from '../../lib/image'
import { fmtDateTime, fmtTime, nowHm, shiftHm, toIsoLocal, toYmd } from '../../lib/time'
import { useConfirm, useToast } from '../../components/ToastHost'
import Modal from '../../components/Modal'
import PhotoModal from '../../components/PhotoModal'
import Pagination from '../../components/Pagination'
import Avatar from '../../components/Avatar'

export default function GuestsPage({ me }: { me: Me }) {
  const toast = useToast()
  const confirm = useConfirm()
  const location = useLocation()
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
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [editRow, setEditRow] = useState<GuestEntry | null>(null)
  const [detailRow, setDetailRow] = useState<GuestEntry | null>(null)
  const [editName, setEditName] = useState('')
  const [editInstansi, setEditInstansi] = useState('')
  const [editPurpose, setEditPurpose] = useState('')
  const [editMeet, setEditMeet] = useState('')
  const [editNotes, setEditNotes] = useState('')
  const [editDestinationRoom, setEditDestinationRoom] = useState('')
  const [editVisitorCardNo, setEditVisitorCardNo] = useState('')
  const [editParaf, setEditParaf] = useState('')

  const [name, setName] = useState('')
  const [instansi, setInstansi] = useState('')
  const [purpose, setPurpose] = useState('')
  const [meet, setMeet] = useState('')
  const [time, setTime] = useState(nowHm())
  const [notes, setNotes] = useState('')
  const [destinationRoom, setDestinationRoom] = useState('')
  const [visitorCardNo, setVisitorCardNo] = useState('')
  const [paraf, setParaf] = useState('')
  const [photos, setPhotos] = useState<Array<{ file: File; kind: string; previewUrl: string }>>([])
  const [photoKey, setPhotoKey] = useState(0)
  const [attachments, setAttachments] = useState<AttachmentItem[]>([])
  const [activeAttachment, setActiveAttachment] = useState<AttachmentItem | null>(null)
  const [photoView, setPhotoView] = useState<string | null>(null)
  const [filtersSheetOpen, setFiltersSheetOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState<string>('')

  const didInitFromUrlRef = useRef(false)
  useEffect(() => {
    if (didInitFromUrlRef.current) return
    didInitFromUrlRef.current = true
    const qp = new URLSearchParams(location.search).get('q')
    if (qp && qp.trim()) setQ(qp)
  }, [location.search])

  type HeaderMenuKey = null | 'nama' | 'tujuan' | 'masuk' | 'petugas' | 'status'
  const [headerMenu, setHeaderMenu] = useState<HeaderMenuKey>(null)
  const headerMenuRef = useRef<HTMLDivElement | null>(null)
  const [headerMenuAnchorEl, setHeaderMenuAnchorEl] = useState<HTMLElement | null>(null)
  const [headerMenuAnchorRect, setHeaderMenuAnchorRect] = useState<{ top: number; right: number; bottom: number; left: number } | null>(null)
  const [headerMenuPos, setHeaderMenuPos] = useState<{ top: number; left: number } | null>(null)

  const [filterNama, setFilterNama] = useState('')
  const [filterTujuan, setFilterTujuan] = useState<string[]>([])
  const [filterPetugas, setFilterPetugas] = useState<string[]>([])
  const [filterStatus, setFilterStatus] = useState<Array<GuestEntry['status']>>([])
  const [masukDateFrom, setMasukDateFrom] = useState('')
  const [masukDateTo, setMasukDateTo] = useState('')
  const [fromHm, setFromHm] = useState('')
  const [toHm, setToHm] = useState('')
  const [petugasSearch, setPetugasSearch] = useState('')
  const [tujuanSearch, setTujuanSearch] = useState('')
  const [clientSort, setClientSort] = useState<{ key: 'nama' | 'tujuan' | 'petugas' | 'status' | null; dir: 'asc' | 'desc' }>({ key: null, dir: 'asc' })

  const closeHeaderMenu = useCallback(() => {
    setHeaderMenu(null)
    setHeaderMenuAnchorEl(null)
    setHeaderMenuAnchorRect(null)
    setHeaderMenuPos(null)
  }, [])

  const openHeaderMenu = useCallback(
    (key: Exclude<HeaderMenuKey, null>, anchorEl: HTMLElement) => {
      if (headerMenu === key) {
        closeHeaderMenu()
        return
      }
      const r = anchorEl.getBoundingClientRect()
      setHeaderMenu(key)
      setHeaderMenuAnchorEl(anchorEl)
      setHeaderMenuAnchorRect({ top: r.top, right: r.right, bottom: r.bottom, left: r.left })
      setHeaderMenuPos({ top: r.bottom + 8, left: r.left })
    },
    [closeHeaderMenu, headerMenu],
  )

  useEffect(() => {
    if (!headerMenu) return
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null
      const el = headerMenuRef.current
      if (el && target && el.contains(target)) return
      const anchor = headerMenuAnchorEl
      if (anchor && target && anchor.contains(target)) return
      closeHeaderMenu()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeHeaderMenu()
    }
    const onScroll = () => closeHeaderMenu()
    document.addEventListener('mousedown', onDown, { capture: true })
    window.addEventListener('keydown', onKey, { capture: true })
    document.addEventListener('scroll', onScroll, { capture: true })
    window.addEventListener('resize', onScroll)
    return () => {
      document.removeEventListener('mousedown', onDown, { capture: true } as any)
      window.removeEventListener('keydown', onKey, { capture: true } as any)
      document.removeEventListener('scroll', onScroll, { capture: true } as any)
      window.removeEventListener('resize', onScroll as any)
    }
  }, [closeHeaderMenu, headerMenu, headerMenuAnchorEl])

  useEffect(() => {
    if (!headerMenu || !headerMenuAnchorRect) return
    const el = headerMenuRef.current
    if (!el) return
    const pad = 10
    const menuRect = el.getBoundingClientRect()
    let top = headerMenuPos?.top ?? headerMenuAnchorRect.bottom + 8
    let left = headerMenuPos?.left ?? headerMenuAnchorRect.left
    if (left + menuRect.width > window.innerWidth - pad) left = Math.max(pad, window.innerWidth - pad - menuRect.width)
    if (left < pad) left = pad
    if (top + menuRect.height > window.innerHeight - pad) {
      const above = headerMenuAnchorRect.top - 8 - menuRect.height
      if (above >= pad) top = above
    }
    if (top < pad) top = pad
    if (!headerMenuPos || top !== headerMenuPos.top || left !== headerMenuPos.left) setHeaderMenuPos({ top, left })
  }, [headerMenu, headerMenuAnchorRect, headerMenuPos])

  const toggleInList = (prev: string[], value: string) => {
    const v = String(value || '').trim()
    if (!v) return prev
    return prev.includes(v) ? prev.filter((x) => x !== v) : prev.concat(v)
  }

  const getHeaderMenuFocusables = (root: HTMLElement) => {
    const list = Array.from(
      root.querySelectorAll<HTMLElement>('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])'),
    ).filter((el) => {
      const disabled = (el as any).disabled || el.getAttribute('aria-disabled') === 'true'
      if (disabled) return false
      if ((el as HTMLInputElement).type === 'hidden') return false
      if (el.getAttribute('tabindex') === '-1') return false
      return true
    })
    return list
  }

  const onHeaderMenuKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
      const root = headerMenuRef.current
      if (!root) return
      const focusables = getHeaderMenuFocusables(root)
      if (focusables.length === 0) return
      e.preventDefault()
      const active = document.activeElement as HTMLElement | null
      const idx = active ? focusables.indexOf(active) : -1
      const nextIdx =
        e.key === 'Home'
          ? 0
          : e.key === 'End'
            ? focusables.length - 1
            : e.key === 'ArrowUp'
              ? (idx <= 0 ? focusables.length - 1 : idx - 1)
              : (idx >= focusables.length - 1 ? 0 : idx + 1)
      focusables[nextIdx]?.focus()
    }
  }

  useEffect(() => {
    if (!headerMenu) return
    const t = window.requestAnimationFrame(() => {
      const root = headerMenuRef.current
      if (!root) return
      const preferred = root.querySelector<HTMLElement>('[data-autofocus="true"]')
      if (preferred) {
        preferred.focus()
        return
      }
      const focusables = getHeaderMenuFocusables(root)
      focusables[0]?.focus()
    })
    return () => window.cancelAnimationFrame(t)
  }, [headerMenu])

  const hmToMinutes = (v: string) => {
    const s = String(v || '').trim()
    if (!s) return null
    const m = /^(\d{1,2}):(\d{2})$/.exec(s)
    if (!m) return null
    const hh = Math.max(0, Math.min(23, parseInt(m[1], 10)))
    const mm = Math.max(0, Math.min(59, parseInt(m[2], 10)))
    return hh * 60 + mm
  }

  const isoToTs = (iso: string) => {
    const t = Date.parse(String(iso || ''))
    return Number.isFinite(t) ? t : null
  }

  const refresh = useCallback(async (opts: { q: string; date: string; sort: string; limit: number; post: string; status: string; offset: number }) => {
    const { q, date, sort, limit, post, status } = opts
    const nextOffset = Math.max(0, opts.offset || 0)
    setLoading(true)
    try {
      const res = await apiGet<{ items: GuestEntry[]; total: number }>(
        `/api/guests?status=${encodeURIComponent(status)}&q=${encodeURIComponent(q)}&date=${encodeURIComponent(date)}&sort=${encodeURIComponent(sort)}&limit=${encodeURIComponent(String(limit))}&post=${encodeURIComponent(post)}&offset=${encodeURIComponent(String(nextOffset))}`,
      )
      setItems(res.items || [])
      setTotal(typeof res.total === 'number' ? res.total : 0)
    } catch (err: any) {
      toast.push(String(err?.message || err || 'Gagal memuat tamu'), 'error')
    } finally {
      setLoading(false)
    }
  }, [toast])

  const photoTabs = useMemo(
    () =>
      (attachments || [])
        .filter((a) => a && typeof a.id === 'number')
        .map((a) => ({ id: a.id as number, label: a.kind || 'Foto' })),
    [attachments],
  )

  useEffect(() => {
    setPage(1)
  }, [date, limit, postFilter, q, sort, view])

  useEffect(() => {
    const status = view === 'inhouse' ? 'in' : 'all'
    const effectiveDate = view === 'inhouse' ? '' : date
    const effectiveSort = view === 'inhouse' ? 'checkin_asc' : sort
    const offset = Math.max(0, (page - 1) * limit)
    const t = window.setTimeout(
      () => refresh({ q, date: effectiveDate, sort: effectiveSort, limit, post: postFilter, status, offset }).catch(() => {}),
      250,
    )
    return () => window.clearTimeout(t)
  }, [date, limit, page, q, refresh, sort, postFilter, view])

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
      if (typeof d.paraf === 'string') setParaf(d.paraf)
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
      const payload = { name, instansi, purpose, meet, destinationRoom, visitorCardNo, paraf, time, notes }
      localStorage.setItem(draftKey, JSON.stringify(payload))
    }, 300)
    return () => window.clearTimeout(t)
  }, [draftKey, destinationRoom, instansi, meet, name, notes, paraf, purpose, time, visitorCardNo])

  const downloadCsv = (filename: string, rows: Array<Array<string | number>>) => {
    const sep = ';'
    const lines = rows.map((r) => r.map((x) => `"${String(x ?? '').replace(/"/g, '""')}"`).join(sep))
    const csv = `\ufeffsep=${sep}\n${lines.join('\n')}`
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
        payload.paraf = paraf
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
      setParaf('')
      for (const p of photos) URL.revokeObjectURL(p.previewUrl)
      setPhotos([])
      setPhotoKey((x) => x + 1)
      localStorage.removeItem(draftKey)
      toast.push('Tamu masuk dicatat', 'success')
      const status = view === 'inhouse' ? 'in' : 'all'
      const effectiveDate = view === 'inhouse' ? '' : date
      const effectiveSort = view === 'inhouse' ? 'checkin_asc' : sort
      setPage(1)
      await refresh({ q, date: effectiveDate, sort: effectiveSort, limit, post: postFilter, status, offset: 0 })
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
    setEditParaf(String(r.paraf || ''))
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
        patch.paraf = editParaf
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
                paraf: editRow.post === 'Pintu Utama' || editRow.post === 'Lobby' ? x.paraf : editParaf,
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

  const deleteGuest = async (r: GuestEntry) => {
    const ok = await confirm.confirm({ title: 'Delete Tamu', message: 'Hapus data tamu ini secara permanen? Tindakan ini tidak bisa dibatalkan.', confirmText: 'Delete', cancelText: 'Batal' })
    if (!ok) return
    try {
      await apiPost(`/api/guests/${r.id}/delete`, {})
      toast.push('Tamu dihapus', 'success')
      setItems((prev) => prev.filter((x) => x.id !== r.id))
    } catch (err: any) {
      toast.push(String(err?.message || err || 'Gagal delete tamu'), 'error')
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
      await refresh({ q, date: effectiveDate, sort: effectiveSort, limit, post: postFilter, status, offset: Math.max(0, (page - 1) * limit) })
    } catch (err: any) {
      toast.push(String(err?.message || err || 'Gagal memproses'), 'error')
    }
  }

  const closePhoto = () => {
    if (photoView && photoView.startsWith('blob:')) URL.revokeObjectURL(photoView)
    setPhotoView(null)
    setAttachments([])
    setActiveAttachment(null)
  }

  const loadPhotoUrl = useCallback(async (url: string) => {
    const blob = await apiGetBlob(url)
    if (photoView && photoView.startsWith('blob:')) URL.revokeObjectURL(photoView)
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
      if (r.photo_url) {
        try {
          await loadPhotoUrl(r.photo_url)
          return
        } catch {}
      }
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

  const tujuanText = useCallback(
    (r: GuestEntry) => {
      if (r.post === 'Pintu Utama' || r.post === 'Lobby') return String(r.destination_room || '-')
      if (postFilter === 'IGD') return [r.purpose || '-', r.meet_person || '', r.notes || ''].filter((x) => String(x || '').trim()).join(' · ')
      return String(r.purpose || '-')
    },
    [postFilter],
  )

  const uniqueTujuan = useMemo(() => {
    const s = new Set<string>()
    for (const r of items) {
      const t = String(tujuanText(r) || '').trim()
      if (t && t !== '-') s.add(t)
    }
    return Array.from(s).sort((a, b) => a.localeCompare(b))
  }, [items, tujuanText])

  const uniquePetugas = useMemo(() => {
    const s = new Set<string>()
    for (const r of items) {
      const nm = String(r.created_by_name || '').trim()
      if (nm && nm !== '-') s.add(nm)
    }
    return Array.from(s).sort((a, b) => a.localeCompare(b))
  }, [items])

  const statusOptions = useMemo(
    () => [
      { value: 'in' as GuestEntry['status'], label: 'Inhouse', badge: <span className="badge badge-warn">Inhouse</span> },
      { value: 'out' as GuestEntry['status'], label: 'Checkout', badge: <span className="badge badge-ok">Checkout</span> },
      { value: 'void' as GuestEntry['status'], label: 'Deleted', badge: <span className="badge badge-danger">Deleted</span> },
    ],
    [],
  )

  const hasActiveFilters = useMemo(() => {
    return Boolean(filterNama.trim() || filterTujuan.length || filterPetugas.length || filterStatus.length || masukDateFrom || masukDateTo || fromHm || toHm || clientSort.key)
  }, [clientSort.key, filterNama, filterPetugas.length, filterStatus.length, filterTujuan.length, fromHm, masukDateFrom, masukDateTo, toHm])

  const resetAllHeaderFilters = () => {
    setFilterNama('')
    setFilterTujuan([])
    setFilterPetugas([])
    setFilterStatus([])
    setMasukDateFrom('')
    setMasukDateTo('')
    setFromHm('')
    setToHm('')
    setPetugasSearch('')
    setTujuanSearch('')
    setClientSort({ key: null, dir: 'asc' })
    closeHeaderMenu()
  }

  const applyClientFilters = useCallback(
    (rows: GuestEntry[]) => {
      const fNama = filterNama.trim().toLowerCase()
      const fTo = new Set(filterTujuan)
      const fPet = new Set(filterPetugas)
      const fStat = new Set(filterStatus)
      const dateFromTs = masukDateFrom ? Date.parse(`${masukDateFrom}T00:00:00`) : null
      const dateToTs = masukDateTo ? Date.parse(`${masukDateTo}T23:59:59`) : null
      const fromMin = hmToMinutes(fromHm)
      const toMin = hmToMinutes(toHm)

      let out = rows.filter((r) => {
        if (fNama) {
          const nm = String(r.name || '').toLowerCase()
          if (!nm.includes(fNama)) return false
        }
        if (fTo.size) {
          const t = String(tujuanText(r) || '').trim()
          if (!fTo.has(t)) return false
        }
        if (fPet.size) {
          const pn = String(r.created_by_name || '').trim() || '-'
          if (!fPet.has(pn)) return false
        }
        if (fStat.size) {
          if (!fStat.has(r.status)) return false
        }
        if (dateFromTs !== null || dateToTs !== null || fromMin !== null || toMin !== null) {
          const ts = isoToTs(String(r.checkin_at || ''))
          if (ts === null) return false
          if (dateFromTs !== null && ts < dateFromTs) return false
          if (dateToTs !== null && ts > dateToTs) return false
          if (fromMin !== null || toMin !== null) {
            const d = new Date(ts)
            const minutes = d.getHours() * 60 + d.getMinutes()
            if (fromMin !== null && minutes < fromMin) return false
            if (toMin !== null && minutes > toMin) return false
          }
        }
        return true
      })

      if (clientSort.key) {
        const dir = clientSort.dir === 'desc' ? -1 : 1
        out = out.slice().sort((a, b) => {
          const av =
            clientSort.key === 'nama'
              ? String(a.name || '')
              : clientSort.key === 'tujuan'
                ? String(tujuanText(a) || '')
                : clientSort.key === 'petugas'
                  ? String(a.created_by_name || '')
                  : String(a.status || '')
          const bv =
            clientSort.key === 'nama'
              ? String(b.name || '')
              : clientSort.key === 'tujuan'
                ? String(tujuanText(b) || '')
                : clientSort.key === 'petugas'
                  ? String(b.created_by_name || '')
                  : String(b.status || '')
          return av.localeCompare(bv) * dir
        })
      }

      return out
    },
    [clientSort.dir, clientSort.key, filterNama, filterPetugas, filterStatus, filterTujuan, fromHm, masukDateFrom, masukDateTo, tujuanText, toHm],
  )

  const viewItems = useMemo(() => applyClientFilters(items), [applyClientFilters, items])

  const filterSummary = useMemo(() => {
    const parts: string[] = []
    if (filterNama.trim()) parts.push(`Nama: ${filterNama.trim()}`)
    if (filterTujuan.length) parts.push(`Tujuan: ${filterTujuan.join(', ')}`)
    if (filterPetugas.length) parts.push(`Petugas: ${filterPetugas.join(', ')}`)
    if (filterStatus.length) parts.push(`Status: ${filterStatus.join(', ')}`)
    if (masukDateFrom || masukDateTo) parts.push(`Tanggal masuk: ${masukDateFrom || '...'} → ${masukDateTo || '...'}`)
    if (fromHm || toHm) parts.push(`Jam masuk: ${fromHm || '...'} → ${toHm || '...'}`)
    if (clientSort.key) {
      const lbl = clientSort.key === 'nama' ? 'Nama' : clientSort.key === 'tujuan' ? 'Tujuan' : clientSort.key === 'petugas' ? 'Petugas' : 'Status'
      parts.push(`Sort: ${lbl} ${clientSort.dir === 'desc' ? 'Z→A' : 'A→Z'}`)
    }
    return parts
  }, [clientSort.dir, clientSort.key, filterNama, filterPetugas, filterStatus, filterTujuan, fromHm, masukDateFrom, masukDateTo, toHm])

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
                  {postFilter === 'IGD' ? 'Asal/Instansi' : 'Instansi'}
                </label>
                <input className="input" id="guestInstansi" value={instansi} onChange={(e) => setInstansi(e.target.value)} placeholder="mis. Vendor" required />
              </div>
            )}
            <div className="field">
              <label className="label" htmlFor="guestPurpose">
                {postFilter === 'Pintu Utama' ? 'Ruang Tujuan' : postFilter === 'IGD' ? 'Tujuan' : 'Divisi Tujuan'}
              </label>
              <input
                className="input"
                id="guestPurpose"
                value={postFilter === 'Pintu Utama' ? destinationRoom : purpose}
                onChange={(e) => (postFilter === 'Pintu Utama' ? setDestinationRoom(e.target.value) : setPurpose(e.target.value))}
                placeholder={postFilter === 'Pintu Utama' ? 'mis. Ruang 204 / Anak / ICU' : postFilter === 'IGD' ? 'mis. Interview / Magang / MCU' : 'mis. IT / HRD'}
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
            {postFilter === 'IGD' && (
              <div className="field grid-span-2">
                <label className="label" htmlFor="guestParaf">
                  Paraf
                </label>
                <input className="input" id="guestParaf" value={paraf} onChange={(e) => setParaf(e.target.value)} placeholder="opsional" />
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
                      setParaf('')
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
                setPage(1)
              }}
            >
              Masih di dalam
            </button>
            <button
              className={`tab${view === 'riwayat' ? ' tab-active' : ''}`}
              type="button"
              onClick={() => {
                setView('riwayat')
                setPage(1)
              }}
            >
              Riwayat
            </button>
            <button className="button button-secondary button-sm section-filter-toggle" type="button" onClick={() => setFiltersSheetOpen(true)}>
              Filter
            </button>
          </div>
        </header>
        <div className="card-body filters-responsive">
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
                  setPage(1)
                  refresh({ q, date: effectiveDate, sort: effectiveSort, limit, post: postFilter, status, offset: 0 }).catch(() => {})
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
                      (postFilter === 'IGD'
                        ? [['No', 'Nama', 'Asal/Instansi', 'Tujuan', 'Masuk', 'Keluar', 'Paraf', 'Foto', 'Petugas', 'Status']].concat(
                            items.map((r, idx) => [
                              String(idx + 1),
                              r.name,
                              r.instansi,
                              [r.purpose || '-', r.meet_person || '', r.notes || ''].filter((x) => String(x || '').trim()).join(' · '),
                              fmtDateTime(r.checkin_at),
                              fmtDateTime(r.checkout_at),
                              r.paraf || '',
                              r.has_photo ? 'Ya' : 'Tidak',
                              r.created_by_name || '-',
                              r.status,
                            ]),
                          )
                        : [['Nama', 'Instansi', 'Tujuan', 'Kartu', 'Ditemui', 'Masuk', 'Keluar', 'Keperluan', 'Foto', 'Petugas', 'Status']].concat(
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
                            ]),
                          )),
                    )
                  }
                >
                  Export CSV
                </button>
              )}
            </div>
          </div>
          {hasActiveFilters && (
            <div className="table-active-filters">
              <div className="table-active-list">
                {filterSummary.map((x) => (
                  <span key={x} className="filter-chip">
                    {x}
                  </span>
                ))}
              </div>
              <button className="button button-secondary button-sm" type="button" onClick={resetAllHeaderFilters}>
                Reset semua filter
              </button>
            </div>
          )}
          <div className="table-wrap" aria-busy={loading}>
            <table className="table table-mobile-cards table-sticky">
              <thead>
                <tr>
                  {view === 'riwayat' && postFilter === 'IGD' && <th>No</th>}
                  <th className="th-col">
                    <div className="th-head">
                      <button
                        className="th-label"
                        type="button"
                        onClick={() => setClientSort((prev) => (prev.key === 'nama' ? { key: 'nama', dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key: 'nama', dir: 'asc' }))}
                      >
                        NAMA
                      </button>
                      <span className={`th-sort ${clientSort.key === 'nama' ? 'is-active' : ''}`}>{clientSort.key === 'nama' ? (clientSort.dir === 'asc' ? '▲' : '▼') : ''}</span>
                      <button className={`th-icon ${filterNama.trim() || clientSort.key === 'nama' ? 'is-active' : ''}`} type="button" aria-label="Filter Nama" onClick={(e) => openHeaderMenu('nama', e.currentTarget)}>
                        ⌄{filterNama.trim() || clientSort.key === 'nama' ? <span className="th-dot" /> : null}
                      </button>
                      {headerMenu === 'nama' &&
                        createPortal(
                          <div className="th-menu" ref={headerMenuRef} onKeyDown={onHeaderMenuKeyDown} style={headerMenuPos ? { position: 'fixed', top: headerMenuPos.top, left: headerMenuPos.left, right: 'auto' } : undefined}>
                            <div className="th-menu-title">Nama</div>
                            <div className="th-menu-section">
                              <label className="th-option">
                                <input type="radio" name="sort-nama-guests" checked={clientSort.key !== 'nama'} onChange={() => setClientSort({ key: null, dir: 'asc' })} />
                                Default
                              </label>
                              <label className="th-option">
                                <input type="radio" name="sort-nama-guests" checked={clientSort.key === 'nama' && clientSort.dir === 'asc'} onChange={() => setClientSort({ key: 'nama', dir: 'asc' })} />
                                Urutkan A-Z
                              </label>
                              <label className="th-option">
                                <input type="radio" name="sort-nama-guests" checked={clientSort.key === 'nama' && clientSort.dir === 'desc'} onChange={() => setClientSort({ key: 'nama', dir: 'desc' })} />
                                Urutkan Z-A
                              </label>
                            </div>
                            <div className="th-menu-section">
                              <label className="label-sm">Cari nama</label>
                              <input className="input input-sm" data-autofocus="true" value={filterNama} onChange={(e) => setFilterNama(e.target.value)} placeholder="Cari..." />
                            </div>
                            <div className="th-menu-actions">
                              <button className="button button-sm button-primary" type="button" onClick={closeHeaderMenu}>
                                Terapkan
                              </button>
                              <button
                                className="button button-sm button-secondary"
                                type="button"
                                onClick={() => {
                                  setFilterNama('')
                                  if (clientSort.key === 'nama') setClientSort({ key: null, dir: 'asc' })
                                }}
                              >
                                Reset
                              </button>
                              <button className="button button-sm button-secondary" type="button" onClick={closeHeaderMenu}>
                                Tutup
                              </button>
                            </div>
                          </div>,
                          document.body,
                        )}
                    </div>
                  </th>
                  {view === 'riwayat' && postFilter === 'IGD' && <th>Asal/Instansi</th>}
                  <th className="th-col">
                    <div className="th-head">
                      <button
                        className="th-label"
                        type="button"
                        onClick={() => setClientSort((prev) => (prev.key === 'tujuan' ? { key: 'tujuan', dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key: 'tujuan', dir: 'asc' }))}
                      >
                        TUJUAN
                      </button>
                      <span className={`th-sort ${clientSort.key === 'tujuan' ? 'is-active' : ''}`}>{clientSort.key === 'tujuan' ? (clientSort.dir === 'asc' ? '▲' : '▼') : ''}</span>
                      <button className={`th-icon ${filterTujuan.length || clientSort.key === 'tujuan' ? 'is-active' : ''}`} type="button" aria-label="Filter Tujuan" onClick={(e) => openHeaderMenu('tujuan', e.currentTarget)}>
                        ⌄{filterTujuan.length || clientSort.key === 'tujuan' ? <span className="th-dot" /> : null}
                      </button>
                      {headerMenu === 'tujuan' &&
                        createPortal(
                          <div className="th-menu" ref={headerMenuRef} onKeyDown={onHeaderMenuKeyDown} style={headerMenuPos ? { position: 'fixed', top: headerMenuPos.top, left: headerMenuPos.left, right: 'auto' } : undefined}>
                            <div className="th-menu-title">Tujuan</div>
                            <div className="th-menu-section">
                              <label className="label-sm">Cari tujuan</label>
                              <input className="input input-sm" data-autofocus="true" value={tujuanSearch} onChange={(e) => setTujuanSearch(e.target.value)} placeholder="Cari..." />
                            </div>
                            <div className="th-menu-list">
                              <label className="th-option">
                                <input type="checkbox" checked={filterTujuan.length === 0} onChange={() => setFilterTujuan([])} />
                                Semua tujuan
                              </label>
                              {uniqueTujuan
                                .filter((x) => !tujuanSearch.trim() || x.toLowerCase().includes(tujuanSearch.trim().toLowerCase()))
                                .slice(0, 120)
                                .map((t) => (
                                  <label key={t} className="th-option">
                                    <input type="checkbox" checked={filterTujuan.includes(t)} onChange={() => setFilterTujuan((p) => toggleInList(p, t))} />
                                    {t}
                                  </label>
                                ))}
                            </div>
                            <div className="th-menu-actions">
                              <button className="button button-sm button-primary" type="button" onClick={closeHeaderMenu}>
                                Terapkan
                              </button>
                              <button className="button button-sm button-secondary" type="button" onClick={() => setFilterTujuan([])}>
                                Reset
                              </button>
                              <button className="button button-sm button-secondary" type="button" onClick={closeHeaderMenu}>
                                Tutup
                              </button>
                            </div>
                          </div>,
                          document.body,
                        )}
                    </div>
                  </th>
                  {view === 'riwayat' && postFilter !== 'IGD' && <th>Kartu</th>}
                  {view === 'riwayat' && postFilter !== 'IGD' && <th>Ditemui</th>}
                  <th className="th-col">
                    <div className="th-head">
                      <button
                        className="th-label"
                        type="button"
                        onClick={() => {
                          setClientSort({ key: null, dir: 'asc' })
                          setSort((v) => (v === 'checkin_desc' ? 'checkin_asc' : 'checkin_desc'))
                        }}
                      >
                        MASUK
                      </button>
                      <span className={`th-sort ${sort.startsWith('checkin_') ? 'is-active' : ''}`}>{sort === 'checkin_asc' ? '▲' : sort === 'checkin_desc' ? '▼' : ''}</span>
                      <button
                        className={`th-icon ${masukDateFrom || masukDateTo || fromHm || toHm || sort.startsWith('checkin_') ? 'is-active' : ''}`}
                        type="button"
                        aria-label="Filter Masuk"
                        onClick={(e) => openHeaderMenu('masuk', e.currentTarget)}
                      >
                        ⌄{masukDateFrom || masukDateTo || fromHm || toHm ? <span className="th-dot" /> : null}
                      </button>
                      {headerMenu === 'masuk' &&
                        createPortal(
                          <div className="th-menu" ref={headerMenuRef} onKeyDown={onHeaderMenuKeyDown} style={headerMenuPos ? { position: 'fixed', top: headerMenuPos.top, left: headerMenuPos.left, right: 'auto' } : undefined}>
                            <div className="th-menu-title">Masuk</div>
                            <div className="th-menu-section">
                              <label className="th-option">
                                <input type="radio" name="sort-masuk" checked={sort === 'checkin_desc'} onChange={() => setSort('checkin_desc')} />
                                Urutkan terbaru
                              </label>
                              <label className="th-option">
                                <input type="radio" name="sort-masuk" checked={sort === 'checkin_asc'} onChange={() => setSort('checkin_asc')} />
                                Urutkan terlama
                              </label>
                            </div>
                            <div className="th-menu-section">
                              <label className="label-sm">Filter tanggal (rentang)</label>
                              <div className="th-two">
                                <input className="input input-sm" data-autofocus="true" type="date" value={masukDateFrom} onChange={(e) => setMasukDateFrom(e.target.value)} />
                                <input className="input input-sm" type="date" value={masukDateTo} onChange={(e) => setMasukDateTo(e.target.value)} />
                              </div>
                            </div>
                            <div className="th-menu-section">
                              <label className="label-sm">Filter jam</label>
                              <div className="th-two">
                                <input className="input input-sm" type="time" value={fromHm} onChange={(e) => setFromHm(e.target.value)} />
                                <input className="input input-sm" type="time" value={toHm} onChange={(e) => setToHm(e.target.value)} />
                              </div>
                            </div>
                            <div className="th-menu-actions">
                              <button className="button button-sm button-primary" type="button" onClick={closeHeaderMenu}>
                                Terapkan
                              </button>
                              <button
                                className="button button-sm button-secondary"
                                type="button"
                                onClick={() => {
                                  setMasukDateFrom('')
                                  setMasukDateTo('')
                                  setFromHm('')
                                  setToHm('')
                                }}
                              >
                                Reset
                              </button>
                              <button className="button button-sm button-secondary" type="button" onClick={closeHeaderMenu}>
                                Tutup
                              </button>
                            </div>
                          </div>,
                          document.body,
                        )}
                    </div>
                  </th>
                  {view === 'riwayat' && <th>Keluar</th>}
                  {view === 'riwayat' && postFilter === 'IGD' && <th>Paraf</th>}
                  <th className="th-col">
                    <div className="th-head">
                      <button
                        className="th-label"
                        type="button"
                        onClick={() => setClientSort((prev) => (prev.key === 'status' ? { key: 'status', dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key: 'status', dir: 'asc' }))}
                      >
                        STATUS
                      </button>
                      <span className={`th-sort ${clientSort.key === 'status' ? 'is-active' : ''}`}>{clientSort.key === 'status' ? (clientSort.dir === 'asc' ? '▲' : '▼') : ''}</span>
                      <button className={`th-icon ${filterStatus.length || clientSort.key === 'status' ? 'is-active' : ''}`} type="button" aria-label="Filter Status" onClick={(e) => openHeaderMenu('status', e.currentTarget)}>
                        ⌄{filterStatus.length || clientSort.key === 'status' ? <span className="th-dot" /> : null}
                      </button>
                      {headerMenu === 'status' &&
                        createPortal(
                          <div className="th-menu" ref={headerMenuRef} onKeyDown={onHeaderMenuKeyDown} style={headerMenuPos ? { position: 'fixed', top: headerMenuPos.top, left: headerMenuPos.left, right: 'auto' } : undefined}>
                            <div className="th-menu-title">Status</div>
                            <div className="th-menu-list">
                              <label className="th-option">
                                <input type="checkbox" checked={filterStatus.length === 0} onChange={() => setFilterStatus([])} />
                                Semua status
                              </label>
                              {statusOptions.map((s) => (
                                <label key={s.value} className="th-option">
                                  <input type="checkbox" checked={filterStatus.includes(s.value)} onChange={() => setFilterStatus((p) => (p.includes(s.value) ? p.filter((x) => x !== s.value) : p.concat(s.value)))} />
                                  <span className="th-badge">{s.badge}</span>
                                  <span>{s.label}</span>
                                </label>
                              ))}
                            </div>
                            <div className="th-menu-actions">
                              <button className="button button-sm button-primary" type="button" onClick={closeHeaderMenu}>
                                Terapkan
                              </button>
                              <button className="button button-sm button-secondary" type="button" onClick={() => setFilterStatus([])}>
                                Reset
                              </button>
                              <button className="button button-sm button-secondary" type="button" onClick={closeHeaderMenu}>
                                Tutup
                              </button>
                            </div>
                          </div>,
                          document.body,
                        )}
                    </div>
                  </th>
                  <th className="th-col">
                    <div className="th-head">
                      <button
                        className="th-label"
                        type="button"
                        onClick={() => setClientSort((prev) => (prev.key === 'petugas' ? { key: 'petugas', dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key: 'petugas', dir: 'asc' }))}
                      >
                        PETUGAS
                      </button>
                      <span className={`th-sort ${clientSort.key === 'petugas' ? 'is-active' : ''}`}>{clientSort.key === 'petugas' ? (clientSort.dir === 'asc' ? '▲' : '▼') : ''}</span>
                      <button className={`th-icon ${filterPetugas.length || clientSort.key === 'petugas' ? 'is-active' : ''}`} type="button" aria-label="Filter Petugas" onClick={(e) => openHeaderMenu('petugas', e.currentTarget)}>
                        ⌄{filterPetugas.length || clientSort.key === 'petugas' ? <span className="th-dot" /> : null}
                      </button>
                      {headerMenu === 'petugas' &&
                        createPortal(
                          <div className="th-menu" ref={headerMenuRef} onKeyDown={onHeaderMenuKeyDown} style={headerMenuPos ? { position: 'fixed', top: headerMenuPos.top, left: headerMenuPos.left, right: 'auto' } : undefined}>
                            <div className="th-menu-title">Petugas</div>
                            <div className="th-menu-section">
                              <label className="label-sm">Cari petugas</label>
                              <input className="input input-sm" data-autofocus="true" value={petugasSearch} onChange={(e) => setPetugasSearch(e.target.value)} placeholder="Cari..." />
                            </div>
                            <div className="th-menu-list">
                              <label className="th-option">
                                <input type="checkbox" checked={filterPetugas.length === 0} onChange={() => setFilterPetugas([])} />
                                Semua petugas
                              </label>
                              {uniquePetugas
                                .filter((x) => !petugasSearch.trim() || x.toLowerCase().includes(petugasSearch.trim().toLowerCase()))
                                .slice(0, 120)
                                .map((nm) => (
                                  <label key={nm} className="th-option">
                                    <input type="checkbox" checked={filterPetugas.includes(nm)} onChange={() => setFilterPetugas((p) => toggleInList(p, nm))} />
                                    {nm}
                                  </label>
                                ))}
                            </div>
                            <div className="th-menu-actions">
                              <button className="button button-sm button-primary" type="button" onClick={closeHeaderMenu}>
                                Terapkan
                              </button>
                              <button className="button button-sm button-secondary" type="button" onClick={() => setFilterPetugas([])}>
                                Reset
                              </button>
                              <button className="button button-sm button-secondary" type="button" onClick={closeHeaderMenu}>
                                Tutup
                              </button>
                            </div>
                          </div>,
                          document.body,
                        )}
                    </div>
                  </th>
                  <th>Foto</th>
                  <th>Aksi</th>
                </tr>
              </thead>
              <tbody>
                {loading
                  ? Array.from({ length: Math.max(6, Math.min(10, limit || 6)) }).map((_, i) => {
                      const colCount = view === 'riwayat' ? (postFilter === 'IGD' ? 11 : 10) : 7
                      return (
                        <tr key={`sk-${i}`} className="table-skeleton">
                          {Array.from({ length: colCount }).map((__, c) => (
                            <td key={c}>
                              <span className={`skeleton${c === 0 ? ' skeleton-lg' : ''}`} style={{ width: c === 0 ? '70%' : c === colCount - 1 ? '55%' : '60%' }} />
                            </td>
                          ))}
                        </tr>
                      )
                    })
                  : viewItems.map((r, idx) => (
                      <tr
                        key={r.id}
                        className={r.status === 'in' ? 'table-row-active' : r.status === 'void' ? 'table-row-void' : undefined}
                        onClick={(e) => {
                          const target = e.target as HTMLElement | null
                          if (target && target.closest('button,a,input,select,textarea,label')) return
                          setDetailRow(r)
                        }}
                      >
                        {view === 'riwayat' && postFilter === 'IGD' && <td data-label="No">{idx + 1}</td>}
                        <td data-label="Nama">{r.name}</td>
                        {view === 'riwayat' && postFilter === 'IGD' && <td data-label="Asal/Instansi">{r.instansi}</td>}
                        <td data-label="Tujuan">
                          {tujuanText(r)}
                        </td>
                        {view === 'riwayat' && postFilter !== 'IGD' && (
                          <td data-label="Kartu">{r.post === 'Pintu Utama' || r.post === 'Lobby' ? (r.visitor_card_no || '-') : '-'}</td>
                        )}
                        {view === 'riwayat' && postFilter !== 'IGD' && (
                          <td data-label="Ditemui">{r.post === 'Pintu Utama' || r.post === 'Lobby' ? '-' : (r.meet_person || '-')}</td>
                        )}
                        <td data-label="Masuk">{fmtTime(r.checkin_at)}</td>
                        {view === 'riwayat' && <td data-label="Keluar">{fmtTime(r.checkout_at)}</td>}
                        {view === 'riwayat' && postFilter === 'IGD' && <td data-label="Paraf">{r.paraf || '-'}</td>}
                        <td data-label="Status">
                          {r.status === 'void' ? <span className="badge badge-danger">Deleted</span> : r.status === 'out' ? <span className="badge badge-ok">Checkout</span> : <span className="badge badge-warn">Inhouse</span>}
                        </td>
                        <td data-label="Petugas">
                          <div className="row" style={{ gap: '8px', alignItems: 'center' }}>
                            <Avatar name={r.created_by_name || '-'} />
                            {r.created_by_name || '-'}
                          </div>
                        </td>
                        <td data-label="Foto">
                          {r.has_photo && r.photo_url ? (
                            <button className="button button-sm button-secondary" type="button" onClick={() => openGuestPhotos(r)} aria-label={`Lihat foto tamu ${r.name}`}>
                              {typeof r.photo_count === 'number' && r.photo_count > 1 ? `Foto (${r.photo_count})` : 'Foto'}
                            </button>
                          ) : (
                            <span className="muted">-</span>
                          )}
                        </td>
                        <td data-label="Aksi">
                          {r.status === 'void' ? (
                            <span className="muted">Deleted</span>
                          ) : (
                            <div className="card-actions">
                              {r.status === 'in' ? (
                                <button
                                  className="button button-sm button-primary"
                                  type="button"
                                  onClick={() => checkout(r)}
                                  aria-label={`Checkout tamu ${r.name}`}
                                  style={view === 'inhouse' ? { minHeight: 46, fontSize: 15 } : undefined}
                                >
                                  Checkout
                                </button>
                              ) : canCorrect(r) ? (
                                <button className="button button-sm button-secondary" type="button" onClick={() => undoCheckout(r)} aria-label={`Batal checkout tamu ${r.name}`}>
                                  ↩ Batal checkout
                                </button>
                              ) : null}
                              {canCorrect(r) ? (
                                <button className="button button-sm button-secondary" type="button" onClick={() => openEdit(r)} aria-label={`Edit tamu ${r.name}`}>
                                  ✎ Edit
                                </button>
                              ) : null}
                              {canCorrect(r) ? (
                                <button className="button button-sm button-danger" type="button" onClick={() => deleteGuest(r)} aria-label={`Hapus tamu ${r.name}`}>
                                  Delete
                                </button>
                              ) : null}
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                {!loading && viewItems.length === 0 && (
                  <tr>
                    <td className="muted" colSpan={view === 'riwayat' ? (postFilter === 'IGD' ? 11 : 10) : 7}>
                      Tidak ada data.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <Pagination page={page} pageSize={limit} total={total} onPageChange={setPage} />
        </div>
      </section>

      {photoView && (
        <PhotoModal
          open={true}
          title={activeAttachment?.kind ? `Foto · ${activeAttachment.kind}` : 'Foto'}
          photoUrl={photoView}
          attachments={photoTabs}
          activeAttachmentId={activeAttachment?.id ?? null}
          onSelectAttachment={(id) => {
            const a = attachments.find((x) => x.id === id)
            if (!a) return
            setActiveAttachment(a)
            loadPhotoUrl(a.url)
          }}
          onClose={closePhoto}
        />
      )}

      <Modal open={filtersSheetOpen} ariaLabel="Filter tamu" onClose={() => setFiltersSheetOpen(false)} variant="sheet">
        <div className="modal-header">
          <div className="modal-title">Filter</div>
          <button className="button button-secondary button-sm" type="button" onClick={() => setFiltersSheetOpen(false)}>
            Tutup
          </button>
        </div>
        <div className="modal-body">
          <div className="form grid grid-2" style={{ gap: 10 }}>
            <div className="field grid-span-2">
              <label className="label">Cari</label>
              <input
                className="input"
                data-autofocus="true"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={postFilter === 'IGD' ? 'Cari tamu / instansi...' : 'Cari tamu...'}
              />
            </div>

            {view === 'riwayat' && (
              <div className="field">
                <label className="label">Tanggal</label>
                <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </div>
            )}
            {view === 'riwayat' && (
              <div className="field">
                <label className="label">Urutan</label>
                <select className="select" value={sort} onChange={(e) => setSort(e.target.value as any)}>
                  <option value="checkin_desc">Masuk terbaru</option>
                  <option value="checkin_asc">Masuk terlama</option>
                </select>
              </div>
            )}

            <div className="field">
              <label className="label">Limit</label>
              <select className="select" value={limit} onChange={(e) => setLimit(parseInt(e.target.value, 10))}>
                <option value={50}>50</option>
                <option value={200}>200</option>
                <option value={500}>500</option>
              </select>
            </div>

            <div className="field">
              <label className="label">Sort (kolom)</label>
              <select
                className="select"
                value={clientSort.key ? `${clientSort.key}_${clientSort.dir}` : 'default'}
                onChange={(e) => {
                  const v = String(e.target.value || '')
                  if (v === 'default') {
                    setClientSort({ key: null, dir: 'asc' })
                    return
                  }
                  const m = /^(nama|tujuan|petugas|status)_(asc|desc)$/.exec(v)
                  if (!m) return
                  setClientSort({ key: m[1] as any, dir: m[2] as any })
                }}
              >
                <option value="default">Default</option>
                <option value="nama_asc">Nama A-Z</option>
                <option value="nama_desc">Nama Z-A</option>
                <option value="tujuan_asc">Tujuan A-Z</option>
                <option value="tujuan_desc">Tujuan Z-A</option>
                <option value="petugas_asc">Petugas A-Z</option>
                <option value="petugas_desc">Petugas Z-A</option>
                <option value="status_asc">Status A-Z</option>
                <option value="status_desc">Status Z-A</option>
              </select>
            </div>

            <div className="field grid-span-2">
              <label className="label">Filter Nama (kolom)</label>
              <input className="input" value={filterNama} onChange={(e) => setFilterNama(e.target.value)} placeholder="Cari..." />
            </div>

            <div className="field">
              <label className="label">Tujuan (kolom)</label>
              <input className="input input-sm" value={tujuanSearch} onChange={(e) => setTujuanSearch(e.target.value)} placeholder="Cari tujuan..." />
              <div className="th-menu-list" style={{ maxHeight: 240 }}>
                <label className="th-option">
                  <input type="checkbox" checked={filterTujuan.length === 0} onChange={() => setFilterTujuan([])} />
                  Semua tujuan
                </label>
                {uniqueTujuan
                  .filter((x) => !tujuanSearch.trim() || x.toLowerCase().includes(tujuanSearch.trim().toLowerCase()))
                  .slice(0, 120)
                  .map((t) => (
                    <label key={t} className="th-option">
                      <input type="checkbox" checked={filterTujuan.includes(t)} onChange={() => setFilterTujuan((p) => toggleInList(p, t))} />
                      {t}
                    </label>
                  ))}
              </div>
            </div>

            <div className="field">
              <label className="label">Petugas (kolom)</label>
              <input className="input input-sm" value={petugasSearch} onChange={(e) => setPetugasSearch(e.target.value)} placeholder="Cari petugas..." />
              <div className="th-menu-list" style={{ maxHeight: 240 }}>
                <label className="th-option">
                  <input type="checkbox" checked={filterPetugas.length === 0} onChange={() => setFilterPetugas([])} />
                  Semua petugas
                </label>
                {uniquePetugas
                  .filter((x) => !petugasSearch.trim() || x.toLowerCase().includes(petugasSearch.trim().toLowerCase()))
                  .slice(0, 120)
                  .map((nm) => (
                    <label key={nm} className="th-option">
                      <input type="checkbox" checked={filterPetugas.includes(nm)} onChange={() => setFilterPetugas((p) => toggleInList(p, nm))} />
                      {nm}
                    </label>
                  ))}
              </div>
            </div>

            <div className="field">
              <label className="label">Status (kolom)</label>
              <div className="th-menu-list" style={{ maxHeight: 240 }}>
                <label className="th-option">
                  <input type="checkbox" checked={filterStatus.length === 0} onChange={() => setFilterStatus([])} />
                  Semua status
                </label>
                <label className="th-option">
                  <input type="checkbox" checked={filterStatus.includes('in')} onChange={() => setFilterStatus((p) => (p.includes('in') ? p.filter((x) => x !== 'in') : p.concat('in')))} />
                  Inhouse
                </label>
                <label className="th-option">
                  <input type="checkbox" checked={filterStatus.includes('out')} onChange={() => setFilterStatus((p) => (p.includes('out') ? p.filter((x) => x !== 'out') : p.concat('out')))} />
                  Checkout
                </label>
                <label className="th-option">
                  <input type="checkbox" checked={filterStatus.includes('void')} onChange={() => setFilterStatus((p) => (p.includes('void') ? p.filter((x) => x !== 'void') : p.concat('void')))} />
                  Deleted
                </label>
              </div>
            </div>

            <div className="field grid-span-2">
              <label className="label">Tanggal masuk (rentang)</label>
              <div className="th-two">
                <input className="input input-sm" type="date" value={masukDateFrom} onChange={(e) => setMasukDateFrom(e.target.value)} />
                <input className="input input-sm" type="date" value={masukDateTo} onChange={(e) => setMasukDateTo(e.target.value)} />
              </div>
            </div>

            <div className="field grid-span-2">
              <label className="label">Jam masuk</label>
              <div className="th-two">
                <input className="input input-sm" type="time" value={fromHm} onChange={(e) => setFromHm(e.target.value)} />
                <input className="input input-sm" type="time" value={toHm} onChange={(e) => setToHm(e.target.value)} />
              </div>
            </div>
          </div>

          <div className="row row-right" style={{ marginTop: 14, gap: 8, flexWrap: 'wrap' }}>
            {view === 'riwayat' && (
              <button className="button button-secondary" type="button" onClick={() => setDate(today)}>
                Hari ini
              </button>
            )}
            {view === 'riwayat' && (
              <button className="button button-secondary" type="button" onClick={() => setDate('')}>
                Semua
              </button>
            )}
            <button className="button button-secondary" type="button" onClick={resetAllHeaderFilters}>
              Reset filter kolom
            </button>
            <button className="button button-primary" type="button" onClick={() => setFiltersSheetOpen(false)}>
              Terapkan
            </button>
          </div>
        </div>
      </Modal>

      {detailRow && (
        <Modal open={true} ariaLabel="Detail tamu" onClose={() => setDetailRow(null)}>
          <div className="modal-header">
            <div className="modal-title">Detail Tamu</div>
            <button className="button button-secondary button-sm" type="button" onClick={() => setDetailRow(null)}>
              Tutup
            </button>
          </div>
          <div className="modal-body">
            <div className="grid" style={{ gap: 10 }}>
              <div className="card" style={{ padding: 12, borderRadius: 12, border: '1px solid var(--border)', background: 'var(--soft-bg)' }}>
                <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
                  Audit trail
                </div>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <div>Petugas</div>
                  <div style={{ fontWeight: 800 }}>{detailRow.created_by_name || '-'}</div>
                </div>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <div>Shift</div>
                  <div style={{ fontWeight: 800 }}>{detailRow.shift || '-'}</div>
                </div>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <div>Pos</div>
                  <div style={{ fontWeight: 800 }}>{detailRow.post || '-'}</div>
                </div>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <div>ID</div>
                  <div style={{ fontWeight: 800 }}>{detailRow.id}</div>
                </div>
                {detailRow.created_at ? (
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <div>Dibuat</div>
                    <div style={{ fontWeight: 800 }}>{fmtDateTime(detailRow.created_at)}</div>
                  </div>
                ) : null}
              </div>

              <div className="card" style={{ padding: 12, borderRadius: 12, border: '1px solid var(--border)', background: 'var(--soft-bg)' }}>
                <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
                  Detail
                </div>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <div>Nama</div>
                  <div style={{ fontWeight: 800 }}>{detailRow.name || '-'}</div>
                </div>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <div>Tujuan</div>
                  <div style={{ fontWeight: 800 }}>{tujuanText(detailRow) || '-'}</div>
                </div>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <div>Masuk</div>
                  <div style={{ fontWeight: 800 }}>{fmtDateTime(detailRow.checkin_at)}</div>
                </div>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <div>Keluar</div>
                  <div style={{ fontWeight: 800 }}>{detailRow.checkout_at ? fmtDateTime(detailRow.checkout_at) : '-'}</div>
                </div>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <div>Status</div>
                  <div style={{ fontWeight: 800 }}>{detailRow.status}</div>
                </div>
                {detailRow.status === 'void' && detailRow.void_reason ? (
                  <div className="muted" style={{ marginTop: 6 }}>
                    Deleted: {detailRow.void_reason}
                  </div>
                ) : null}
                {detailRow.notes ? (
                  <div style={{ marginTop: 10 }}>
                    <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
                      Catatan
                    </div>
                    <div>{detailRow.notes}</div>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </Modal>
      )}

      {editRow && (
        <Modal open={true} ariaLabel="Edit tamu" onClose={() => setEditRow(null)}>
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
                    <input className="input" value={editInstansi} onChange={(e) => setEditInstansi(e.target.value)} placeholder={editRow.post === 'IGD' ? 'Asal/Instansi' : 'Instansi'} />
                    <input className="input" value={editPurpose} onChange={(e) => setEditPurpose(e.target.value)} placeholder={editRow.post === 'IGD' ? 'Tujuan' : 'Divisi tujuan'} />
                    <input className="input" value={editMeet} onChange={(e) => setEditMeet(e.target.value)} placeholder="Ditemui" />
                    {editRow.post === 'IGD' && <input className="input" value={editParaf} onChange={(e) => setEditParaf(e.target.value)} placeholder="Paraf" />}
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
        </Modal>
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
