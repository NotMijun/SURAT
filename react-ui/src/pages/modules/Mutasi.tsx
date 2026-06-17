import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { apiGet, apiGetBlob, apiPatch, apiPost, apiPostForm } from '../../lib/api'
import type { AttachmentItem, Me, MutasiEntry } from '../../types'
import { compressImageFile } from '../../lib/image'
import { fmtDateTime, fmtTime, nowHm, shiftHm, toIsoLocal, toYmd } from '../../lib/time'
import { useConfirm, useToast } from '../../components/ToastHost'
import Modal from '../../components/Modal'
import PhotoModal from '../../components/PhotoModal'
import Pagination from '../../components/Pagination'
import Avatar from '../../components/Avatar'

const KATEGORI_OPTS: Record<string, string[]> = {
  'Kejadian Operasional': ['Catering', 'Galon', 'Patroli/Ronda', 'Pemeliharaan', 'Lainnya'],
  'Kejadian Khusus': ['Komplain', 'Kehilangan', 'Kecelakaan', 'Keributan', 'Lainnya'],
  Lainnya: ['Lainnya'],
}

export default function MutasiPage({ me }: { me: Me }) {
  const toast = useToast()
  const confirm = useConfirm()
  const today = toYmd(new Date())
  const draftKey = `draft:mutasi:${me.user.id}`
  const [q, setQ] = useState('')
  const [filterKategori, setFilterKategori] = useState('')
  const [filterSub, setFilterSub] = useState('')
  const [date, setDate] = useState(today)
  const [formDate, setFormDate] = useState(today)
  const [sort, setSort] = useState<'occurred_desc' | 'occurred_asc'>('occurred_desc')
  const [limit, setLimit] = useState(200)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [items, setItems] = useState<MutasiEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState<string>('')

  type HeaderMenuKey = null | 'jam' | 'jenis' | 'deskripsi' | 'status' | 'petugas'
  const [headerMenu, setHeaderMenu] = useState<HeaderMenuKey>(null)
  const headerMenuRef = useRef<HTMLDivElement | null>(null)
  const [headerMenuAnchorEl, setHeaderMenuAnchorEl] = useState<HTMLElement | null>(null)
  const [headerMenuAnchorRect, setHeaderMenuAnchorRect] = useState<{ top: number; right: number; bottom: number; left: number } | null>(null)
  const [headerMenuPos, setHeaderMenuPos] = useState<{ top: number; left: number } | null>(null)

  const [filterJenis, setFilterJenis] = useState('')
  const [filterDesc, setFilterDesc] = useState('')
  const [filterPetugas, setFilterPetugas] = useState<string[]>([])
  const [filterStatus, setFilterStatus] = useState<Array<NonNullable<MutasiEntry['status']>>>([])
  const [jamDateFrom, setJamDateFrom] = useState('')
  const [jamDateTo, setJamDateTo] = useState('')
  const [fromHm, setFromHm] = useState('')
  const [toHm, setToHm] = useState('')
  const [petugasSearch, setPetugasSearch] = useState('')
  const [clientSort, setClientSort] = useState<{ key: 'jenis' | 'deskripsi' | 'petugas' | 'status' | null; dir: 'asc' | 'desc' }>({ key: null, dir: 'asc' })

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

  const [editRow, setEditRow] = useState<MutasiEntry | null>(null)
  const [editKategori, setEditKategori] = useState('')
  const [editSubKategori, setEditSubKategori] = useState('')
  const [editTime, setEditTime] = useState('')
  const [editDate, setEditDate] = useState('')
  const [editDesc, setEditDesc] = useState('')

  const [kategori, setKategori] = useState('Kejadian Operasional')
  const [subKategori, setSubKategori] = useState('Catering')
  const [time, setTime] = useState(nowHm())
  const [desc, setDesc] = useState('')
  const [photos, setPhotos] = useState<Array<{ file: File; kind: string; previewUrl: string }>>([])
  const [photoKey, setPhotoKey] = useState(0)
  const [attachments, setAttachments] = useState<AttachmentItem[]>([])
  const [activeAttachment, setActiveAttachment] = useState<AttachmentItem | null>(null)
  const [photoView, setPhotoView] = useState<string | null>(null)
  const photoTabs = (attachments || []).filter((a) => a && typeof a.id === 'number').map((a) => ({ id: a.id as number, label: a.kind || 'Foto' }))

  useEffect(() => {
    const raw = localStorage.getItem(draftKey)
    if (!raw) return
    try {
      const d = JSON.parse(raw)
      if (d && typeof d === 'object') {
        if (typeof d.kategori === 'string' && KATEGORI_OPTS[d.kategori]) {
          setKategori(d.kategori)
          const first = KATEGORI_OPTS[d.kategori][0] || ''
          setSubKategori(typeof d.subKategori === 'string' ? d.subKategori : first)
        }
        if (typeof d.time === 'string') setTime(d.time || nowHm())
        if (typeof d.desc === 'string') setDesc(d.desc)
      }
    } catch {
      localStorage.removeItem(draftKey)
    }
  }, [draftKey])

  useEffect(() => {
    const t = window.setTimeout(() => {
      const payload = { kategori, subKategori, time, desc }
      localStorage.setItem(draftKey, JSON.stringify(payload))
    }, 300)
    return () => window.clearTimeout(t)
  }, [desc, draftKey, kategori, subKategori, time])

  const refresh = useCallback(async (opts: { q: string; date: string; sort: string; limit: number; fk: string; fs: string; offset: number }) => {
    const { q, date, sort, limit, fk, fs, offset } = opts
    setLoading(true)
    try {
      const res = await apiGet<{ items: MutasiEntry[]; total: number }>(
        `/api/mutasi?q=${encodeURIComponent(q.trim())}&kategori=${encodeURIComponent(fk)}&sub=${encodeURIComponent(fs)}&date=${encodeURIComponent(date)}&sort=${encodeURIComponent(sort)}&limit=${encodeURIComponent(String(limit))}&offset=${encodeURIComponent(String(Math.max(0, offset)))}&status=active`,
      )
      setItems(res.items || [])
      setTotal(typeof res.total === 'number' ? res.total : 0)
    } catch (err: any) {
      toast.push(String(err?.message || err || 'Gagal memuat mutasi'), 'error')
    } finally {
      setLoading(false)
    }
  }, [toast])

  const fmtWhen = (iso: string | null | undefined) => (date ? fmtTime(iso) : fmtDateTime(iso))
  const canAdmin = me.user.role === 'admin' || me.user.role === 'supervisor'

  useEffect(() => {
    setPage(1)
  }, [date, filterKategori, filterSub, limit, q, sort])

  useEffect(() => {
    const offset = Math.max(0, (page - 1) * limit)
    const t = window.setTimeout(() => refresh({ q, date, sort, limit, fk: filterKategori, fs: filterSub, offset }).catch(() => {}), 250)
    return () => window.clearTimeout(t)
  }, [date, limit, page, q, refresh, sort, filterKategori, filterSub])

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
    const combinedKind = subKategori && subKategori !== 'Lainnya' ? `${kategori} - ${subKategori}` : kategori;
    try {
      setFormError('')
      const payload = { kind: combinedKind, occurred_at: toIsoLocal(formDate, time), description: desc }
      let createdId: number | null = null
      try {
        const res = await apiPost<{ ok: boolean; id: number }>('/api/mutasi', payload)
        createdId = res.id
      } catch (err: any) {
        if (err?.status === 409) {
          const ok = await confirm.confirm({
            title: 'Konfirmasi Simpan',
            message: `${String(err?.message || 'Data serupa sudah ada')}\n\nTetap simpan?`,
            confirmText: 'Tetap Simpan',
          })
          if (!ok) throw err
          const res = await apiPost<{ ok: boolean; id: number }>('/api/mutasi', { ...payload, force: true })
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
          await apiPostForm(`/api/attachments/mutasi_entries/${createdId}`, form)
        } catch (err: any) {
          toast.push(`Data tersimpan, tapi upload foto gagal: ${String(err?.message || err || '')}`, 'error')
        }
      }
      setDesc('')
      for (const p of photos) URL.revokeObjectURL(p.previewUrl)
      setPhotos([])
      setPhotoKey((x) => x + 1)
      localStorage.removeItem(draftKey)
      toast.push('Mutasi dicatat', 'success')
      await refresh({ q, date, sort, limit, fk: filterKategori, fs: filterSub, offset: Math.max(0, (page - 1) * limit) })
    } catch (err: any) {
      const msg = String(err?.message || err || 'Gagal menyimpan')
      setFormError(msg)
      toast.push(msg, 'error')
    } finally {
      setBusy(false)
    }
  }

  const closePhoto = () => {
    if (photoView && photoView.startsWith('blob:')) URL.revokeObjectURL(photoView)
    setPhotoView(null)
    setAttachments([])
    setActiveAttachment(null)
  }

  const doEdit = (r: MutasiEntry) => {
    if (!canAdmin) return
    
    setEditRow(r)
    setEditDesc(r.description || '')
    
    const kind = r.kind || ''
    let foundK = 'Kejadian Operasional'
    let foundS = 'Lainnya'
    
    for (const k of Object.keys(KATEGORI_OPTS)) {
      if (kind.startsWith(k)) {
        foundK = k
        const sub = kind.substring(k.length).replace(/^ - /, '').trim()
        if (KATEGORI_OPTS[k].includes(sub)) {
          foundS = sub
        }
        break
      }
    }
    
    setEditKategori(foundK)
    setEditSubKategori(foundS)
    
    if (r.occurred_at) {
      const d = new Date(r.occurred_at)
      setEditDate(toYmd(d))
      setEditTime(fmtTime(r.occurred_at))
    } else {
      setEditDate(today)
      setEditTime(nowHm())
    }
  }

  const saveEdit = async () => {
    if (!editRow || busy) return
    setBusy(true)
    const combinedKind = editSubKategori && editSubKategori !== 'Lainnya' ? `${editKategori} - ${editSubKategori}` : editKategori;
    try {
      await apiPatch(`/api/mutasi/${editRow.id}`, {
        kind: combinedKind,
        occurred_at: toIsoLocal(editDate, editTime),
        description: editDesc
      })
      toast.push('Mutasi diperbarui', 'success')
      setEditRow(null)
      await refresh({ q, date, sort, limit, fk: filterKategori, fs: filterSub, offset: Math.max(0, (page - 1) * limit) })
    } catch (err: any) {
      toast.push(String(err?.message || err || 'Gagal mengubah'), 'error')
    } finally {
      setBusy(false)
    }
  }

  const doDelete = async (r: MutasiEntry) => {
    if (!canAdmin) return
    const ok = await confirm.confirm({
      title: 'Delete Mutasi',
      message: 'Hapus mutasi ini secara permanen? Tindakan ini tidak bisa dibatalkan.',
      confirmText: 'Delete',
      cancelText: 'Batal',
    })
    if (!ok) return
    try {
      await apiPost(`/api/mutasi/${r.id}/delete`, {})
      toast.push('Mutasi dihapus', 'success')
      await refresh({ q, date, sort, limit, fk: filterKategori, fs: filterSub, offset: Math.max(0, (page - 1) * limit) })
    } catch (err: any) {
      toast.push(String(err?.message || err || 'Gagal delete'), 'error')
    }
  }

  const loadPhotoUrl = useCallback(async (url: string) => {
    const blob = await apiGetBlob(url)
    if (photoView && photoView.startsWith('blob:')) URL.revokeObjectURL(photoView)
    setPhotoView(URL.createObjectURL(blob))
  }, [photoView])

  const openMutasiPhotos = useCallback(async (r: MutasiEntry) => {
    try {
      const res = await apiGet<{ items: AttachmentItem[] }>(`/api/attachments/mutasi_entries/${r.id}`)
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

  const attachmentKinds = ['Foto', 'Surat Jalan', 'Kondisi Barang', 'Lokasi']

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
      { value: 'active' as NonNullable<MutasiEntry['status']>, label: 'Aktif', badge: <span className="badge badge-ok">Aktif</span> },
      { value: 'void' as NonNullable<MutasiEntry['status']>, label: 'Deleted', badge: <span className="badge badge-danger">Deleted</span> },
    ],
    [],
  )

  const hasActiveFilters = useMemo(() => {
    return Boolean(filterJenis.trim() || filterDesc.trim() || filterPetugas.length || filterStatus.length || jamDateFrom || jamDateTo || fromHm || toHm || clientSort.key)
  }, [clientSort.key, filterDesc, filterJenis, filterPetugas.length, filterStatus.length, fromHm, jamDateFrom, jamDateTo, toHm])

  const resetAllHeaderFilters = () => {
    setFilterJenis('')
    setFilterDesc('')
    setFilterPetugas([])
    setFilterStatus([])
    setJamDateFrom('')
    setJamDateTo('')
    setFromHm('')
    setToHm('')
    setPetugasSearch('')
    setClientSort({ key: null, dir: 'asc' })
    closeHeaderMenu()
  }

  const applyClientFilters = useCallback(
    (rows: MutasiEntry[]) => {
      const fJenis = filterJenis.trim().toLowerCase()
      const fDesc = filterDesc.trim().toLowerCase()
      const fPet = new Set(filterPetugas)
      const fStat = new Set(filterStatus)
      const dateFromTs = jamDateFrom ? Date.parse(`${jamDateFrom}T00:00:00`) : null
      const dateToTs = jamDateTo ? Date.parse(`${jamDateTo}T23:59:59`) : null
      const fromMin = hmToMinutes(fromHm)
      const toMin = hmToMinutes(toHm)

      let out = rows.filter((r) => {
        if (fJenis) {
          const k = String(r.kind || '').toLowerCase()
          if (!k.includes(fJenis)) return false
        }
        if (fDesc) {
          const d = String(r.description || '').toLowerCase()
          if (!d.includes(fDesc)) return false
        }
        if (fPet.size) {
          const pn = String(r.created_by_name || '').trim() || '-'
          if (!fPet.has(pn)) return false
        }
        if (fStat.size) {
          const st = (r.status || 'active') as NonNullable<MutasiEntry['status']>
          if (!fStat.has(st)) return false
        }
        if (dateFromTs !== null || dateToTs !== null || fromMin !== null || toMin !== null) {
          const ts = isoToTs(String(r.occurred_at || ''))
          if (ts === null) return false
          if (dateFromTs !== null && ts < dateFromTs) return false
          if (dateToTs !== null && ts > dateToTs) return false
          if (fromMin !== null || toMin !== null) {
            const dt = new Date(ts)
            const minutes = dt.getHours() * 60 + dt.getMinutes()
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
            clientSort.key === 'jenis'
              ? String(a.kind || '')
              : clientSort.key === 'deskripsi'
                ? String(a.description || '')
                : clientSort.key === 'petugas'
                  ? String(a.created_by_name || '')
                  : String(a.status || '')
          const bv =
            clientSort.key === 'jenis'
              ? String(b.kind || '')
              : clientSort.key === 'deskripsi'
                ? String(b.description || '')
                : clientSort.key === 'petugas'
                  ? String(b.created_by_name || '')
                  : String(b.status || '')
          return av.localeCompare(bv) * dir
        })
      }

      return out
    },
    [clientSort.dir, clientSort.key, filterDesc, filterJenis, filterPetugas, filterStatus, fromHm, jamDateFrom, jamDateTo, toHm],
  )

  const viewItems = useMemo(() => applyClientFilters(items), [applyClientFilters, items])

  const filterSummary = useMemo(() => {
    const parts: string[] = []
    if (filterJenis.trim()) parts.push(`Jenis: ${filterJenis.trim()}`)
    if (filterDesc.trim()) parts.push(`Deskripsi: ${filterDesc.trim()}`)
    if (filterPetugas.length) parts.push(`Petugas: ${filterPetugas.join(', ')}`)
    if (filterStatus.length) {
      const labels = filterStatus.map((s) => (s === 'active' ? 'Aktif' : 'Deleted')).join(', ')
      parts.push(`Status: ${labels}`)
    }
    if (jamDateFrom || jamDateTo) parts.push(`Tanggal: ${jamDateFrom || '...'} → ${jamDateTo || '...'}`)
    if (fromHm || toHm) parts.push(`Jam: ${fromHm || '...'} → ${toHm || '...'}`)
    if (clientSort.key) {
      const lbl = clientSort.key === 'jenis' ? 'Jenis' : clientSort.key === 'deskripsi' ? 'Deskripsi' : clientSort.key === 'petugas' ? 'Petugas' : 'Status'
      parts.push(`Sort: ${lbl} ${clientSort.dir === 'desc' ? 'Z→A' : 'A→Z'}`)
    }
    return parts
  }, [clientSort.dir, clientSort.key, filterDesc, filterJenis, filterPetugas, filterStatus, fromHm, jamDateFrom, jamDateTo, toHm])

  return (
    <section className="section">
      <div className="section-header">
        <h2 className="h2">Buku Mutasi</h2>
        <div className="section-actions">
          <button className="button button-secondary button-sm" type="button" onClick={() => window.print()}>
            Cetak
          </button>
        </div>
      </div>

      <section className="card" id="mutasiForm">
        <header className="card-header">
          <div className="card-title">Catat kejadian</div>
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
              <label className="label" htmlFor="mutasiKategori">
                Kategori
              </label>
              <select className="select" id="mutasiKategori" value={kategori} onChange={(e) => { setKategori(e.target.value); setSubKategori(KATEGORI_OPTS[e.target.value][0] || '') }}>
                {Object.keys(KATEGORI_OPTS).map(k => <option key={k} value={k}>{k}</option>)}
              </select>
            </div>
            {kategori !== 'Lainnya' && (
              <div className="field">
                <label className="label" htmlFor="mutasiSub">
                  Sub-kategori
                </label>
                <select className="select" id="mutasiSub" value={subKategori} onChange={(e) => setSubKategori(e.target.value)}>
                  {KATEGORI_OPTS[kategori].map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
            )}
            <div className="field field-time">
              <label className="label" htmlFor="mutasiTime">
                Waktu Kejadian
              </label>
              <div className="time-row">
                <input className="input" type="date" value={formDate} onChange={(e) => setFormDate(e.target.value)} style={{ width: 'auto' }} />
                <input className="input" id="mutasiTime" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
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
              <label className="label" htmlFor="mutasiDesc">
                Deskripsi
              </label>
              <input className="input" id="mutasiDesc" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Ringkasan kejadian (misal: jumlah box catering kurang)" required />
            </div>
            <div className="field grid-span-4">
              <label className="label" htmlFor="mutasiPhoto">
                Lampiran foto (opsional)
              </label>
              <input
                key={photoKey}
                className="input"
                id="mutasiPhoto"
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
                      const ok = await confirm.confirm({ title: 'Reset Draft', message: 'Hapus draft mutasi?', confirmText: 'Hapus' })
                      if (!ok) return
                      localStorage.removeItem(draftKey)
                      setFormError('')
                      setKategori('Kejadian Operasional')
                      setSubKategori('Catering')
                      setTime(nowHm())
                      setDesc('')
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
        </div>
      </section>

      <section className="card">
        <header className="card-header">
          <div className="card-title">Daftar mutasi</div>
          <div className="muted">{loading ? 'Memuat...' : `${items.length} entri`}</div>
        </header>
        <div className="card-body">
          <div className="table-footer-filters">
            <div className="filter-group">
              <label className="label-sm">Cari</label>
              <input className="input input-sm" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Cari kejadian..." />
            </div>
            <div className="filter-group">
              <label className="label-sm">Kategori</label>
              <select
                className="select select-sm"
                value={filterKategori}
                onChange={(e) => {
                  setFilterKategori(e.target.value)
                  setFilterSub('')
                }}
              >
                <option value="">Semua Kategori</option>
                {Object.keys(KATEGORI_OPTS).map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </div>
            {filterKategori && filterKategori !== 'Lainnya' && (
              <div className="filter-group">
                <label className="label-sm">Sub-Kategori</label>
                <select className="select select-sm" value={filterSub} onChange={(e) => setFilterSub(e.target.value)}>
                  <option value="">Semua Sub</option>
                  {KATEGORI_OPTS[filterKategori].map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="filter-group">
              <label className="label-sm">Tanggal</label>
              <input className="input input-sm" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div className="filter-group">
              <label className="label-sm">Urutan</label>
              <select className="select select-sm" value={sort} onChange={(e) => setSort(e.target.value as any)}>
                <option value="occurred_desc">Terbaru</option>
                <option value="occurred_asc">Terlama</option>
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
              <button
                className="button button-secondary button-sm"
                type="button"
                onClick={() => {
                  setPage(1)
                  refresh({ q, date, sort, limit, fk: filterKategori, fs: filterSub, offset: 0 }).catch(() => {})
                }}
              >
                Refresh
              </button>
              <button
                className="button button-secondary button-sm"
                type="button"
                onClick={() =>
                  downloadCsv(
                    `mutasi-${date || 'semua'}.csv`,
                    [['Jam', 'Jenis', 'Deskripsi', 'Foto', 'Petugas', 'Shift', 'Pos']].concat(
                      items.map((r) => [fmtWhen(r.occurred_at), r.kind, r.description, r.has_photo ? 'Ya' : 'Tidak', r.created_by_name || '-', r.shift || '-', r.post || '-']),
                    ),
                  )
                }
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
                          setClientSort({ key: null, dir: 'asc' })
                          setSort((v) => (v === 'occurred_desc' ? 'occurred_asc' : 'occurred_desc'))
                        }}
                      >
                        JAM
                      </button>
                      <span className={`th-sort ${sort.startsWith('occurred_') ? 'is-active' : ''}`}>{sort === 'occurred_asc' ? '▲' : sort === 'occurred_desc' ? '▼' : ''}</span>
                      <button
                        className={`th-icon ${jamDateFrom || jamDateTo || fromHm || toHm || sort.startsWith('occurred_') ? 'is-active' : ''}`}
                        type="button"
                        aria-label="Filter Jam"
                        onClick={(e) => openHeaderMenu('jam', e.currentTarget)}
                      >
                        ⌄{jamDateFrom || jamDateTo || fromHm || toHm ? <span className="th-dot" /> : null}
                      </button>
                      {headerMenu === 'jam' &&
                        createPortal(
                          <div className="th-menu" ref={headerMenuRef} style={headerMenuPos ? { position: 'fixed', top: headerMenuPos.top, left: headerMenuPos.left, right: 'auto' } : undefined}>
                            <div className="th-menu-title">Jam</div>
                            <div className="th-menu-section">
                              <label className="th-option">
                                <input type="radio" name="sort-jam-mutasi" checked={sort === 'occurred_desc'} onChange={() => setSort('occurred_desc')} />
                                Urutkan terbaru
                              </label>
                              <label className="th-option">
                                <input type="radio" name="sort-jam-mutasi" checked={sort === 'occurred_asc'} onChange={() => setSort('occurred_asc')} />
                                Urutkan terlama
                              </label>
                            </div>
                            <div className="th-menu-section">
                              <label className="label-sm">Filter tanggal (rentang)</label>
                              <div className="th-two">
                                <input className="input input-sm" type="date" value={jamDateFrom} onChange={(e) => setJamDateFrom(e.target.value)} />
                                <input className="input input-sm" type="date" value={jamDateTo} onChange={(e) => setJamDateTo(e.target.value)} />
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
                                  setJamDateFrom('')
                                  setJamDateTo('')
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
                  <th className="th-col">
                    <div className="th-head">
                      <button
                        className="th-label"
                        type="button"
                        onClick={() => setClientSort((prev) => (prev.key === 'jenis' ? { key: 'jenis', dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key: 'jenis', dir: 'asc' }))}
                      >
                        JENIS
                      </button>
                      <span className={`th-sort ${clientSort.key === 'jenis' ? 'is-active' : ''}`}>{clientSort.key === 'jenis' ? (clientSort.dir === 'asc' ? '▲' : '▼') : ''}</span>
                      <button className={`th-icon ${filterJenis.trim() || clientSort.key === 'jenis' ? 'is-active' : ''}`} type="button" aria-label="Filter Jenis" onClick={(e) => openHeaderMenu('jenis', e.currentTarget)}>
                        ⌄{filterJenis.trim() || clientSort.key === 'jenis' ? <span className="th-dot" /> : null}
                      </button>
                      {headerMenu === 'jenis' &&
                        createPortal(
                          <div className="th-menu" ref={headerMenuRef} style={headerMenuPos ? { position: 'fixed', top: headerMenuPos.top, left: headerMenuPos.left, right: 'auto' } : undefined}>
                            <div className="th-menu-title">Jenis</div>
                            <div className="th-menu-section">
                              <label className="th-option">
                                <input type="radio" name="sort-jenis-mutasi" checked={clientSort.key !== 'jenis'} onChange={() => setClientSort({ key: null, dir: 'asc' })} />
                                Default
                              </label>
                              <label className="th-option">
                                <input type="radio" name="sort-jenis-mutasi" checked={clientSort.key === 'jenis' && clientSort.dir === 'asc'} onChange={() => setClientSort({ key: 'jenis', dir: 'asc' })} />
                                Urutkan A-Z
                              </label>
                              <label className="th-option">
                                <input type="radio" name="sort-jenis-mutasi" checked={clientSort.key === 'jenis' && clientSort.dir === 'desc'} onChange={() => setClientSort({ key: 'jenis', dir: 'desc' })} />
                                Urutkan Z-A
                              </label>
                            </div>
                            <div className="th-menu-section">
                              <label className="label-sm">Cari jenis</label>
                              <input className="input input-sm" value={filterJenis} onChange={(e) => setFilterJenis(e.target.value)} placeholder="Cari..." />
                            </div>
                            <div className="th-menu-actions">
                              <button className="button button-sm button-primary" type="button" onClick={closeHeaderMenu}>
                                Terapkan
                              </button>
                              <button
                                className="button button-sm button-secondary"
                                type="button"
                                onClick={() => {
                                  setFilterJenis('')
                                  if (clientSort.key === 'jenis') setClientSort({ key: null, dir: 'asc' })
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
                  <th className="th-col">
                    <div className="th-head">
                      <button
                        className="th-label"
                        type="button"
                        onClick={() => setClientSort((prev) => (prev.key === 'deskripsi' ? { key: 'deskripsi', dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key: 'deskripsi', dir: 'asc' }))}
                      >
                        DESKRIPSI
                      </button>
                      <span className={`th-sort ${clientSort.key === 'deskripsi' ? 'is-active' : ''}`}>{clientSort.key === 'deskripsi' ? (clientSort.dir === 'asc' ? '▲' : '▼') : ''}</span>
                      <button className={`th-icon ${filterDesc.trim() || clientSort.key === 'deskripsi' ? 'is-active' : ''}`} type="button" aria-label="Filter Deskripsi" onClick={(e) => openHeaderMenu('deskripsi', e.currentTarget)}>
                        ⌄{filterDesc.trim() || clientSort.key === 'deskripsi' ? <span className="th-dot" /> : null}
                      </button>
                      {headerMenu === 'deskripsi' &&
                        createPortal(
                          <div className="th-menu" ref={headerMenuRef} style={headerMenuPos ? { position: 'fixed', top: headerMenuPos.top, left: headerMenuPos.left, right: 'auto' } : undefined}>
                            <div className="th-menu-title">Deskripsi</div>
                            <div className="th-menu-section">
                              <label className="th-option">
                                <input type="radio" name="sort-desc-mutasi" checked={clientSort.key !== 'deskripsi'} onChange={() => setClientSort({ key: null, dir: 'asc' })} />
                                Default
                              </label>
                              <label className="th-option">
                                <input type="radio" name="sort-desc-mutasi" checked={clientSort.key === 'deskripsi' && clientSort.dir === 'asc'} onChange={() => setClientSort({ key: 'deskripsi', dir: 'asc' })} />
                                Urutkan A-Z
                              </label>
                              <label className="th-option">
                                <input type="radio" name="sort-desc-mutasi" checked={clientSort.key === 'deskripsi' && clientSort.dir === 'desc'} onChange={() => setClientSort({ key: 'deskripsi', dir: 'desc' })} />
                                Urutkan Z-A
                              </label>
                            </div>
                            <div className="th-menu-section">
                              <label className="label-sm">Cari deskripsi</label>
                              <input className="input input-sm" value={filterDesc} onChange={(e) => setFilterDesc(e.target.value)} placeholder="Cari..." />
                            </div>
                            <div className="th-menu-actions">
                              <button className="button button-sm button-primary" type="button" onClick={closeHeaderMenu}>
                                Terapkan
                              </button>
                              <button
                                className="button button-sm button-secondary"
                                type="button"
                                onClick={() => {
                                  setFilterDesc('')
                                  if (clientSort.key === 'deskripsi') setClientSort({ key: null, dir: 'asc' })
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
                          <div className="th-menu" ref={headerMenuRef} style={headerMenuPos ? { position: 'fixed', top: headerMenuPos.top, left: headerMenuPos.left, right: 'auto' } : undefined}>
                            <div className="th-menu-title">Status</div>
                            <div className="th-menu-list">
                              <label className="th-option">
                                <input type="checkbox" checked={filterStatus.length === 0} onChange={() => setFilterStatus([])} />
                                Semua status
                              </label>
                              {statusOptions.map((s) => (
                                <label key={s.value} className="th-option">
                                  <input
                                    type="checkbox"
                                    checked={filterStatus.includes(s.value)}
                                    onChange={() => setFilterStatus((p) => (p.includes(s.value) ? p.filter((x) => x !== s.value) : p.concat(s.value)))}
                                  />
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
                  <th>Foto</th>
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
                          </div>,
                          document.body,
                        )}
                    </div>
                  </th>
                  {canAdmin && <th>Aksi</th>}
                </tr>
              </thead>
              <tbody>
                {loading
                  ? Array.from({ length: Math.max(6, Math.min(10, limit || 6)) }).map((_, i) => {
                      const colCount = canAdmin ? 7 : 6
                      return (
                        <tr key={`sk-${i}`} className="table-skeleton">
                          {Array.from({ length: colCount }).map((__, c) => (
                            <td key={c}>
                              <span className={`skeleton${c === 1 ? ' skeleton-lg' : ''}`} style={{ width: c === 2 ? '92%' : c === colCount - 1 ? '55%' : '60%' }} />
                            </td>
                          ))}
                        </tr>
                      )
                    })
                  : viewItems.map((r) => (
                      <tr key={r.id} className={r.status === 'void' ? 'table-row-void' : undefined}>
                        <td data-label="Jam">{fmtWhen(r.occurred_at)}</td>
                        <td data-label="Jenis">{r.kind}</td>
                        <td data-label="Deskripsi">
                          {r.description}
                          {r.status === 'void' && r.void_reason ? <div className="muted">Deleted: {r.void_reason}</div> : null}
                        </td>
                        <td data-label="Status">{r.status === 'void' ? <span className="badge badge-danger">Deleted</span> : <span className="badge badge-ok">Aktif</span>}</td>
                        <td data-label="Foto">
                          {r.has_photo && r.photo_url ? (
                            <button
                              className="button button-sm button-secondary"
                              type="button"
                              onClick={() => openMutasiPhotos(r)}
                              aria-label={`Lihat foto mutasi ${r.kind} ${fmtWhen(r.occurred_at)}`}
                            >
                              {typeof r.photo_count === 'number' && r.photo_count > 1 ? `Foto (${r.photo_count})` : 'Foto'}
                            </button>
                          ) : (
                            <span className="muted">-</span>
                          )}
                        </td>
                        <td data-label="Petugas">
                          <div className="row" style={{ gap: '8px', alignItems: 'center' }}>
                            <Avatar name={r.created_by_name || '-'} />
                            {r.created_by_name || '-'}
                          </div>
                        </td>
                        {canAdmin && (
                          <td data-label="Aksi">
                            <div className="card-actions">
                              {r.status === 'void' ? (
                                <span className="muted">—</span>
                              ) : (
                                <>
                                  <button className="button button-sm button-secondary" type="button" onClick={() => doEdit(r)} aria-label={`Edit mutasi ${r.kind} ${fmtWhen(r.occurred_at)}`}>
                                    ✎ Edit
                                  </button>
                                  <button className="button button-sm button-danger" type="button" onClick={() => doDelete(r)} aria-label={`Hapus mutasi ${r.kind} ${fmtWhen(r.occurred_at)}`}>
                                    Delete
                                  </button>
                                </>
                              )}
                            </div>
                          </td>
                        )}
                      </tr>
                    ))}
                {!loading && viewItems.length === 0 && (
                  <tr>
                    <td className="muted" colSpan={canAdmin ? 7 : 6}>
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

      {editRow && (
        <Modal open={true} ariaLabel="Edit mutasi" onClose={() => setEditRow(null)}>
            <div className="modal-header">
              <div className="modal-title">Edit Mutasi</div>
              <button className="button button-secondary button-sm" type="button" onClick={() => setEditRow(null)}>
                Tutup
              </button>
            </div>
            <div className="modal-body">
              <div className="form grid grid-2">
                <div className="field">
                  <label className="label">Kategori</label>
                  <select className="select" value={editKategori} onChange={(e) => { setEditKategori(e.target.value); setEditSubKategori(KATEGORI_OPTS[e.target.value][0] || '') }}>
                    {Object.keys(KATEGORI_OPTS).map(k => <option key={k} value={k}>{k}</option>)}
                  </select>
                </div>
                {editKategori !== 'Lainnya' && (
                  <div className="field">
                    <label className="label">Sub-kategori</label>
                    <select className="select" value={editSubKategori} onChange={(e) => setEditSubKategori(e.target.value)}>
                      {KATEGORI_OPTS[editKategori].map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </div>
                )}
                <div className="field">
                  <label className="label">Tanggal</label>
                  <input className="input" type="date" value={editDate} onChange={(e) => setEditDate(e.target.value)} />
                </div>
                <div className="field">
                  <label className="label">Jam</label>
                  <input className="input" type="time" value={editTime} onChange={(e) => setEditTime(e.target.value)} />
                </div>
                <div className="field grid-span-2">
                  <label className="label">Deskripsi</label>
                  <input className="input" value={editDesc} onChange={(e) => setEditDesc(e.target.value)} required />
                </div>
              </div>
              <div className="row row-right" style={{ marginTop: 20 }}>
                <button className="button button-secondary" type="button" onClick={() => setEditRow(null)} disabled={busy}>Batal</button>
                <button className="button button-primary" type="button" onClick={saveEdit} disabled={busy}>{busy ? 'Menyimpan...' : 'Simpan Perubahan'}</button>
              </div>
            </div>
        </Modal>
      )}

      <button className="fab" type="button" onClick={() => document.getElementById('mutasiForm')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
        + Mutasi
      </button>
    </section>
  )
}
