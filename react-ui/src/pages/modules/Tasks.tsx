import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { apiGet, apiGetBlob, apiPatch, apiPost, apiPostForm } from '../../lib/api'
import type { AttachmentItem, Me, TaskEntry } from '../../types'
import { compressImageFile } from '../../lib/image'
import { fmtDateTime, fmtTime, nowHm, shiftHm, toIsoLocal, toYmd } from '../../lib/time'
import { useConfirm, useToast } from '../../components/ToastHost'

export default function TasksPage({ me }: { me: Me }) {
  const toast = useToast()
  const confirm = useConfirm()
  const today = toYmd(new Date())
  const draftKey = useMemo(() => `draft:tasks:${me.user.id}`, [me.user.id])
  const [q, setQ] = useState('')
  const [date, setDate] = useState(today)
  const [formDate, setFormDate] = useState(today)
  const [sort, setSort] = useState<'occurred_desc' | 'occurred_asc'>('occurred_desc')
  const [limit, setLimit] = useState(200)
  const [items, setItems] = useState<TaskEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState<string>('')

  const [editRow, setEditRow] = useState<TaskEntry | null>(null)
  const [editKind, setEditKind] = useState('')
  const [editTime, setEditTime] = useState('')
  const [editDate, setEditDate] = useState('')
  const [editDestination, setEditDestination] = useState('')
  const [editNotes, setEditNotes] = useState('')
  const [editVendor, setEditVendor] = useState('')
  const [editPomStatus, setEditPomStatus] = useState('')
  const [editBoxCount, setEditBoxCount] = useState('')
  const [editGalonUsed, setEditGalonUsed] = useState('')
  const [editGalonUnused, setEditGalonUnused] = useState('')
  const [editGalonReturned, setEditGalonReturned] = useState('')
  const [editGalonTo, setEditGalonTo] = useState('')

  type TaskTab = 'umum' | 'pom' | 'galon'
  const [tab, setTab] = useState<TaskTab>('umum')
  const [vendors, setVendors] = useState<string[]>([])
  const [vendor, setVendor] = useState('')
  const [pomStatus, setPomStatus] = useState<'Dijadwalkan' | 'Datang' | 'Selesai' | 'Bermasalah'>('Datang')
  const [pomArrivedTime, setPomArrivedTime] = useState('')
  const [boxCount, setBoxCount] = useState('')
  const [galonUsed, setGalonUsed] = useState('')
  const [galonUnused, setGalonUnused] = useState('')
  const [galonReturned, setGalonReturned] = useState('')
  const [galonTo, setGalonTo] = useState('')

  const [kind, setKind] = useState('Antar sampel')
  const [time, setTime] = useState(nowHm())
  const [destination, setDestination] = useState('')
  const [notes, setNotes] = useState('')
  const [photos, setPhotos] = useState<Array<{ file: File; kind: string; previewUrl: string }>>([])
  const [photoKey, setPhotoKey] = useState(0)
  const [attachments, setAttachments] = useState<AttachmentItem[]>([])
  const [activeAttachment, setActiveAttachment] = useState<AttachmentItem | null>(null)
  const [photoView, setPhotoView] = useState<string | null>(null)

  const refresh = useCallback(async (opts: { q: string; date: string; sort: string; limit: number }) => {
    const { q, date, sort, limit } = opts
    setLoading(true)
    try {
      const res = await apiGet<{ items: TaskEntry[] }>(
        `/api/tasks?q=${encodeURIComponent(q.trim())}&date=${encodeURIComponent(date)}&sort=${encodeURIComponent(sort)}&limit=${encodeURIComponent(String(limit))}&status=all&offset=0`,
      )
      const nextItems = res.items || []
      setItems(nextItems)
    } catch (err: any) {
      toast.push(String(err?.message || err || 'Gagal memuat tugas'), 'error')
    } finally {
      setLoading(false)
    }
  }, [toast])

  const loadVendors = useCallback(() => {
    apiGet<{ items: { name: string }[] }>('/api/vendors/catering')
      .then((res) => setVendors((res.items || []).map((x) => String(x.name || '')).filter(Boolean)))
      .catch(() => {})
  }, [])

  useEffect(() => {
    const t = window.setTimeout(() => refresh({ q, date, sort, limit }).catch(() => {}), 250)
    return () => window.clearTimeout(t)
  }, [date, limit, q, refresh, sort])

  useEffect(() => {
    const raw = localStorage.getItem(draftKey)
    if (!raw) return
    try {
      const d = JSON.parse(raw)
      if (d && typeof d === 'object') {
        if (d.tab === 'umum' || d.tab === 'pom' || d.tab === 'galon') setTab(d.tab)
        if (typeof d.kind === 'string') setKind(d.kind)
        if (typeof d.time === 'string') setTime(d.time || nowHm())
        if (typeof d.destination === 'string') setDestination(d.destination)
        if (typeof d.notes === 'string') setNotes(d.notes)
        if (typeof d.vendor === 'string') setVendor(d.vendor)
        if (typeof d.pomStatus === 'string') setPomStatus(d.pomStatus)
        if (typeof d.pomArrivedTime === 'string') setPomArrivedTime(d.pomArrivedTime)
        if (typeof d.boxCount === 'string') setBoxCount(d.boxCount)
        if (typeof d.galonUsed === 'string') setGalonUsed(d.galonUsed)
        if (typeof d.galonUnused === 'string') setGalonUnused(d.galonUnused)
        if (typeof d.galonReturned === 'string') setGalonReturned(d.galonReturned)
        if (typeof d.galonTo === 'string') setGalonTo(d.galonTo)
      }
    } catch {
      localStorage.removeItem(draftKey)
    }
  }, [draftKey])

  useEffect(() => {
    const t = window.setTimeout(() => {
      const payload = {
        tab,
        kind,
        time,
        destination,
        notes,
        vendor,
        pomStatus,
        pomArrivedTime,
        boxCount,
        galonUsed,
        galonUnused,
        galonReturned,
        galonTo,
      }
      localStorage.setItem(draftKey, JSON.stringify(payload))
    }, 300)
    return () => window.clearTimeout(t)
  }, [boxCount, destination, draftKey, galonReturned, galonTo, galonUnused, galonUsed, kind, notes, pomArrivedTime, pomStatus, tab, time, vendor])

  useEffect(() => {
    loadVendors()
  }, [loadVendors])

  useEffect(() => {
    if (tab !== 'pom') return
    loadVendors()
  }, [loadVendors, tab])

  useEffect(() => {
    const onFocus = () => loadVendors()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [loadVendors])

  const isPom = (k: string) => /pom/i.test(k || '') && /cater/i.test(k || '')
  const isGalon = (k: string) => /galon/i.test(k || '')
  const viewItems = useMemo(() => {
    if (tab === 'pom') return items.filter((r) => isPom(r.kind))
    if (tab === 'galon') return items.filter((r) => isGalon(r.kind))
    return items.filter((r) => !isPom(r.kind) && !isGalon(r.kind))
  }, [items, tab])

  const renderDetails = (r: TaskEntry) => {
    const e = r.extra || {}
    if (isPom(r.kind)) {
      const parts = []
      if (e.vendor) parts.push(`Vendor: ${String(e.vendor)}`)
      if (e.pom_status) parts.push(`Status: ${String(e.pom_status)}`)
      if (e.arrived_at) parts.push(`Datang: ${fmtDateTime(String(e.arrived_at))}`)
      if (typeof e.box_count === 'number' && Number.isFinite(e.box_count)) parts.push(`Box: ${String(e.box_count)}`)
      return parts.join(' · ')
    }
    if (isGalon(r.kind)) {
      const parts = []
      if (typeof e.galon_used === 'number' && Number.isFinite(e.galon_used)) parts.push(`Dipakai: ${String(e.galon_used)}`)
      if (typeof e.galon_unused === 'number' && Number.isFinite(e.galon_unused)) parts.push(`Tidak dipakai: ${String(e.galon_unused)}`)
      if (typeof e.galon_returned === 'number' && Number.isFinite(e.galon_returned)) parts.push(`Dikembalikan: ${String(e.galon_returned)}`)
      if (e.galon_to) parts.push(`Ke: ${String(e.galon_to)}`)
      return parts.join(' · ')
    }
    return ''
  }

  const canAdmin = me.user.role === 'admin' || me.user.role === 'supervisor'

  const summary = useMemo(() => {
    if (tab === 'pom') {
      let totalBox = 0
      let lastArrived: string | null = null
      let bermasalah = 0
      for (const r of viewItems) {
        if (r.status === 'void') continue
        const e = r.extra || {}
        const bc = typeof e.box_count === 'number' ? e.box_count : null
        if (bc != null && Number.isFinite(bc)) totalBox += bc
        if (String(e.pom_status || '') === 'Bermasalah') bermasalah += 1
        const a = e.arrived_at ? String(e.arrived_at) : null
        if (a) {
          if (!lastArrived || new Date(a).getTime() > new Date(lastArrived).getTime()) lastArrived = a
        }
      }
      return { kind: 'pom' as const, totalBox, lastArrived, bermasalah }
    }
    if (tab === 'galon') {
      let used = 0
      let unused = 0
      let returned = 0
      for (const r of viewItems) {
        if (r.status === 'void') continue
        const e = r.extra || {}
        const u = typeof e.galon_used === 'number' ? e.galon_used : 0
        const nu = typeof e.galon_unused === 'number' ? e.galon_unused : 0
        const re = typeof e.galon_returned === 'number' ? e.galon_returned : 0
        if (Number.isFinite(u)) used += u
        if (Number.isFinite(nu)) unused += nu
        if (Number.isFinite(re)) returned += re
      }
      return { kind: 'galon' as const, used, unused, returned }
    }
    return { kind: 'umum' as const }
  }, [tab, viewItems])

  const doEdit = (r: TaskEntry) => {
    if (!canAdmin) return
    if (r.status === 'void') return
    
    setEditRow(r)
    setEditKind(r.kind || '')
    setEditDestination(r.destination || '')
    setEditNotes(r.notes || '')
    
    if (r.occurred_at) {
      const d = new Date(r.occurred_at)
      setEditDate(toYmd(d))
      setEditTime(fmtTime(r.occurred_at))
    }
    
    const e = r.extra || {}
    setEditVendor(String(e.vendor || ''))
    setEditPomStatus(String(e.pom_status || 'Datang'))
    setEditBoxCount(String(e.box_count ?? ''))
    setEditGalonUsed(String(e.galon_used ?? ''))
    setEditGalonUnused(String(e.galon_unused ?? ''))
    setEditGalonReturned(String(e.galon_returned ?? ''))
    setEditGalonTo(String(e.galon_to || ''))
  }

  const saveEdit = async () => {
    if (!editRow || busy) return
    setBusy(true)
    try {
      let extra: any = null
      if (isPom(editKind)) {
        extra = {
          vendor: editVendor,
          pom_status: editPomStatus,
          box_count: parseInt(editBoxCount, 10) || 0
        }
      } else if (isGalon(editKind)) {
        extra = {
          galon_used: parseInt(editGalonUsed, 10) || 0,
          galon_unused: parseInt(editGalonUnused, 10) || 0,
          galon_returned: parseInt(editGalonReturned, 10) || 0,
          galon_to: editGalonTo
        }
      }
      
      await apiPatch(`/api/tasks/${editRow.id}`, {
        kind: editKind,
        destination: editDestination,
        notes: editNotes,
        occurred_at: toIsoLocal(editDate, editTime),
        extra: extra
      })
      
      toast.push('Tugas diperbarui', 'success')
      setEditRow(null)
      await refresh({ q, date, sort, limit })
    } catch (err: any) {
      toast.push(String(err?.message || err || 'Gagal mengubah'), 'error')
    } finally {
      setBusy(false)
    }
  }

  const doVoid = async (r: TaskEntry) => {
    if (!canAdmin) return
    if (r.status === 'void') return
    const reason = await confirm.prompt({ title: 'Void Tugas', message: 'Alasan void:', initialValue: '', confirmText: 'Void', cancelText: 'Batal', required: true })
    if (reason == null) return
    const value = reason.trim()
    if (!value) return
    try {
      await apiPost(`/api/tasks/${r.id}/void`, { reason: value })
      toast.push('Tugas di-void', 'success')
      await refresh({ q, date, sort, limit })
    } catch (err: any) {
      toast.push(String(err?.message || err || 'Gagal void'), 'error')
    }
  }

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
      const occurredAt = toIsoLocal(formDate, time)
      let finalKind = kind
      let finalDestination = destination
      let extra: any | undefined
      if (tab === 'pom') {
        finalKind = 'Pom Catering'
        finalDestination = '-'
        const vendorVal = (vendor || '').trim()
        const bc = Number.parseInt(boxCount || '', 10)
        if (!vendorVal) throw new Error('Vendor pom wajib diisi')
        if (!Number.isFinite(bc) || bc < 0) throw new Error('Jumlah box wajib diisi')
        const arrivedAt = pomArrivedTime ? toIsoLocal(formDate, pomArrivedTime) : null
        extra = {
          vendor: vendorVal,
          pom_status: pomStatus,
          arrived_at: arrivedAt,
          box_count: bc,
        }
      } else if (tab === 'galon') {
        finalKind = 'Galon'
        finalDestination = '-'
        const u = galonUsed ? Number.parseInt(galonUsed, 10) : null
        const nu = galonUnused ? Number.parseInt(galonUnused, 10) : null
        const r = galonReturned ? Number.parseInt(galonReturned, 10) : null
        if (u != null && (!Number.isFinite(u) || u < 0)) throw new Error('Galon dipakai tidak valid')
        if (nu != null && (!Number.isFinite(nu) || nu < 0)) throw new Error('Galon tidak dipakai tidak valid')
        if (r != null && (!Number.isFinite(r) || r < 0)) throw new Error('Galon dikembalikan tidak valid')
        if (r != null) {
          const total = (u ?? 0) + (nu ?? 0)
          if (r > total) throw new Error('Galon dikembalikan tidak boleh lebih dari (dipakai + tidak dipakai)')
        }
        if (u == null && nu == null && r == null && !(galonTo || '').trim()) throw new Error('Minimal isi salah satu data galon')
        extra = {
          galon_used: u,
          galon_unused: nu,
          galon_returned: r,
          galon_to: (galonTo || '').trim() || null,
        }
      }
      const payload: any = { kind: finalKind, occurred_at: occurredAt, destination: finalDestination, notes }
      if (extra !== undefined) payload.extra = extra
      let createdId: number | null = null
      try {
        const res = await apiPost<{ ok: boolean; id: number }>('/api/tasks', payload)
        createdId = res.id
      } catch (err: any) {
        if (err?.status === 409) {
          const ok = await confirm.confirm({
            title: 'Konfirmasi Simpan',
            message: `${String(err?.message || 'Data serupa sudah ada')}\n\nTetap simpan?`,
            confirmText: 'Tetap Simpan',
          })
          if (!ok) throw err
          const res = await apiPost<{ ok: boolean; id: number }>('/api/tasks', { ...payload, force: true })
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
          await apiPostForm(`/api/attachments/task_entries/${createdId}`, form)
        } catch (err: any) {
          toast.push(`Data tersimpan, tapi upload foto gagal: ${String(err?.message || err || '')}`, 'error')
        }
      }
      setDestination('')
      setNotes('')
      setVendor('')
      setPomStatus('Datang')
      setPomArrivedTime('')
      setBoxCount('')
      setGalonUsed('')
      setGalonUnused('')
      setGalonReturned('')
      setGalonTo('')
      for (const p of photos) URL.revokeObjectURL(p.previewUrl)
      setPhotos([])
      setPhotoKey((x) => x + 1)
      localStorage.removeItem(draftKey)
      toast.push('Tugas dicatat', 'success')
      await refresh({ q, date, sort, limit })
    } catch (err: any) {
      const msg = String(err?.message || err || 'Gagal menyimpan')
      setFormError(msg)
      toast.push(msg, 'error')
    } finally {
      setBusy(false)
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

  const openTaskPhotos = useCallback(async (r: TaskEntry) => {
    try {
      const res = await apiGet<{ items: AttachmentItem[] }>(`/api/attachments/task_entries/${r.id}`)
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
          <button type="button" className={`tab${tab === 'umum' ? ' tab-active' : ''}`} onClick={() => setTab('umum')}>Umum</button>
          <button type="button" className={`tab${tab === 'pom' ? ' tab-active' : ''}`} onClick={() => setTab('pom')}>Pom Catering</button>
          <button type="button" className={`tab${tab === 'galon' ? ' tab-active' : ''}`} onClick={() => setTab('galon')}>Galon</button>
        </div>
      </div>
      <div className="section-header">
        <h2 className="h2">Tugas Operasional Security</h2>
        <div className="section-actions">
          <button className="button button-secondary button-sm" type="button" onClick={() => window.print()}>
            Cetak
          </button>
        </div>
      </div>

      <section className="card" id="tasksForm">
        <header className="card-header">
          <div className="card-title">{tab === 'pom' ? 'Pom Catering' : tab === 'galon' ? 'Galon' : 'Catat tugas'}</div>
          <div className="muted">Petugas: {me.user.display_name}</div>
        </header>
        <div className="card-body">
          <form className="form grid grid-4" onSubmit={onSubmit}>
            {formError && (
              <div className="grid-span-4">
                <div className="inline-error">{formError}</div>
              </div>
            )}
            {tab === 'umum' && (
              <div className="field">
                <label className="label" htmlFor="taskKind">
                  Jenis tugas
                </label>
                <select className="select" id="taskKind" value={kind} onChange={(e) => setKind(e.target.value)}>
                  <option>Antar sampel</option>
                  <option>Antar surat</option>
                  <option>Antar berkas</option>
                  <option>Lainnya</option>
                </select>
              </div>
            )}
            {tab === 'pom' && (
              <>
                <div className="field">
                  <label className="label" htmlFor="taskPomVendor">
                    Vendor pom
                  </label>
                  {vendors.length > 0 ? (
                    <select className="select" id="taskPomVendor" value={vendor} onChange={(e) => setVendor(e.target.value)}>
                      <option value="">Pilih vendor</option>
                      {vendors.map((v) => (
                        <option key={v} value={v}>
                          {v}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input className="input" id="taskPomVendor" value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="Isi vendor (CATERING_VENDORS belum diset)" />
                  )}
                </div>
                <div className="field">
                  <label className="label" htmlFor="taskPomBox">
                    Jumlah box
                  </label>
                  <div className="number-stepper">
                    <button className="stepper-btn" type="button" onClick={() => setBoxCount(String(Math.max(0, (parseInt(boxCount, 10) || 0) - 1)))}>-</button>
                    <input className="input" id="taskPomBox" type="number" min={0} step={1} value={boxCount} onChange={(e) => setBoxCount(e.target.value)} placeholder="0" />
                    <button className="stepper-btn" type="button" onClick={() => setBoxCount(String((parseInt(boxCount, 10) || 0) + 1))}>+</button>
                  </div>
                </div>
                <div className="field">
                  <label className="label" htmlFor="taskPomStatus">
                    Status
                  </label>
                  <select className="select" id="taskPomStatus" value={pomStatus} onChange={(e) => setPomStatus(e.target.value as any)}>
                    <option value="Dijadwalkan">Dijadwalkan</option>
                    <option value="Datang">Datang</option>
                    <option value="Selesai">Selesai</option>
                    <option value="Bermasalah">Bermasalah</option>
                  </select>
                </div>
                <div className="field">
                  <label className="label" htmlFor="taskPomArrived">
                    Jam datang (opsional)
                  </label>
                  <input className="input" id="taskPomArrived" type="time" value={pomArrivedTime} onChange={(e) => setPomArrivedTime(e.target.value)} />
                </div>
              </>
            )}
            {tab === 'galon' && (
              <>
                <div className="field">
                  <label className="label" htmlFor="taskGalonUsed">
                    Galon dipakai
                  </label>
                  <div className="number-stepper">
                    <button className="stepper-btn" type="button" onClick={() => setGalonUsed(String(Math.max(0, (parseInt(galonUsed, 10) || 0) - 1)))}>-</button>
                    <input className="input" id="taskGalonUsed" type="number" min={0} step={1} value={galonUsed} onChange={(e) => setGalonUsed(e.target.value)} placeholder="0" />
                    <button className="stepper-btn" type="button" onClick={() => setGalonUsed(String((parseInt(galonUsed, 10) || 0) + 1))}>+</button>
                  </div>
                </div>
                <div className="field">
                  <label className="label" htmlFor="taskGalonUnused">
                    Galon tidak dipakai
                  </label>
                  <div className="number-stepper">
                    <button className="stepper-btn" type="button" onClick={() => setGalonUnused(String(Math.max(0, (parseInt(galonUnused, 10) || 0) - 1)))}>-</button>
                    <input className="input" id="taskGalonUnused" type="number" min={0} step={1} value={galonUnused} onChange={(e) => setGalonUnused(e.target.value)} placeholder="0" />
                    <button className="stepper-btn" type="button" onClick={() => setGalonUnused(String((parseInt(galonUnused, 10) || 0) + 1))}>+</button>
                  </div>
                </div>
                <div className="field">
                  <label className="label" htmlFor="taskGalonReturned">
                    Galon dikembalikan
                  </label>
                  <div className="number-stepper">
                    <button className="stepper-btn" type="button" onClick={() => setGalonReturned(String(Math.max(0, (parseInt(galonReturned, 10) || 0) - 1)))}>-</button>
                    <input className="input" id="taskGalonReturned" type="number" min={0} step={1} value={galonReturned} onChange={(e) => setGalonReturned(e.target.value)} placeholder="0" />
                    <button className="stepper-btn" type="button" onClick={() => setGalonReturned(String((parseInt(galonReturned, 10) || 0) + 1))}>+</button>
                  </div>
                </div>
                <div className="field">
                  <label className="label" htmlFor="taskGalonTo">
                    Dipindahkan/ke mana
                  </label>
                  <input className="input" id="taskGalonTo" value={galonTo} onChange={(e) => setGalonTo(e.target.value)} placeholder="mis. Gudang / Logistik" />
                </div>
              </>
            )}
            <div className="field field-time">
              <label className="label" htmlFor="taskTime">
                Waktu
              </label>
              <div className="time-row">
                <input className="input" type="date" value={formDate} onChange={(e) => setFormDate(e.target.value)} style={{ width: 'auto' }} />
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
              <div className="muted">Akan tersimpan: {fmtDateTime(toIsoLocal(formDate, time))}</div>
            </div>
            {tab === 'umum' && (
              <div className="field">
                <label className="label" htmlFor="taskDestination">
                  Tujuan
                </label>
                <input className="input" id="taskDestination" value={destination} onChange={(e) => setDestination(e.target.value)} placeholder="mis. Lab / Poli" required />
              </div>
            )}
            <div className="field">
              <label className="label" htmlFor="taskNotes">
                Catatan
              </label>
              <input className="input" id="taskNotes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="opsional" />
            </div>
            <div className="field grid-span-4">
              <label className="label" htmlFor="taskPhoto">
                Lampiran foto (opsional)
              </label>
              <input
                key={photoKey}
                className="input"
                id="taskPhoto"
                type="file"
                accept="image/*"
                multiple
                capture="environment"
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
                      const ok = await confirm.confirm({ title: 'Reset Draft', message: 'Hapus draft input tugas?', confirmText: 'Hapus' })
                      if (!ok) return
                      localStorage.removeItem(draftKey)
                      setFormError('')
                      setTab('umum')
                      setKind('Antar sampel')
                      setTime(nowHm())
                      setDestination('')
                      setNotes('')
                      setVendor('')
                      setPomStatus('Datang')
                      setPomArrivedTime('')
                      setBoxCount('')
                      setGalonUsed('')
                      setGalonUnused('')
                      setGalonReturned('')
                      setGalonTo('')
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
          <div className="card-title">Daftar tugas</div>
          <div className="muted">
            {loading ? 'Memuat...' : `${viewItems.length} entri`}
            {summary.kind === 'pom' ? ` · Total box: ${summary.totalBox}${summary.lastArrived ? ` · Terakhir datang: ${fmtTime(summary.lastArrived)}` : ''}${summary.bermasalah ? ` · Bermasalah: ${summary.bermasalah}` : ''}` : ''}
            {summary.kind === 'galon' ? ` · Dipakai: ${summary.used} · Tidak dipakai: ${summary.unused} · Dikembalikan: ${summary.returned}` : ''}
          </div>
        </header>
        <div className="card-body">
          <div className="table-wrap">
            <table className="table table-mobile-cards">
              <thead>
                <tr>
                  <th>Waktu</th>
                  <th>Jenis</th>
                  <th>Tujuan</th>
                  <th>Detail</th>
                  <th>Catatan</th>
                  <th>Status</th>
                  <th>Foto</th>
                  <th>Petugas</th>
                  {canAdmin && <th>Aksi</th>}
                </tr>
              </thead>
              <tbody>
                {viewItems.map((r) => (
                  <tr key={r.id} className={r.status === 'void' ? 'table-row-void' : undefined}>
                    <td data-label="Waktu">{fmtDateTime(r.occurred_at)}</td>
                    <td data-label="Jenis">{r.kind}</td>
                    <td data-label="Tujuan">{r.destination}</td>
                    <td data-label="Detail">{renderDetails(r) || <span className="muted">-</span>}</td>
                    <td data-label="Catatan">
                      {r.notes}
                      {r.status === 'void' && r.void_reason ? <div className="muted">Void: {r.void_reason}</div> : null}
                    </td>
                    <td data-label="Status">{r.status === 'void' ? <span className="badge badge-danger">Void</span> : <span className="badge badge-ok">Aktif</span>}</td>
                    <td data-label="Foto">
                      {r.has_photo && r.photo_url ? (
                        <button className="button button-sm button-secondary" type="button" onClick={() => openTaskPhotos(r)}>
                          {typeof r.photo_count === 'number' && r.photo_count > 1 ? `Foto (${r.photo_count})` : 'Foto'}
                        </button>
                      ) : (
                        <span className="muted">-</span>
                      )}
                    </td>
                    <td data-label="Petugas">{r.created_by_name || '-'}</td>
                    {canAdmin && (
                      <td data-label="Aksi">
                        <div className="card-actions">
                          {r.status !== 'void' && (
                            <>
                              <button className="button button-sm button-secondary" type="button" onClick={() => doEdit(r)}>
                                ✎ Edit
                              </button>
                              <button className="button button-sm button-void" type="button" onClick={() => doVoid(r)}>
                                ✕ Void
                              </button>
                            </>
                          )}
                          {r.status === 'void' && <span className="muted">—</span>}
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
                {viewItems.length === 0 && (
                  <tr>
                    <td className="muted" colSpan={canAdmin ? 9 : 8}>
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
              <input className="input input-sm" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Cari tugas..." />
            </div>
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
              <button className="button button-secondary button-sm" type="button" onClick={() => refresh({ q, date, sort, limit })}>
                Refresh
              </button>
              <button
                className="button button-secondary button-sm"
                type="button"
                onClick={() =>
                  downloadCsv(
                    `tugas-${tab}-${date || 'semua'}.csv`,
                    [['Waktu', 'Jenis', 'Tujuan', 'Detail', 'Catatan', 'Foto', 'Petugas', 'Shift', 'Pos']].concat(
                      viewItems.map((r) => [
                        fmtDateTime(r.occurred_at),
                        r.kind,
                        r.destination,
                        renderDetails(r),
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
            </div>
          </div>
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
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Edit tugas" onClick={(e) => e.currentTarget === e.target && setEditRow(null)}>
          <div className="modal">
            <div className="modal-header">
              <div className="modal-title">Edit Tugas</div>
              <button className="button button-secondary button-sm" type="button" onClick={() => setEditRow(null)}>
                Tutup
              </button>
            </div>
            <div className="modal-body">
              <div className="form grid grid-2">
                <div className="field">
                  <label className="label">Jenis</label>
                  <input className="input" value={editKind} disabled />
                </div>
                <div className="field">
                  <label className="label">Tanggal</label>
                  <input className="input" type="date" value={editDate} onChange={(e) => setEditDate(e.target.value)} />
                </div>
                <div className="field">
                  <label className="label">Jam</label>
                  <input className="input" type="time" value={editTime} onChange={(e) => setEditTime(e.target.value)} />
                </div>
                {isPom(editKind) && (
                  <>
                    <div className="field">
                      <label className="label">Vendor</label>
                      <input className="input" value={editVendor} onChange={(e) => setEditVendor(e.target.value)} />
                    </div>
                    <div className="field">
                      <label className="label">Box</label>
                      <input className="input" type="number" value={editBoxCount} onChange={(e) => setEditBoxCount(e.target.value)} />
                    </div>
                    <div className="field">
                      <label className="label">Status POM</label>
                      <select className="select" value={editPomStatus} onChange={(e) => setEditPomStatus(e.target.value)}>
                        <option value="Dijadwalkan">Dijadwalkan</option>
                        <option value="Datang">Datang</option>
                        <option value="Selesai">Selesai</option>
                        <option value="Bermasalah">Bermasalah</option>
                      </select>
                    </div>
                  </>
                )}
                {isGalon(editKind) && (
                  <>
                    <div className="field">
                      <label className="label">Dipakai</label>
                      <input className="input" type="number" value={editGalonUsed} onChange={(e) => setEditGalonUsed(e.target.value)} />
                    </div>
                    <div className="field">
                      <label className="label">Tidak Dipakai</label>
                      <input className="input" type="number" value={editGalonUnused} onChange={(e) => setEditGalonUnused(e.target.value)} />
                    </div>
                    <div className="field">
                      <label className="label">Dikembalikan</label>
                      <input className="input" type="number" value={editGalonReturned} onChange={(e) => setEditGalonReturned(e.target.value)} />
                    </div>
                    <div className="field">
                      <label className="label">Ke</label>
                      <input className="input" value={editGalonTo} onChange={(e) => setEditGalonTo(e.target.value)} />
                    </div>
                  </>
                )}
                {!isPom(editKind) && !isGalon(editKind) && (
                  <div className="field">
                    <label className="label">Tujuan</label>
                    <input className="input" value={editDestination} onChange={(e) => setEditDestination(e.target.value)} />
                  </div>
                )}
                <div className="field grid-span-2">
                  <label className="label">Catatan</label>
                  <input className="input" value={editNotes} onChange={(e) => setEditNotes(e.target.value)} />
                </div>
              </div>
              <div className="row row-right" style={{ marginTop: 20 }}>
                <button className="button button-secondary" type="button" onClick={() => setEditRow(null)} disabled={busy}>Batal</button>
                <button className="button button-primary" type="button" onClick={saveEdit} disabled={busy}>{busy ? 'Menyimpan...' : 'Simpan Perubahan'}</button>
              </div>
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
