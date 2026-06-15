import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { apiGet, apiGetBlob, apiPatch, apiPost, apiPostForm } from '../../lib/api'
import type { AttachmentItem, KeyMasterItem, KeyTx, Me } from '../../types'
import { compressImageFile } from '../../lib/image'
import { fmtDateTime, fmtTime, nowHm, shiftHm, toIsoLocal, toYmd } from '../../lib/time'
import { useConfirm, useToast } from '../../components/ToastHost'
import Modal from '../../components/Modal'
import PhotoModal from '../../components/PhotoModal'
import Pagination from '../../components/Pagination'
import Avatar from '../../components/Avatar'

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
  const [openPage, setOpenPage] = useState(1)
  const [closedPage, setClosedPage] = useState(1)
  const [openTotal, setOpenTotal] = useState(0)
  const [closedTotal, setClosedTotal] = useState(0)
  const [editRow, setEditRow] = useState<KeyTx | null>(null)
  const [editBorrower, setEditBorrower] = useState('')
  const [editUnit, setEditUnit] = useState('')
  const [editKeyName, setEditKeyName] = useState('')
  const [editNotes, setEditNotes] = useState('')
  const [filterBy, setFilterBy] = useState<'titip' | 'ambil'>('titip')
  const [fromHm, setFromHm] = useState('')
  const [toHm, setToHm] = useState('')

  type HeaderMenuKey =
    | null
    | 'open:nama'
    | 'open:ruangan'
    | 'open:titip'
    | 'open:petugas'
    | 'open:status'
    | 'closed:nama'
    | 'closed:ruangan'
    | 'closed:titip'
    | 'closed:petugas'
    | 'closed:status'
  const [headerMenu, setHeaderMenu] = useState<HeaderMenuKey>(null)
  const headerMenuRef = useRef<HTMLDivElement | null>(null)
  const [headerMenuAnchorEl, setHeaderMenuAnchorEl] = useState<HTMLElement | null>(null)
  const [headerMenuAnchorRect, setHeaderMenuAnchorRect] = useState<{ top: number; right: number; bottom: number; left: number } | null>(null)
  const [headerMenuPos, setHeaderMenuPos] = useState<{ top: number; left: number } | null>(null)
  const [filterNama, setFilterNama] = useState('')
  const [filterRuangan, setFilterRuangan] = useState<string[]>([])
  const [filterPetugas, setFilterPetugas] = useState<string[]>([])
  const [filterStatus, setFilterStatus] = useState<Array<KeyTx['status']>>([])
  const [titipDateFrom, setTitipDateFrom] = useState('')
  const [titipDateTo, setTitipDateTo] = useState('')
  const [petugasSearch, setPetugasSearch] = useState('')
  const [ruanganSearch, setRuanganSearch] = useState('')
  const [clientSort, setClientSort] = useState<{ key: 'nama' | 'ruangan' | 'petugas' | 'status' | null; dir: 'asc' | 'desc' }>({ key: null, dir: 'asc' })

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
      const top = r.bottom + 8
      const left = r.left
      setHeaderMenu(key)
      setHeaderMenuAnchorEl(anchorEl)
      setHeaderMenuAnchorRect({ top: r.top, right: r.right, bottom: r.bottom, left: r.left })
      setHeaderMenuPos({ top, left })
    },
    [closeHeaderMenu, headerMenu],
  )

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

  useEffect(() => {
    if (me.user.role === 'admin') {
      apiGet<{items: any[]}>('/api/guards').then(res => setGuards(res.items || [])).catch(() => {})
    }
  }, [me.user.role])

  const photoTabs = useMemo(
    () =>
      (attachments || [])
        .filter((a) => a && typeof a.id === 'number')
        .map((a) => ({ id: a.id as number, label: a.kind || 'Foto' })),
    [attachments],
  )

  useEffect(() => {
    apiGet<{ items: KeyMasterItem[] }>('/api/keys/master')
      .then((res) => setKeyMaster(res.items || []))
      .catch(() => setKeyMaster([]))
  }, [])

  const refresh = useCallback(async (opts: { q: string; date: string; sort: string; limit: number; closedDateField: 'checkout' | 'checkin' }) => {
    const { q, date, sort, limit, closedDateField } = opts
    setLoading(true)
    try {
      const [a, b] = await Promise.all([
        apiGet<{ items: KeyTx[]; total: number }>(
          `/api/keys?status=open&q=${encodeURIComponent(q)}&date=${encodeURIComponent(date)}&date_field=checkout&from_hm=${encodeURIComponent(date === today ? fromHm : '')}&to_hm=${encodeURIComponent(date === today ? toHm : '')}&sort=${encodeURIComponent(sort)}&limit=${encodeURIComponent(String(limit))}&offset=${encodeURIComponent(String(Math.max(0, (openPage - 1) * limit)))}`,
        ),
        apiGet<{ items: KeyTx[]; total: number }>(
          `/api/keys?status=closed&q=${encodeURIComponent(q)}&date=${encodeURIComponent(date)}&date_field=${encodeURIComponent(closedDateField)}&from_hm=${encodeURIComponent(date === today ? fromHm : '')}&to_hm=${encodeURIComponent(date === today ? toHm : '')}&sort=${encodeURIComponent(sort)}&limit=${encodeURIComponent(String(limit))}&offset=${encodeURIComponent(String(Math.max(0, (closedPage - 1) * limit)))}`,
        ),
      ])
      setOpen(a.items || [])
      setClosed(b.items || [])
      setOpenTotal(typeof a.total === 'number' ? a.total : 0)
      setClosedTotal(typeof b.total === 'number' ? b.total : 0)
    } catch (err: any) {
      toast.push(String(err?.message || err || 'Gagal memuat data kunci'), 'error')
    } finally {
      setLoading(false)
    }
  }, [closedPage, fromHm, openPage, toHm, toast, today])

  useEffect(() => {
    setOpenPage(1)
    setClosedPage(1)
  }, [date, filterBy, fromHm, limit, q, sort, toHm, today])

  useEffect(() => {
    const t = window.setTimeout(() => {
      const closedDateField = date === today && filterBy === 'ambil' ? 'checkin' : 'checkout'
      refresh({ q, date, sort, limit, closedDateField }).catch(() => {})
    }, 250)
    return () => window.clearTimeout(t)
  }, [date, limit, q, refresh, sort, filterBy, today, openPage, closedPage, fromHm, toHm])

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

  const menuKey = (table: 'open' | 'closed', col: 'nama' | 'ruangan' | 'titip' | 'petugas' | 'status') => `${table}:${col}` as Exclude<HeaderMenuKey, null>

  const petugasName = useCallback((r: KeyTx) => String(r.created_by_name || '').trim() || me.user.display_name, [me.user.display_name])

  const uniqueRooms = useMemo(() => {
    const s = new Set<string>()
    for (const r of [...open, ...closed]) {
      const nm = String(r.key_name || '').trim()
      if (nm) s.add(nm)
    }
    return Array.from(s).sort((a, b) => a.localeCompare(b))
  }, [closed, open])

  const uniquePetugas = useMemo(() => {
    const s = new Set<string>()
    for (const r of [...open, ...closed]) {
      const nm = petugasName(r)
      if (nm && nm !== '-') s.add(nm)
    }
    for (const g of guards) {
      const nm = String(g.display_name || '').trim()
      if (nm) s.add(nm)
    }
    return Array.from(s).sort((a, b) => a.localeCompare(b))
  }, [closed, guards, open, petugasName])

  const statusOptions: Array<{ value: KeyTx['status']; label: string; badge: JSX.Element }> = useMemo(
    () => [
      { value: 'open', label: 'Dititipkan', badge: <span className="badge badge-warn">Dititipkan</span> },
      { value: 'closed', label: 'Diambil', badge: <span className="badge badge-ok">Diambil</span> },
      { value: 'void', label: 'Deleted', badge: <span className="badge badge-danger">Deleted</span> },
    ],
    [],
  )

  const hasActiveFilters = useMemo(() => {
    return Boolean(filterNama.trim() || filterRuangan.length || filterPetugas.length || filterStatus.length || titipDateFrom || titipDateTo || fromHm || toHm || clientSort.key)
  }, [clientSort.key, filterNama, filterPetugas.length, filterRuangan.length, filterStatus.length, fromHm, titipDateFrom, titipDateTo, toHm])

  const resetAllHeaderFilters = () => {
    setFilterNama('')
    setFilterRuangan([])
    setFilterPetugas([])
    setFilterStatus([])
    setTitipDateFrom('')
    setTitipDateTo('')
    setFromHm('')
    setToHm('')
    setFilterBy('titip')
    setPetugasSearch('')
    setRuanganSearch('')
    setClientSort({ key: null, dir: 'asc' })
    closeHeaderMenu()
  }

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

  const applyClientFilters = useCallback(
    (rows: KeyTx[]) => {
      const fNama = filterNama.trim().toLowerCase()
      const fRooms = new Set(filterRuangan)
      const fPet = new Set(filterPetugas)
      const fStat = new Set(filterStatus)
      const dateFromTs = titipDateFrom ? Date.parse(`${titipDateFrom}T00:00:00`) : null
      const dateToTs = titipDateTo ? Date.parse(`${titipDateTo}T23:59:59`) : null
      const fromMin = hmToMinutes(fromHm)
      const toMin = hmToMinutes(toHm)
      let out = rows.filter((r) => {
        if (fNama) {
          const nm = String(r.borrower_name || '').toLowerCase()
          if (!nm.includes(fNama)) return false
        }
        if (fRooms.size) {
          const rm = String(r.key_name || '').trim()
          if (!fRooms.has(rm)) return false
        }
        if (fPet.size) {
          const pn = petugasName(r)
          if (!fPet.has(pn)) return false
        }
        if (fStat.size) {
          const st = r.status
          if (!fStat.has(st)) return false
        }
        if (dateFromTs !== null || dateToTs !== null || fromMin !== null || toMin !== null) {
          const iso = filterBy === 'ambil' && r.status !== 'open' ? String(r.checkin_at || '') : String(r.checkout_at || '')
          const ts = isoToTs(iso)
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
              ? String(a.borrower_name || '')
              : clientSort.key === 'ruangan'
                ? String(a.key_name || '')
                : clientSort.key === 'petugas'
                  ? String(petugasName(a) || '')
                  : String(a.status || '')
          const bv =
            clientSort.key === 'nama'
              ? String(b.borrower_name || '')
              : clientSort.key === 'ruangan'
                ? String(b.key_name || '')
                : clientSort.key === 'petugas'
                  ? String(petugasName(b) || '')
                  : String(b.status || '')
          return av.localeCompare(bv) * dir
        })
      }
      return out
    },
    [clientSort.dir, clientSort.key, filterBy, filterNama, filterPetugas, filterRuangan, filterStatus, fromHm, petugasName, titipDateFrom, titipDateTo, toHm],
  )

  const openView = useMemo(() => applyClientFilters(open), [applyClientFilters, open])
  const closedView = useMemo(() => applyClientFilters(closed), [applyClientFilters, closed])

  const filterSummary = useMemo(() => {
    const parts: string[] = []
    if (filterNama.trim()) parts.push(`Nama: ${filterNama.trim()}`)
    if (filterRuangan.length) parts.push(`Ruangan: ${filterRuangan.join(', ')}`)
    if (filterPetugas.length) parts.push(`Petugas: ${filterPetugas.join(', ')}`)
    if (filterStatus.length) {
      const labels = filterStatus
        .map((s) => (s === 'open' ? 'Dititipkan' : s === 'closed' ? 'Diambil' : 'Deleted'))
        .join(', ')
      parts.push(`Status: ${labels}`)
    }
    if (titipDateFrom || titipDateTo) parts.push(`Tanggal: ${titipDateFrom || '...'} → ${titipDateTo || '...'}`)
    if (fromHm || toHm) parts.push(`Jam (${filterBy === 'ambil' ? 'ambil' : 'titip'}): ${fromHm || '...'} → ${toHm || '...'}`)
    if (clientSort.key) {
      const lbl = clientSort.key === 'nama' ? 'Nama' : clientSort.key === 'ruangan' ? 'Ruangan' : clientSort.key === 'petugas' ? 'Petugas' : 'Status'
      parts.push(`Sort: ${lbl} ${clientSort.dir === 'desc' ? 'Z→A' : 'A→Z'}`)
    }
    return parts
  }, [clientSort.dir, clientSort.key, filterBy, filterNama, filterPetugas, filterRuangan, filterStatus, fromHm, titipDateFrom, titipDateTo, toHm])

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
              <div className="list-meta">{(open.length || closed.length) ? '' : '—'}</div>
            </div>
            {[...open, ...closed]
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
            <div className="muted">{loading ? 'Memuat...' : hasActiveFilters ? `${openView.length} / ${openTotal} entri` : `${openTotal} entri`}</div>
          </header>
          <div className="card-body">
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
                    <th className="th-col">
                      <div className="th-head">
                        <button
                          className="th-label"
                          type="button"
                          onClick={() => {
                            setClientSort((prev) => (prev.key === 'nama' ? { key: 'nama', dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key: 'nama', dir: 'asc' }))
                          }}
                        >
                          NAMA
                        </button>
                        <span className={`th-sort ${clientSort.key === 'nama' ? 'is-active' : ''}`}>{clientSort.key === 'nama' ? (clientSort.dir === 'asc' ? '▲' : '▼') : ''}</span>
                        <button
                          className={`th-icon ${filterNama.trim() || clientSort.key === 'nama' ? 'is-active' : ''}`}
                          type="button"
                          aria-label="Filter Nama"
                          onClick={(e) => openHeaderMenu(menuKey('open', 'nama'), e.currentTarget)}
                        >
                          ⌄{filterNama.trim() || clientSort.key === 'nama' ? <span className="th-dot" /> : null}
                        </button>
                        {headerMenu === menuKey('open', 'nama') &&
                          createPortal(
                          <div className="th-menu" ref={headerMenuRef} style={headerMenuPos ? { position: 'fixed', top: headerMenuPos.top, left: headerMenuPos.left, right: 'auto' } : undefined}>
                            <div className="th-menu-title">Nama</div>
                            <div className="th-menu-section">
                              <label className="th-option">
                                <input
                                  type="radio"
                                  name="sort-nama"
                                  checked={clientSort.key !== 'nama'}
                                  onChange={() => setClientSort({ key: null, dir: 'asc' })}
                                />
                                Default
                              </label>
                              <label className="th-option">
                                <input
                                  type="radio"
                                  name="sort-nama"
                                  checked={clientSort.key === 'nama' && clientSort.dir === 'asc'}
                                  onChange={() => setClientSort({ key: 'nama', dir: 'asc' })}
                                />
                                Urutkan A-Z
                              </label>
                              <label className="th-option">
                                <input
                                  type="radio"
                                  name="sort-nama"
                                  checked={clientSort.key === 'nama' && clientSort.dir === 'desc'}
                                  onChange={() => setClientSort({ key: 'nama', dir: 'desc' })}
                                />
                                Urutkan Z-A
                              </label>
                            </div>
                            <div className="th-menu-section">
                              <label className="label-sm">Cari nama</label>
                              <input className="input input-sm" value={filterNama} onChange={(e) => setFilterNama(e.target.value)} placeholder="Cari..." />
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
                          </div>
                          , document.body)}
                      </div>
                    </th>
                    <th className="th-col">
                      <div className="th-head">
                        <button
                          className="th-label"
                          type="button"
                          onClick={() => {
                            setClientSort((prev) => (prev.key === 'ruangan' ? { key: 'ruangan', dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key: 'ruangan', dir: 'asc' }))
                          }}
                        >
                          RUANGAN
                        </button>
                        <span className={`th-sort ${clientSort.key === 'ruangan' ? 'is-active' : ''}`}>{clientSort.key === 'ruangan' ? (clientSort.dir === 'asc' ? '▲' : '▼') : ''}</span>
                        <button
                          className={`th-icon ${filterRuangan.length || clientSort.key === 'ruangan' ? 'is-active' : ''}`}
                          type="button"
                          aria-label="Filter Ruangan"
                          onClick={(e) => openHeaderMenu(menuKey('open', 'ruangan'), e.currentTarget)}
                        >
                          ⌄{filterRuangan.length || clientSort.key === 'ruangan' ? <span className="th-dot" /> : null}
                        </button>
                        {headerMenu === menuKey('open', 'ruangan') &&
                          createPortal(
                          <div className="th-menu" ref={headerMenuRef} style={headerMenuPos ? { position: 'fixed', top: headerMenuPos.top, left: headerMenuPos.left, right: 'auto' } : undefined}>
                            <div className="th-menu-title">Ruangan</div>
                            <div className="th-menu-section">
                              <label className="label-sm">Cari ruangan</label>
                              <input className="input input-sm" value={ruanganSearch} onChange={(e) => setRuanganSearch(e.target.value)} placeholder="Cari..." />
                            </div>
                            <div className="th-menu-list">
                              <label className="th-option">
                                <input type="checkbox" checked={filterRuangan.length === 0} onChange={() => setFilterRuangan([])} />
                                Semua ruangan
                              </label>
                              {uniqueRooms
                                .filter((x) => !ruanganSearch.trim() || x.toLowerCase().includes(ruanganSearch.trim().toLowerCase()))
                                .slice(0, 80)
                                .map((rm) => (
                                  <label key={rm} className="th-option">
                                    <input type="checkbox" checked={filterRuangan.includes(rm)} onChange={() => setFilterRuangan((p) => toggleInList(p, rm))} />
                                    {rm}
                                  </label>
                                ))}
                            </div>
                            <div className="th-menu-actions">
                              <button className="button button-sm button-primary" type="button" onClick={closeHeaderMenu}>
                                Terapkan
                              </button>
                              <button className="button button-sm button-secondary" type="button" onClick={() => setFilterRuangan([])}>
                                Reset
                              </button>
                              <button className="button button-sm button-secondary" type="button" onClick={closeHeaderMenu}>
                                Tutup
                              </button>
                            </div>
                          </div>
                          , document.body)}
                      </div>
                    </th>
                    <th className="th-col">
                      <div className="th-head">
                        <button
                          className="th-label"
                          type="button"
                          onClick={() => {
                            setClientSort({ key: null, dir: 'asc' })
                            setSort((v) => (v === 'checkout_desc' ? 'checkout_asc' : 'checkout_desc'))
                          }}
                        >
                          TITIP
                        </button>
                        <span className={`th-sort ${sort.startsWith('checkout_') ? 'is-active' : ''}`}>{sort === 'checkout_asc' ? '▲' : sort === 'checkout_desc' ? '▼' : ''}</span>
                        <button
                          className={`th-icon ${titipDateFrom || titipDateTo || fromHm || toHm || sort.startsWith('checkout_') ? 'is-active' : ''}`}
                          type="button"
                          aria-label="Filter Titip"
                          onClick={(e) => openHeaderMenu(menuKey('open', 'titip'), e.currentTarget)}
                        >
                          ⌄{titipDateFrom || titipDateTo || fromHm || toHm ? <span className="th-dot" /> : null}
                        </button>
                        {headerMenu === menuKey('open', 'titip') &&
                          createPortal(
                          <div className="th-menu" ref={headerMenuRef} style={headerMenuPos ? { position: 'fixed', top: headerMenuPos.top, left: headerMenuPos.left, right: 'auto' } : undefined}>
                            <div className="th-menu-title">Titip</div>
                            <div className="th-menu-section">
                              <label className="th-option">
                                <input type="radio" name="sort-titip" checked={sort === 'checkout_desc'} onChange={() => setSort('checkout_desc')} />
                                Urutkan terbaru
                              </label>
                              <label className="th-option">
                                <input type="radio" name="sort-titip" checked={sort === 'checkout_asc'} onChange={() => setSort('checkout_asc')} />
                                Urutkan terlama
                              </label>
                            </div>
                            <div className="th-menu-section">
                              <label className="label-sm">Filter tanggal (rentang)</label>
                              <div className="th-two">
                                <input className="input input-sm" type="date" value={titipDateFrom} onChange={(e) => setTitipDateFrom(e.target.value)} />
                                <input className="input input-sm" type="date" value={titipDateTo} onChange={(e) => setTitipDateTo(e.target.value)} />
                              </div>
                            </div>
                            <div className="th-menu-section">
                              <label className="label-sm">Gunakan jam</label>
                              <div className="th-two">
                                <label className="th-option">
                                  <input type="radio" name="filterby-titip-open" checked={filterBy === 'titip'} onChange={() => setFilterBy('titip')} />
                                  Titip
                                </label>
                                <label className="th-option">
                                  <input type="radio" name="filterby-titip-open" checked={filterBy === 'ambil'} onChange={() => setFilterBy('ambil')} />
                                  Ambil
                                </label>
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
                                  setTitipDateFrom('')
                                  setTitipDateTo('')
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
                          </div>
                          , document.body)}
                      </div>
                    </th>
                    <th className="th-col">
                      <div className="th-head">
                        <button
                          className="th-label"
                          type="button"
                          onClick={() => {
                            setClientSort((prev) => (prev.key === 'petugas' ? { key: 'petugas', dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key: 'petugas', dir: 'asc' }))
                          }}
                        >
                          PETUGAS
                        </button>
                        <span className={`th-sort ${clientSort.key === 'petugas' ? 'is-active' : ''}`}>{clientSort.key === 'petugas' ? (clientSort.dir === 'asc' ? '▲' : '▼') : ''}</span>
                        <button
                          className={`th-icon ${filterPetugas.length || clientSort.key === 'petugas' ? 'is-active' : ''}`}
                          type="button"
                          aria-label="Filter Petugas"
                          onClick={(e) => openHeaderMenu(menuKey('open', 'petugas'), e.currentTarget)}
                        >
                          ⌄{filterPetugas.length || clientSort.key === 'petugas' ? <span className="th-dot" /> : null}
                        </button>
                        {headerMenu === menuKey('open', 'petugas') &&
                          createPortal(
                          <div className="th-menu" ref={headerMenuRef} style={headerMenuPos ? { position: 'fixed', top: headerMenuPos.top, left: headerMenuPos.left, right: 'auto' } : undefined}>
                            <div className="th-menu-title">Petugas</div>
                            <div className="th-menu-section">
                              <label className="label-sm">Cari petugas</label>
                              <input className="input input-sm" value={petugasSearch} onChange={(e) => setPetugasSearch(e.target.value)} placeholder="Cari..." />
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
                          </div>
                          , document.body)}
                      </div>
                    </th>
                    <th className="th-col">
                      <div className="th-head">
                        <button
                          className="th-label"
                          type="button"
                          onClick={() => {
                            setClientSort((prev) => (prev.key === 'status' ? { key: 'status', dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key: 'status', dir: 'asc' }))
                          }}
                        >
                          STATUS
                        </button>
                        <span className={`th-sort ${clientSort.key === 'status' ? 'is-active' : ''}`}>{clientSort.key === 'status' ? (clientSort.dir === 'asc' ? '▲' : '▼') : ''}</span>
                        <button
                          className={`th-icon ${filterStatus.length || clientSort.key === 'status' ? 'is-active' : ''}`}
                          type="button"
                          aria-label="Filter Status"
                          onClick={(e) => openHeaderMenu(menuKey('open', 'status'), e.currentTarget)}
                        >
                          ⌄{filterStatus.length || clientSort.key === 'status' ? <span className="th-dot" /> : null}
                        </button>
                        {headerMenu === menuKey('open', 'status') &&
                          createPortal(
                          <div className="th-menu" ref={headerMenuRef} style={headerMenuPos ? { position: 'fixed', top: headerMenuPos.top, left: headerMenuPos.left, right: 'auto' } : undefined}>
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
                          </div>
                          , document.body)}
                      </div>
                    </th>
                    <th>Foto</th>
                    <th>Aksi</th>
                  </tr>
                </thead>
                <tbody>
                  {loading
                    ? Array.from({ length: Math.max(6, Math.min(10, limit || 6)) }).map((_, i) => (
                        <tr key={`sk-open-${i}`} className="table-skeleton">
                          {Array.from({ length: 7 }).map((__, c) => (
                            <td key={c}>
                              <span className={`skeleton${c === 0 ? ' skeleton-lg' : ''}`} style={{ width: c === 0 ? '70%' : c === 6 ? '55%' : '60%' }} />
                            </td>
                          ))}
                        </tr>
                      ))
                    : openView.map((r) => (
                        <tr key={r.id} className="table-row-active">
                          <td data-label="Nama">{r.borrower_name}</td>
                          <td data-label="Ruangan">{r.key_name}</td>
                          <td data-label="Titip">{fmtDateTime(r.checkout_at)}</td>
                          <td data-label="Petugas">
                            <div className="row" style={{ gap: '8px', alignItems: 'center' }}>
                              <Avatar name={petugasName(r)} />
                              {petugasName(r)}
                            </div>
                          </td>
                          <td data-label="Status">{badge(r.status)}</td>
                          <td data-label="Foto">
                            {r.has_photo && r.photo_url ? (
                              <button
                                className="button button-sm button-secondary"
                                type="button"
                                onClick={() => openKeyPhotos(r)}
                                aria-label={`Lihat foto ${r.borrower_name} · ${r.key_name}`}
                              >
                                {typeof r.photo_count === 'number' && r.photo_count > 1 ? `Foto (${r.photo_count})` : 'Foto'}
                              </button>
                            ) : (
                              <span className="muted">-</span>
                            )}
                          </td>
                          <td data-label="Aksi">
                            <div className="row" style={{ flexWrap: 'wrap' }}>
                              <button className="button button-sm button-primary" type="button" onClick={() => doReturn(r)} aria-label={`Ambil kunci ${r.borrower_name} · ${r.key_name}`}>
                                ↗ Ambil
                              </button>
                              {canCorrect(r) ? (
                                <button className="button button-sm button-secondary" type="button" onClick={() => openEdit(r)} aria-label={`Edit transaksi ${r.borrower_name} · ${r.key_name}`}>
                                  ✎ Edit
                                </button>
                              ) : null}
                              {canCorrect(r) ? (
                                <button className="button button-sm button-danger" type="button" onClick={() => doUndo(r.id)} aria-label={`Hapus transaksi ${r.borrower_name} · ${r.key_name}`}>
                                  Delete
                                </button>
                              ) : null}
                            </div>
                          </td>
                        </tr>
                      ))}
                  {!loading && openView.length === 0 && (
                    <tr>
                      <td className="muted" colSpan={7}>
                        Tidak ada data.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <Pagination page={openPage} pageSize={limit} total={openTotal} onPageChange={setOpenPage} />
          </div>
        </section>

        <section className="card">
          <header className="card-header">
            <div className="card-title">Riwayat (closed)</div>
            <div className="muted">{loading ? 'Memuat...' : hasActiveFilters ? `${closedView.length} / ${closedTotal} entri` : `${closedTotal} entri`}</div>
          </header>
          <div className="card-body">
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
                    const allRows = [...open, ...closed].sort((a, b) => Date.parse(b.checkout_at || '') - Date.parse(a.checkout_at || ''))
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
                    <th className="th-col">
                      <div className="th-head">
                        <button
                          className="th-label"
                          type="button"
                          onClick={() => {
                            setClientSort((prev) => (prev.key === 'nama' ? { key: 'nama', dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key: 'nama', dir: 'asc' }))
                          }}
                        >
                          NAMA
                        </button>
                        <span className={`th-sort ${clientSort.key === 'nama' ? 'is-active' : ''}`}>{clientSort.key === 'nama' ? (clientSort.dir === 'asc' ? '▲' : '▼') : ''}</span>
                        <button
                          className={`th-icon ${filterNama.trim() || clientSort.key === 'nama' ? 'is-active' : ''}`}
                          type="button"
                          aria-label="Filter Nama"
                          onClick={(e) => openHeaderMenu(menuKey('closed', 'nama'), e.currentTarget)}
                        >
                          ⌄{filterNama.trim() || clientSort.key === 'nama' ? <span className="th-dot" /> : null}
                        </button>
                        {headerMenu === menuKey('closed', 'nama') &&
                          createPortal(
                          <div className="th-menu" ref={headerMenuRef} style={headerMenuPos ? { position: 'fixed', top: headerMenuPos.top, left: headerMenuPos.left, right: 'auto' } : undefined}>
                            <div className="th-menu-title">Nama</div>
                            <div className="th-menu-section">
                              <label className="th-option">
                                <input type="radio" name="sort-nama-closed" checked={clientSort.key !== 'nama'} onChange={() => setClientSort({ key: null, dir: 'asc' })} />
                                Default
                              </label>
                              <label className="th-option">
                                <input type="radio" name="sort-nama-closed" checked={clientSort.key === 'nama' && clientSort.dir === 'asc'} onChange={() => setClientSort({ key: 'nama', dir: 'asc' })} />
                                Urutkan A-Z
                              </label>
                              <label className="th-option">
                                <input type="radio" name="sort-nama-closed" checked={clientSort.key === 'nama' && clientSort.dir === 'desc'} onChange={() => setClientSort({ key: 'nama', dir: 'desc' })} />
                                Urutkan Z-A
                              </label>
                            </div>
                            <div className="th-menu-section">
                              <label className="label-sm">Cari nama</label>
                              <input className="input input-sm" value={filterNama} onChange={(e) => setFilterNama(e.target.value)} placeholder="Cari..." />
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
                          </div>
                          , document.body)}
                      </div>
                    </th>
                    <th className="th-col">
                      <div className="th-head">
                        <button
                          className="th-label"
                          type="button"
                          onClick={() => {
                            setClientSort((prev) => (prev.key === 'ruangan' ? { key: 'ruangan', dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key: 'ruangan', dir: 'asc' }))
                          }}
                        >
                          RUANGAN
                        </button>
                        <span className={`th-sort ${clientSort.key === 'ruangan' ? 'is-active' : ''}`}>{clientSort.key === 'ruangan' ? (clientSort.dir === 'asc' ? '▲' : '▼') : ''}</span>
                        <button
                          className={`th-icon ${filterRuangan.length || clientSort.key === 'ruangan' ? 'is-active' : ''}`}
                          type="button"
                          aria-label="Filter Ruangan"
                          onClick={(e) => openHeaderMenu(menuKey('closed', 'ruangan'), e.currentTarget)}
                        >
                          ⌄{filterRuangan.length || clientSort.key === 'ruangan' ? <span className="th-dot" /> : null}
                        </button>
                        {headerMenu === menuKey('closed', 'ruangan') &&
                          createPortal(
                          <div className="th-menu" ref={headerMenuRef} style={headerMenuPos ? { position: 'fixed', top: headerMenuPos.top, left: headerMenuPos.left, right: 'auto' } : undefined}>
                            <div className="th-menu-title">Ruangan</div>
                            <div className="th-menu-section">
                              <label className="label-sm">Cari ruangan</label>
                              <input className="input input-sm" value={ruanganSearch} onChange={(e) => setRuanganSearch(e.target.value)} placeholder="Cari..." />
                            </div>
                            <div className="th-menu-list">
                              <label className="th-option">
                                <input type="checkbox" checked={filterRuangan.length === 0} onChange={() => setFilterRuangan([])} />
                                Semua ruangan
                              </label>
                              {uniqueRooms
                                .filter((x) => !ruanganSearch.trim() || x.toLowerCase().includes(ruanganSearch.trim().toLowerCase()))
                                .slice(0, 80)
                                .map((rm) => (
                                  <label key={rm} className="th-option">
                                    <input type="checkbox" checked={filterRuangan.includes(rm)} onChange={() => setFilterRuangan((p) => toggleInList(p, rm))} />
                                    {rm}
                                  </label>
                                ))}
                            </div>
                            <div className="th-menu-actions">
                              <button className="button button-sm button-primary" type="button" onClick={closeHeaderMenu}>
                                Terapkan
                              </button>
                              <button className="button button-sm button-secondary" type="button" onClick={() => setFilterRuangan([])}>
                                Reset
                              </button>
                              <button className="button button-sm button-secondary" type="button" onClick={closeHeaderMenu}>
                                Tutup
                              </button>
                            </div>
                          </div>
                          , document.body)}
                      </div>
                    </th>
                    <th className="th-col">
                      <div className="th-head">
                        <button
                          className="th-label"
                          type="button"
                          onClick={() => {
                            setClientSort({ key: null, dir: 'asc' })
                            setSort((v) => (v === 'checkout_desc' ? 'checkout_asc' : 'checkout_desc'))
                          }}
                        >
                          TITIP
                        </button>
                        <span className={`th-sort ${sort.startsWith('checkout_') ? 'is-active' : ''}`}>{sort === 'checkout_asc' ? '▲' : sort === 'checkout_desc' ? '▼' : ''}</span>
                        <button
                          className={`th-icon ${titipDateFrom || titipDateTo || fromHm || toHm || sort.startsWith('checkout_') ? 'is-active' : ''}`}
                          type="button"
                          aria-label="Filter Titip"
                          onClick={(e) => openHeaderMenu(menuKey('closed', 'titip'), e.currentTarget)}
                        >
                          ⌄{titipDateFrom || titipDateTo || fromHm || toHm ? <span className="th-dot" /> : null}
                        </button>
                        {headerMenu === menuKey('closed', 'titip') &&
                          createPortal(
                          <div className="th-menu" ref={headerMenuRef} style={headerMenuPos ? { position: 'fixed', top: headerMenuPos.top, left: headerMenuPos.left, right: 'auto' } : undefined}>
                            <div className="th-menu-title">Titip</div>
                            <div className="th-menu-section">
                              <label className="th-option">
                                <input type="radio" name="sort-titip-closed" checked={sort === 'checkout_desc'} onChange={() => setSort('checkout_desc')} />
                                Urutkan terbaru
                              </label>
                              <label className="th-option">
                                <input type="radio" name="sort-titip-closed" checked={sort === 'checkout_asc'} onChange={() => setSort('checkout_asc')} />
                                Urutkan terlama
                              </label>
                            </div>
                            <div className="th-menu-section">
                              <label className="label-sm">Filter tanggal (rentang)</label>
                              <div className="th-two">
                                <input className="input input-sm" type="date" value={titipDateFrom} onChange={(e) => setTitipDateFrom(e.target.value)} />
                                <input className="input input-sm" type="date" value={titipDateTo} onChange={(e) => setTitipDateTo(e.target.value)} />
                              </div>
                            </div>
                            <div className="th-menu-section">
                              <label className="label-sm">Gunakan jam</label>
                              <div className="th-two">
                                <label className="th-option">
                                  <input type="radio" name="filterby-titip-closed" checked={filterBy === 'titip'} onChange={() => setFilterBy('titip')} />
                                  Titip
                                </label>
                                <label className="th-option">
                                  <input type="radio" name="filterby-titip-closed" checked={filterBy === 'ambil'} onChange={() => setFilterBy('ambil')} />
                                  Ambil
                                </label>
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
                                  setTitipDateFrom('')
                                  setTitipDateTo('')
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
                          </div>
                          , document.body)}
                      </div>
                    </th>
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
                          AMBIL
                        </button>
                        <span className={`th-sort ${sort.startsWith('checkin_') ? 'is-active' : ''}`}>{sort === 'checkin_asc' ? '▲' : sort === 'checkin_desc' ? '▼' : ''}</span>
                      </div>
                    </th>
                    <th className="th-col">
                      <div className="th-head">
                        <button
                          className="th-label"
                          type="button"
                          onClick={() => {
                            setClientSort((prev) => (prev.key === 'petugas' ? { key: 'petugas', dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key: 'petugas', dir: 'asc' }))
                          }}
                        >
                          PETUGAS
                        </button>
                        <span className={`th-sort ${clientSort.key === 'petugas' ? 'is-active' : ''}`}>{clientSort.key === 'petugas' ? (clientSort.dir === 'asc' ? '▲' : '▼') : ''}</span>
                        <button
                          className={`th-icon ${filterPetugas.length || clientSort.key === 'petugas' ? 'is-active' : ''}`}
                          type="button"
                          aria-label="Filter Petugas"
                          onClick={(e) => openHeaderMenu(menuKey('closed', 'petugas'), e.currentTarget)}
                        >
                          ⌄{filterPetugas.length || clientSort.key === 'petugas' ? <span className="th-dot" /> : null}
                        </button>
                        {headerMenu === menuKey('closed', 'petugas') &&
                          createPortal(
                          <div className="th-menu" ref={headerMenuRef} style={headerMenuPos ? { position: 'fixed', top: headerMenuPos.top, left: headerMenuPos.left, right: 'auto' } : undefined}>
                            <div className="th-menu-title">Petugas</div>
                            <div className="th-menu-section">
                              <label className="label-sm">Cari petugas</label>
                              <input className="input input-sm" value={petugasSearch} onChange={(e) => setPetugasSearch(e.target.value)} placeholder="Cari..." />
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
                          </div>
                          , document.body)}
                      </div>
                    </th>
                    <th className="th-col">
                      <div className="th-head">
                        <button
                          className="th-label"
                          type="button"
                          onClick={() => {
                            setClientSort((prev) => (prev.key === 'status' ? { key: 'status', dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key: 'status', dir: 'asc' }))
                          }}
                        >
                          STATUS
                        </button>
                        <span className={`th-sort ${clientSort.key === 'status' ? 'is-active' : ''}`}>{clientSort.key === 'status' ? (clientSort.dir === 'asc' ? '▲' : '▼') : ''}</span>
                        <button
                          className={`th-icon ${filterStatus.length || clientSort.key === 'status' ? 'is-active' : ''}`}
                          type="button"
                          aria-label="Filter Status"
                          onClick={(e) => openHeaderMenu(menuKey('closed', 'status'), e.currentTarget)}
                        >
                          ⌄{filterStatus.length || clientSort.key === 'status' ? <span className="th-dot" /> : null}
                        </button>
                        {headerMenu === menuKey('closed', 'status') &&
                          createPortal(
                          <div className="th-menu" ref={headerMenuRef} style={headerMenuPos ? { position: 'fixed', top: headerMenuPos.top, left: headerMenuPos.left, right: 'auto' } : undefined}>
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
                          </div>
                          , document.body)}
                      </div>
                    </th>
                    <th>FOTO</th>
                    <th>AKSI</th>
                  </tr>
                </thead>
                <tbody>
                  {loading
                    ? Array.from({ length: Math.max(6, Math.min(10, limit || 6)) }).map((_, i) => (
                        <tr key={`sk-closed-${i}`} className="table-skeleton">
                          {Array.from({ length: 8 }).map((__, c) => (
                            <td key={c}>
                              <span className={`skeleton${c === 0 ? ' skeleton-lg' : ''}`} style={{ width: c === 0 ? '70%' : c === 7 ? '55%' : '60%' }} />
                            </td>
                          ))}
                        </tr>
                      ))
                    : closedView.map((r) => (
                        <tr key={r.id} className={r.status === 'void' ? 'table-row-void' : undefined}>
                          <td data-label="Nama">{r.borrower_name}</td>
                          <td data-label="Ruangan">{r.key_name}</td>
                          <td data-label="Titip">{fmtDateTime(r.checkout_at)}</td>
                          <td data-label="Ambil">{fmtDateTime(r.checkin_at || '')}</td>
                          <td data-label="Petugas">
                            <div className="row" style={{ gap: '8px', alignItems: 'center' }}>
                              <Avatar name={petugasName(r)} />
                              {petugasName(r)}
                            </div>
                          </td>
                          <td data-label="Status">
                            {badge(r.status)}
                            {r.status === 'void' ? <div className="muted">Deleted</div> : null}
                          </td>
                          <td data-label="Foto">
                            {r.has_photo && r.photo_url ? (
                              <button
                                className="button button-sm button-secondary"
                                type="button"
                                onClick={() => openKeyPhotos(r)}
                                aria-label={`Lihat foto ${r.borrower_name} · ${r.key_name}`}
                              >
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
                                  <button className="button button-sm button-secondary" type="button" onClick={() => doReopen(r)} aria-label={`Batal ambil kunci ${r.borrower_name} · ${r.key_name}`}>
                                    ↩ Batal ambil
                                  </button>
                                ) : null}
                                {canCorrect(r) ? (
                                  <button className="button button-sm button-secondary" type="button" onClick={() => openEdit(r)} aria-label={`Edit transaksi ${r.borrower_name} · ${r.key_name}`}>
                                    ✎ Edit
                                  </button>
                                ) : null}
                                {canCorrect(r) ? (
                                  <button className="button button-sm button-danger" type="button" onClick={() => doVoid(r)} aria-label={`Hapus transaksi ${r.borrower_name} · ${r.key_name}`}>
                                    Delete
                                  </button>
                                ) : null}
                              </div>
                            )}
                          </td>
                        </tr>
                      ))}
                  {!loading && closedView.length === 0 && (
                    <tr>
                      <td className="muted" colSpan={8}>
                        Tidak ada data.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <Pagination page={closedPage} pageSize={limit} total={closedTotal} onPageChange={setClosedPage} />
          </div>
        </section>
      </div>

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

      {editRow && (
        <Modal open={true} ariaLabel="Edit transaksi kunci" onClose={() => setEditRow(null)}>
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
        </Modal>
      )}

      <button className="fab" type="button" onClick={() => document.getElementById('keysForm')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
        + Titip
      </button>
    </section>
  )
}
