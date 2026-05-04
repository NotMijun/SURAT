import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { apiGet, apiGetBlob, apiPatch, apiPost, apiPostForm } from '../../lib/api'
import type { AttachmentItem, Me, TaskEntry } from '../../types'
import { compressImageFile } from '../../lib/image'
import { fmtDateTime, fmtTime, nowHm, shiftHm, toIsoLocal, toYmd } from '../../lib/time'
import { useConfirm, useToast } from '../../components/ToastHost'
import LoadingScreen from '../../components/LoadingScreen'
import Modal from '../../components/Modal'
import PhotoModal from '../../components/PhotoModal'
import Pagination from '../../components/Pagination'

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
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
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

  type PomShiftKey = 'siang' | 'sore' | 'malam'
  type PomRow = { unit: string; jatah: number | ''; taken: number | ''; person: string; note: string }
  type PomSheetRes = {
    date: string
    shift: PomShiftKey
    staff_name: string
    rows: PomRow[]
    total_boxes_in: number
    vendor_name?: string | null
    updated_at: string
  }
  type CateringVendor = { id: number | null; name: string }
  type PomHistoryItem = {
    date: string
    shift: PomShiftKey
    vendor_name: string | null
    total_boxes_in: number
    total_jatah: number
    total_taken: number
    updated_at: string
  }
  const [pomShift, setPomShift] = useState<PomShiftKey>('siang')
  const [pomStaffName, setPomStaffName] = useState(me.user.display_name)
  const [pomRows, setPomRows] = useState<PomRow[]>([])
  const [pomTotalBoxesIn, setPomTotalBoxesIn] = useState<number | ''>(0)
  const [pomVendorName, setPomVendorName] = useState('')
  const [pomUpdatedAt, setPomUpdatedAt] = useState('')
  const [pomLoading, setPomLoading] = useState(false)
  const [pomSaving, setPomSaving] = useState(false)
  const [pomError, setPomError] = useState('')
  const [cateringVendors, setCateringVendors] = useState<CateringVendor[]>([])
  const [pomEditRowIdx, setPomEditRowIdx] = useState<number | null>(null)
  const [pomHistoryItems, setPomHistoryItems] = useState<PomHistoryItem[]>([])
  const [pomHistoryLoading, setPomHistoryLoading] = useState(false)
  const [pomPrevLeftovers, setPomPrevLeftovers] = useState<{ siang: number; sore: number }>({ siang: 0, sore: 0 })
  const [pomOverCapRowIdx, setPomOverCapRowIdx] = useState<number | null>(null)
  const pomOverCapTimerRef = useRef<number | null>(null)
  const pomOverCapLastToastAtRef = useRef<number>(0)

  const refresh = useCallback(async (opts: { q: string; date: string; sort: string; limit: number; tab: TaskTab; offset: number }) => {
    const { q, date, sort, limit, tab, offset } = opts
    setLoading(true)
    try {
      const res = await apiGet<{ items: TaskEntry[]; total: number }>(
        `/api/tasks?q=${encodeURIComponent(q.trim())}&date=${encodeURIComponent(date)}&sort=${encodeURIComponent(sort)}&limit=${encodeURIComponent(String(limit))}&offset=${encodeURIComponent(String(Math.max(0, offset)))}&status=active&tab=${encodeURIComponent(tab)}`,
      )
      const nextItems = res.items || []
      setItems(nextItems)
      setTotal(typeof res.total === 'number' ? res.total : 0)
    } catch (err: any) {
      toast.push(String(err?.message || err || 'Gagal memuat tugas'), 'error')
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    setPage(1)
  }, [date, limit, q, sort, tab])

  useEffect(() => {
    const offset = Math.max(0, (page - 1) * limit)
    const t = window.setTimeout(() => refresh({ q, date, sort, limit, tab, offset }).catch(() => {}), 250)
    return () => window.clearTimeout(t)
  }, [date, limit, page, q, refresh, sort, tab])

  const pomNormalizeRows = useCallback((rows: any): PomRow[] => {
    const list = Array.isArray(rows) ? rows : []
    return list
      .map((r) => {
        const unit = String(r?.unit ?? '').trim()
        if (!unit) return null
        return {
          unit,
          jatah: Math.max(0, Math.min(9999, parseInt(String(r?.jatah ?? 0), 10) || 0)),
          taken: Math.max(0, Math.min(9999, parseInt(String(r?.taken ?? 0), 10) || 0)),
          person: String(r?.person ?? ''),
          note: String(r?.note ?? ''),
        } as PomRow
      })
      .filter(Boolean) as PomRow[]
  }, [])

  const loadPomSheet = useCallback(
    async (shift?: PomShiftKey, dateOverride?: string) => {
      const d = dateOverride || date || today
      const s = shift || pomShift
      setPomLoading(true)
      try {
        const res = await apiGet<PomSheetRes>(`/api/pom_catering/sheet?date=${encodeURIComponent(d)}&shift=${encodeURIComponent(s)}`)
        const nextShift = (res.shift as PomShiftKey) || s
        if (dateOverride) setDate(d)
        setPomShift(nextShift)
        setPomStaffName(String(res.staff_name || '').trim() || me.user.display_name)
        setPomRows(pomNormalizeRows(res.rows))
        setPomTotalBoxesIn(Math.max(0, parseInt(String((res as any)?.total_boxes_in ?? 0), 10) || 0))
        setPomVendorName(String((res as any)?.vendor_name ?? '') || '')
        setPomUpdatedAt(String(res.updated_at || ''))
        try {
          if (nextShift === 'sore' || nextShift === 'malam') {
            const si = await apiGet<PomSheetRes>(`/api/pom_catering/sheet?date=${encodeURIComponent(d)}&shift=siang`)
            const siTaken = pomNormalizeRows(si.rows).reduce((sum, r) => sum + (r.taken || 0), 0)
            const siLeft = Math.max(0, (Number(si.total_boxes_in) || 0) - siTaken)
            if (nextShift === 'malam') {
              const so = await apiGet<PomSheetRes>(`/api/pom_catering/sheet?date=${encodeURIComponent(d)}&shift=sore`)
              const soTaken = pomNormalizeRows(so.rows).reduce((sum, r) => sum + (r.taken || 0), 0)
              const soLeft = Math.max(0, (Number(so.total_boxes_in) || 0) - soTaken)
              setPomPrevLeftovers({ siang: siLeft, sore: soLeft })
            } else {
              setPomPrevLeftovers({ siang: siLeft, sore: 0 })
            }
          } else {
            setPomPrevLeftovers({ siang: 0, sore: 0 })
          }
        } catch {
          setPomPrevLeftovers({ siang: 0, sore: 0 })
        }
        setPomError('')
        setPomEditRowIdx(null)
      } catch (err: any) {
        setPomError(String(err?.message || err || 'Gagal memuat sheet POM'))
        setPomRows([])
      } finally {
        setPomLoading(false)
      }
    },
    [date, me.user.display_name, pomNormalizeRows, pomShift, today],
  )

  const openPomSheetFromLog = useCallback(
    async (sheetDate: any, sheetShift: any) => {
      const d = String(sheetDate || '').trim()
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
        toast.push('Tanggal sheet tidak valid', 'error')
        return
      }
      const sRaw = String(sheetShift || '').toLowerCase()
      const s: PomShiftKey = sRaw.startsWith('so') ? 'sore' : sRaw.startsWith('ma') ? 'malam' : 'siang'
      setTab('pom')
      try {
        await loadPomSheet(s, d)
        window.setTimeout(() => document.getElementById('pomSheet')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
        toast.push(`Sheet ${d} (${s === 'siang' ? 'Siang' : s === 'sore' ? 'Sore' : 'Malam'}) dimuat`, 'success')
      } catch (err: any) {
        toast.push(String(err?.message || err || 'Gagal membuka sheet'), 'error')
      }
    },
    [loadPomSheet, toast],
  )

  const loadPomHistory = useCallback(async () => {
    setPomHistoryLoading(true)
    try {
      const res = await apiGet<{ items: PomHistoryItem[] }>('/api/pom_catering/history?limit=60')
      const list = Array.isArray(res.items) ? res.items : []
      setPomHistoryItems(
        list
          .map((x) => ({
            date: String((x as any).date || ''),
            shift: (String((x as any).shift || '') as PomShiftKey) || 'siang',
            vendor_name: (x as any).vendor_name != null ? String((x as any).vendor_name) : null,
            total_boxes_in: Math.max(0, parseInt(String((x as any).total_boxes_in ?? 0), 10) || 0),
            total_jatah: Math.max(0, parseInt(String((x as any).total_jatah ?? 0), 10) || 0),
            total_taken: Math.max(0, parseInt(String((x as any).total_taken ?? 0), 10) || 0),
            updated_at: String((x as any).updated_at || ''),
          }))
          .filter((x) => x.date && (x.shift === 'siang' || x.shift === 'sore' || x.shift === 'malam')),
      )
    } catch {
      setPomHistoryItems([])
    } finally {
      setPomHistoryLoading(false)
    }
  }, [])

  useEffect(() => {
    if (tab !== 'pom') return
    loadPomSheet().catch(() => {})
    loadPomHistory().catch(() => {})
  }, [loadPomHistory, loadPomSheet, tab])

  const setPomRow = useCallback((rowIdx: number, patch: Partial<PomRow>) => {
    setPomRows((prev) => prev.map((r, i) => (i === rowIdx ? { ...r, ...patch } : r)))
  }, [])

  useEffect(() => {
    return () => {
      if (pomOverCapTimerRef.current) window.clearTimeout(pomOverCapTimerRef.current)
    }
  }, [])

  const pomTotals = useMemo(() => {
    let jatah = 0
    let taken = 0
    for (const r of pomRows) {
      jatah += Number(r.jatah) || 0
      taken += Number(r.taken) || 0
    }
    return { jatah, taken }
  }, [pomRows])

  const pomUsedTotal = useMemo(() => pomTotals.taken, [pomTotals.taken])

  const pomPrevAvailable = useMemo(() => {
    if (pomShift === 'sore') return pomPrevLeftovers.siang
    if (pomShift === 'malam') return pomPrevLeftovers.siang + pomPrevLeftovers.sore
    return 0
  }, [pomPrevLeftovers.siang, pomPrevLeftovers.sore, pomShift])

  const pomAvailableBoxes = useMemo(() => (Number(pomTotalBoxesIn) || 0) + pomPrevAvailable, [pomPrevAvailable, pomTotalBoxesIn])

  const pomRemaining = useMemo(() => pomAvailableBoxes - pomUsedTotal, [pomAvailableBoxes, pomUsedTotal])

  const bumpPomOverCap = useCallback(
    (rowIdx: number) => {
      setPomOverCapRowIdx(rowIdx)
      if (pomOverCapTimerRef.current) window.clearTimeout(pomOverCapTimerRef.current)
      pomOverCapTimerRef.current = window.setTimeout(() => {
        setPomOverCapRowIdx(null)
        pomOverCapTimerRef.current = null
      }, 650)
      const now = Date.now()
      if (now - pomOverCapLastToastAtRef.current > 900) {
        pomOverCapLastToastAtRef.current = now
        toast.push('Melebihi kuota total box', 'warn')
      }
    },
    [toast],
  )

  const setPomRowCapped = useCallback(
    (rowIdx: number, patch: Partial<PomRow>) => {
      setPomRows((prev) => {
        const curr = prev[rowIdx]
        if (!curr) return prev
        if (patch.jatah === '' || patch.taken === '') {
          return prev.map((r, i) => (i === rowIdx ? { ...r, ...patch } : r))
        }
        let nextJatah = patch.jatah != null ? Math.max(0, Math.min(9999, Number(patch.jatah) || 0)) : Number(curr.jatah) || 0
        let nextTaken = patch.taken != null ? Math.max(0, Math.min(9999, Number(patch.taken) || 0)) : Number(curr.taken) || 0

        if (patch.jatah != null) {
          const other = prev.reduce((sum, r, i) => sum + (i === rowIdx ? 0 : Number(r.jatah) || 0), 0)
          const cap = Math.max(0, pomAvailableBoxes - other)
          if (nextJatah > cap) {
            nextJatah = cap
            bumpPomOverCap(rowIdx)
          }
        }

        if (patch.taken != null) {
          const other = prev.reduce((sum, r, i) => sum + (i === rowIdx ? 0 : Number(r.taken) || 0), 0)
          const cap = Math.max(0, pomAvailableBoxes - other)
          if (nextTaken > cap) {
            nextTaken = cap
            bumpPomOverCap(rowIdx)
          }
        }

        return prev.map((r, i) =>
          i === rowIdx
            ? {
                ...r,
                ...patch,
                jatah: patch.jatah != null ? nextJatah : r.jatah,
                taken: patch.taken != null ? nextTaken : r.taken,
              }
            : r,
        )
      })
    },
    [bumpPomOverCap, pomAvailableBoxes],
  )

  const savePomSheet = useCallback(async () => {
    if (pomSaving) return
    setPomSaving(true)
    try {
      const d = date || today
      const payload = {
        staff_name: pomStaffName,
        rows: pomRows.map((r) => ({ ...r, jatah: Number(r.jatah) || 0, taken: Number(r.taken) || 0 })),
        total_boxes_in: Number(pomTotalBoxesIn) || 0,
        vendor_name: pomVendorName,
        date: d,
      }
      const res = await apiPost<{ ok: boolean; shift: PomShiftKey; updated_at: string }>(
        `/api/pom_catering/sheet?date=${encodeURIComponent(d)}&shift=${encodeURIComponent(pomShift)}`,
        payload,
      )
      if (res.shift) setPomShift(res.shift)
      setPomUpdatedAt(String(res.updated_at || ''))
      toast.push('Sheet POM tersimpan', 'success')
      setPomEditRowIdx(null)
      loadPomHistory().catch(() => {})
      setPage(1)
      refresh({ q, date: d, sort, limit, tab, offset: 0 }).catch(() => {})
      setPomError('')
    } catch (err: any) {
      const msg = String(err?.message || err || 'Gagal menyimpan sheet POM')
      setPomError(msg)
      toast.push(msg, 'error')
    } finally {
      setPomSaving(false)
    }
  }, [date, limit, loadPomHistory, pomRows, pomSaving, pomShift, pomStaffName, pomTotalBoxesIn, pomVendorName, q, refresh, sort, tab, toast, today])

  useEffect(() => {
    const loadVendors = async () => {
      try {
        const res = await apiGet<{ items: CateringVendor[] }>('/api/vendors/catering')
        setCateringVendors(res.items || [])
      } catch (err) {
        console.error('Gagal memuat vendor catering', err)
      }
    }
    loadVendors().catch(() => {})
  }, [])

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

  const isPom = (k: string) => /pom/i.test(k || '') && /cater/i.test(k || '')
  const isGalon = (k: string) => /galon/i.test(k || '')
  const viewItems = items

  const renderDetails = (r: TaskEntry) => {
    const e = r.extra || {}
    if (isPom(r.kind)) {
      const parts = []
      if (e.source === 'sheet' && e.sheet_date && e.sheet_shift) {
        parts.push(`Sheet: ${String(e.sheet_date)} (${String(e.sheet_shift)})`)
      }
      if (e.vendor || e.vendor_name) parts.push(`Vendor: ${String(e.vendor || e.vendor_name)}`)
      if (e.pom_status) parts.push(`Status: ${String(e.pom_status)}`)
      if (e.arrived_at) parts.push(`Datang: ${fmtDateTime(String(e.arrived_at))}`)
      if (typeof e.total_taken === 'number' && Number.isFinite(e.total_taken)) parts.push(`Diambil: ${String(e.total_taken)}`)
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
        const bc = typeof e.box_count === 'number' ? e.box_count : (typeof e.total_boxes_in === 'number' ? e.total_boxes_in : null)
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
      await refresh({ q, date, sort, limit, tab, offset: Math.max(0, (page - 1) * limit) })
    } catch (err: any) {
      toast.push(String(err?.message || err || 'Gagal mengubah'), 'error')
    } finally {
      setBusy(false)
    }
  }

  const doDelete = async (r: TaskEntry) => {
    if (!canAdmin) return
    const ok = await confirm.confirm({
      title: 'Delete Tugas',
      message: 'Hapus tugas ini secara permanen? Tindakan ini tidak bisa dibatalkan.',
      confirmText: 'Delete',
      cancelText: 'Batal',
    })
    if (!ok) return
    try {
      await apiPost(`/api/tasks/${r.id}/delete`, {})
      toast.push('Tugas dihapus', 'success')
      await refresh({ q, date, sort, limit, tab, offset: Math.max(0, (page - 1) * limit) })
    } catch (err: any) {
      toast.push(String(err?.message || err || 'Gagal delete'), 'error')
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
      setPage(1)
      await refresh({ q, date, sort, limit, tab, offset: 0 })
    } catch (err: any) {
      const msg = String(err?.message || err || 'Gagal menyimpan')
      setFormError(msg)
      toast.push(msg, 'error')
    } finally {
      setBusy(false)
    }
  }

  const closePhoto = useCallback(() => {
    if (photoView) URL.revokeObjectURL(photoView)
    setPhotoView(null)
    setAttachments([])
    setActiveAttachment(null)
  }, [photoView])

  const photoTabs = useMemo(
    () =>
      (attachments || [])
        .filter((a) => a && typeof a.id === 'number')
        .map((a) => ({ id: a.id as number, label: a.kind || 'Foto' })),
    [attachments],
  )

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

      {tab === 'pom' ? (
        <section className="card" id="pomSheet">
          <header className="card-header">
            <div className="card-title">Pom Catering (Sheet)</div>
            <div className="muted">
              {pomLoading
                ? 'Memuat...'
                : `Tanggal: ${date || today} · Shift: ${pomShift === 'siang' ? 'Siang' : pomShift === 'sore' ? 'Sore' : 'Malam'}`}
              {pomUpdatedAt ? ` · Update: ${fmtTime(pomUpdatedAt)}` : ''}
            </div>
          </header>
          <div className="card-body pom-sheet">
            {pomError ? <div className="inline-error" style={{ marginBottom: 12 }}>{pomError}</div> : null}
            <div className="grid grid-2" style={{ gap: 12, marginBottom: 12 }}>
              <div className="field">
                <label className="label" htmlFor="pomStaff">
                  Nama
                </label>
                <input className="input" id="pomStaff" value={pomStaffName} onChange={(e) => setPomStaffName(e.target.value)} placeholder="Nama petugas" />
              </div>
              <div className="field">
                <label className="label" htmlFor="pomDate">
                  Tanggal
                </label>
                <input className="input" id="pomDate" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </div>
            </div>
            <div className="tabsbar tabsbar-sub" style={{ marginBottom: 12, marginTop: 4 }}>
              <div className="tabs tabs-sm">
                <button
                  type="button"
                  className={`tab${pomShift === 'siang' ? ' tab-active' : ''}`}
                  onClick={() => {
                    setPomShift('siang')
                    loadPomSheet('siang').catch(() => {})
                  }}
                >
                  Siang
                </button>
                <button
                  type="button"
                  className={`tab${pomShift === 'sore' ? ' tab-active' : ''}`}
                  onClick={() => {
                    setPomShift('sore')
                    loadPomSheet('sore').catch(() => {})
                  }}
                >
                  Sore
                </button>
                <button
                  type="button"
                  className={`tab${pomShift === 'malam' ? ' tab-active' : ''}`}
                  onClick={() => {
                    setPomShift('malam')
                    loadPomSheet('malam').catch(() => {})
                  }}
                >
                  Malam
                </button>
              </div>
            </div>
            <div className="field" style={{ marginBottom: 12 }}>
              <label className="label" htmlFor="pomVendor">
                Vendor
              </label>
              <select
                className="select"
                id="pomVendor"
                value={pomVendorName}
                onChange={(e) => setPomVendorName(e.target.value)}
              >
                <option value="">Pilih vendor</option>
                {cateringVendors.map((v) => (
                  <option key={`${v.id ?? v.name}`} value={v.name}>
                    {v.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid grid-2" style={{ gap: 12, marginBottom: 12 }}>
              <div className="field">
                <label className="label" htmlFor="pomTotalIn">
                  Total box datang (hari ini)
                </label>
                <div className="number-stepper">
                  <button
                    className="stepper-btn"
                    type="button"
                    onClick={() => setPomTotalBoxesIn((n) => Math.max(0, (parseInt(String(n), 10) || 0) - 1))}
                    disabled={pomLoading || pomSaving}
                    aria-label="Kurangi total box datang"
                  >
                    -
                  </button>
                  <input
                    className="input"
                    id="pomTotalIn"
                    type="number"
                    min={0}
                    step={1}
                    value={pomTotalBoxesIn}
                    onChange={(e) => (e.target.value === '' ? setPomTotalBoxesIn('') : setPomTotalBoxesIn(Math.max(0, parseInt(e.target.value, 10) || 0)))}
                    disabled={pomLoading || pomSaving}
                  />
                  <button
                    className="stepper-btn"
                    type="button"
                    onClick={() => setPomTotalBoxesIn((n) => Math.max(0, (parseInt(String(n), 10) || 0) + 1))}
                    disabled={pomLoading || pomSaving}
                    aria-label="Tambah total box datang"
                  >
                    +
                  </button>
                </div>
                {pomShift !== 'siang' && (
                  <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
                    {pomShift === 'sore' ? `Sisa box (Siang): ${pomPrevLeftovers.siang}` : `Sisa box (Siang): ${pomPrevLeftovers.siang} · Sisa box (Sore): ${pomPrevLeftovers.sore}`}
                  </div>
                )}
              </div>
              <div className="card" style={{ padding: 12, borderRadius: 12, border: '1px solid var(--border)', background: 'var(--soft-bg)' }}>
                <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>Ringkasan shift ini</div>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <div>Total datang</div>
                  <div style={{ fontWeight: 800 }}>{pomTotalBoxesIn}</div>
                </div>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <div>Total jatah</div>
                  <div style={{ fontWeight: 800 }}>{pomTotals.jatah}</div>
                </div>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <div>Total diambil</div>
                  <div style={{ fontWeight: 800 }}>{pomTotals.taken}</div>
                </div>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <div>{pomRemaining >= 0 ? 'Sisa box' : 'Kurang box'}</div>
                  <div style={{ fontWeight: 800 }}>{pomRemaining >= 0 ? pomRemaining : Math.abs(pomRemaining)}</div>
                </div>
              </div>
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>No</th>
                    <th>Unit</th>
                    <th>Jatah</th>
                    <th>Jumlah Diambil</th>
                    <th>Penanggung jawab</th>
                    <th>Keterangan</th>
                    <th>Aksi</th>
                  </tr>
                </thead>
                <tbody>
                  {pomRows.map((r, idx) => {
                    const isEditing = pomEditRowIdx === idx
                    return (
                      <tr key={`${idx}:${r.unit}`}>
                        <td>{idx + 1}</td>
                        <td>{r.unit}</td>
                        <td>
                          <div className={`number-stepper number-stepper-sm${pomOverCapRowIdx === idx ? ' stepper-overcap' : ''}`}>
                            <button
                              className="stepper-btn stepper-btn-sm"
                              type="button"
                              onClick={() => setPomRowCapped(idx, { jatah: Math.max(0, (parseInt(String(r.jatah), 10) || 0) - 1) })}
                              disabled={!isEditing}
                              aria-label={`Kurangi jatah ${r.unit}`}
                            >
                              -
                            </button>
                            <input
                              className="input input-sm"
                              type="number"
                              min={0}
                              step={1}
                              value={r.jatah}
                              onChange={(e) => (e.target.value === '' ? setPomRowCapped(idx, { jatah: '' }) : setPomRowCapped(idx, { jatah: Math.max(0, parseInt(e.target.value, 10) || 0) }))}
                              disabled={!isEditing}
                            />
                            <button
                              className="stepper-btn stepper-btn-sm"
                              type="button"
                              onClick={() => setPomRowCapped(idx, { jatah: Math.max(0, (parseInt(String(r.jatah), 10) || 0) + 1) })}
                              disabled={!isEditing}
                              aria-label={`Tambah jatah ${r.unit}`}
                            >
                              +
                            </button>
                          </div>
                        </td>
                        <td>
                          <div className={`number-stepper number-stepper-sm${pomOverCapRowIdx === idx ? ' stepper-overcap' : ''}`}>
                            <button
                              className="stepper-btn stepper-btn-sm"
                              type="button"
                              onClick={() => setPomRowCapped(idx, { taken: Math.max(0, (parseInt(String(r.taken), 10) || 0) - 1) })}
                              disabled={!isEditing}
                              aria-label={`Kurangi jumlah diambil ${r.unit}`}
                            >
                              -
                            </button>
                            <input
                              className="input input-sm"
                              type="number"
                              min={0}
                              step={1}
                              value={r.taken}
                              onChange={(e) => (e.target.value === '' ? setPomRowCapped(idx, { taken: '' }) : setPomRowCapped(idx, { taken: Math.max(0, parseInt(e.target.value, 10) || 0) }))}
                              disabled={!isEditing}
                            />
                            <button
                              className="stepper-btn stepper-btn-sm"
                              type="button"
                              onClick={() => setPomRowCapped(idx, { taken: Math.max(0, (parseInt(String(r.taken), 10) || 0) + 1) })}
                              disabled={!isEditing}
                              aria-label={`Tambah jumlah diambil ${r.unit}`}
                            >
                              +
                            </button>
                          </div>
                        </td>
                        <td>
                          <input
                            className="input input-sm"
                            value={r.person}
                            onChange={(e) => setPomRow(idx, { person: e.target.value })}
                            disabled={!isEditing}
                            placeholder="Nama penanggung jawab"
                          />
                        </td>
                        <td>
                          <input className="input input-sm" value={r.note} onChange={(e) => setPomRow(idx, { note: e.target.value })} disabled={!isEditing} />
                        </td>
                        <td>
                          <button
                            className={`button button-sm ${isEditing ? 'button-primary' : 'button-secondary'}`}
                            type="button"
                            onClick={() => {
                              if (isEditing) {
                                setPomRowCapped(idx, { jatah: r.jatah === '' ? 0 : r.jatah, taken: r.taken === '' ? 0 : r.taken })
                                setPomEditRowIdx(null)
                                return
                              }
                              setPomEditRowIdx(idx)
                            }}
                            disabled={pomLoading || pomSaving}
                          >
                            {isEditing ? 'Selesai' : 'Edit'}
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                  <tr>
                    <td colSpan={2} style={{ fontWeight: 800 }}>
                      TOTAL
                    </td>
                    <td style={{ fontWeight: 800 }}>{pomTotals.jatah}</td>
                    <td style={{ fontWeight: 800 }}>{pomTotals.taken}</td>
                    <td />
                    <td />
                    <td />
                  </tr>
                </tbody>
              </table>
            </div>
            <div className="row row-right" style={{ marginTop: 12 }}>
              <button className="button button-secondary" type="button" onClick={() => loadPomSheet().catch(() => {})} disabled={pomSaving || pomLoading}>
                Refresh
              </button>
              <button className="button button-primary" type="button" onClick={() => savePomSheet().catch(() => {})} disabled={pomSaving || pomLoading}>
                {pomSaving ? 'Menyimpan...' : 'Simpan'}
              </button>
            </div>
          </div>
        </section>
      ) : (
        <section className="card" id="tasksForm">
          <header className="card-header">
            <div className="card-title">{tab === 'galon' ? 'Galon' : 'Catat tugas'}</div>
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
              {(tab as string) === 'pom' && (
                <>
                  <div className="field">
                    <label className="label" htmlFor="taskPomVendor">
                      Vendor
                    </label>
                    <select
                      className="select"
                      id="taskPomVendor"
                      value={vendor}
                      onChange={(e) => setVendor(e.target.value)}
                    >
                      <option value="">Pilih vendor</option>
                      {cateringVendors.map((v) => (
                        <option key={`${v.id ?? v.name}`} value={v.name}>
                          {v.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label className="label" htmlFor="taskPomStatus">
                      Status POM
                    </label>
                    <select
                      className="select"
                      id="taskPomStatus"
                      value={pomStatus}
                      onChange={(e) => setPomStatus(e.target.value as any)}
                    >
                      <option value="Dijadwalkan">Dijadwalkan</option>
                      <option value="Datang">Datang</option>
                      <option value="Selesai">Selesai</option>
                      <option value="Bermasalah">Bermasalah</option>
                    </select>
                  </div>
                  <div className="field">
                    <label className="label" htmlFor="taskPomArrived">
                      Jam catering datang
                    </label>
                    <input
                      className="input"
                      id="taskPomArrived"
                      type="time"
                      value={pomArrivedTime}
                      onChange={(e) => setPomArrivedTime(e.target.value)}
                    />
                  </div>
                  <div className="field">
                    <label className="label" htmlFor="taskPomBoxCount">
                      Jumlah box
                    </label>
                    <div className="number-stepper">
                      <button
                        className="stepper-btn"
                        type="button"
                        onClick={() => setBoxCount(String(Math.max(0, (parseInt(boxCount, 10) || 0) - 1)))}
                        aria-label="Kurangi jumlah box"
                      >
                        -
                      </button>
                      <input
                        className="input"
                        id="taskPomBoxCount"
                        type="number"
                        min={0}
                        step={1}
                        value={boxCount}
                        onChange={(e) => setBoxCount(e.target.value)}
                        placeholder="0"
                      />
                      <button
                        className="stepper-btn"
                        type="button"
                        onClick={() => setBoxCount(String((parseInt(boxCount, 10) || 0) + 1))}
                        aria-label="Tambah jumlah box"
                      >
                        +
                      </button>
                    </div>
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
      )}

      {tab === 'pom' && (
        <section className="card">
          <header className="card-header">
            <div className="card-title">Riwayat sheet POM</div>
            <div className="muted">{pomHistoryLoading ? 'Memuat...' : `${pomHistoryItems.length} entri (per shift)`}</div>
          </header>
          <div className="card-body">
            {pomHistoryLoading && <LoadingScreen mode="inline" label="Loading..." minHeight={260} />}
            <div className="table-wrap" aria-hidden={pomHistoryLoading}>
              <table className="table table-mobile-cards">
                <thead>
                  <tr>
                    <th>Tanggal</th>
                    <th>Shift</th>
                    <th>Vendor</th>
                    <th>Total datang</th>
                    <th>Total jatah</th>
                    <th>Total diambil</th>
                    <th>Update</th>
                    <th>Aksi</th>
                  </tr>
                </thead>
                <tbody>
                  {pomHistoryItems.map((h) => (
                    <tr key={`${h.date}:${h.shift}`}>
                      <td data-label="Tanggal">{h.date}</td>
                      <td data-label="Shift">{h.shift === 'siang' ? 'Siang' : h.shift === 'sore' ? 'Sore' : 'Malam'}</td>
                      <td data-label="Vendor">{h.vendor_name || <span className="muted">-</span>}</td>
                      <td data-label="Total datang">{h.total_boxes_in}</td>
                      <td data-label="Total jatah">{h.total_jatah}</td>
                      <td data-label="Total diambil">{h.total_taken}</td>
                      <td data-label="Update">{h.updated_at ? fmtTime(h.updated_at) : <span className="muted">-</span>}</td>
                      <td data-label="Aksi">
                        <div className="card-actions">
                          <button
                            className="button button-sm button-secondary"
                            type="button"
                            onClick={() => {
                              ;(async () => {
                                await loadPomSheet(h.shift, h.date)
                                document.getElementById('pomSheet')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                                toast.push(`Sheet ${h.date} (${h.shift === 'siang' ? 'Siang' : h.shift === 'sore' ? 'Sore' : 'Malam'}) dimuat`, 'success')
                              })().catch((err: any) => {
                                toast.push(String(err?.message || err || 'Gagal membuka sheet'), 'error')
                              })
                            }}
                            disabled={pomLoading || pomSaving}
                          >
                            Buka
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {pomHistoryItems.length === 0 && (
                    <tr>
                      <td className="muted" colSpan={8}>
                        Belum ada data sheet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="row row-right" style={{ marginTop: 12 }}>
              <button className="button button-secondary" type="button" onClick={() => loadPomHistory().catch(() => {})} disabled={pomHistoryLoading}>
                Refresh
              </button>
            </div>
          </div>
        </section>
      )}

      <section className="card">
        <header className="card-header">
          <div className="card-title">{tab === 'pom' ? 'Daftar tugas (Log POM)' : 'Daftar tugas'}</div>
          <div className="muted">
            {loading ? 'Memuat...' : `${viewItems.length} entri`}
            {summary.kind === 'pom' ? ` · Total box: ${summary.totalBox}${summary.lastArrived ? ` · Terakhir datang: ${fmtTime(summary.lastArrived)}` : ''}${summary.bermasalah ? ` · Bermasalah: ${summary.bermasalah}` : ''}` : ''}
            {summary.kind === 'galon' ? ` · Dipakai: ${summary.used} · Tidak dipakai: ${summary.unused} · Dikembalikan: ${summary.returned}` : ''}
          </div>
        </header>
        <div className="card-body">
          {loading && <LoadingScreen mode="inline" label="Loading..." minHeight={320} />}
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
              <button
                className="button button-secondary button-sm"
                type="button"
                onClick={() => {
                  setPage(1)
                  refresh({ q, date, sort, limit, tab, offset: 0 }).catch(() => {})
                }}
              >
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
          <div className="table-wrap" aria-hidden={loading}>
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
                {viewItems.map((r) => {
                  const detailText = renderDetails(r)
                  const e: any = r.extra || {}
                  const canOpenSheet = isPom(r.kind) && e.source === 'sheet' && e.sheet_date && e.sheet_shift
                  return (
                    <tr key={r.id} className={r.status === 'void' ? 'table-row-void' : undefined}>
                      <td data-label="Waktu">{fmtDateTime(r.occurred_at)}</td>
                      <td data-label="Jenis">{r.kind}</td>
                      <td data-label="Tujuan">{r.destination}</td>
                      <td data-label="Detail">
                        {detailText ? detailText : <span className="muted">-</span>}
                        {canOpenSheet && (
                          <div style={{ marginTop: 6 }}>
                            <button className="button button-sm button-secondary" type="button" onClick={() => openPomSheetFromLog(e.sheet_date, e.sheet_shift)}>
                              Lihat sheet
                            </button>
                          </div>
                        )}
                      </td>
                      <td data-label="Catatan">
                        {r.notes}
                        {r.status === 'void' && r.void_reason ? <div className="muted">Deleted: {r.void_reason}</div> : null}
                      </td>
                      <td data-label="Status">{r.status === 'void' ? <span className="badge badge-danger">Deleted</span> : <span className="badge badge-ok">Aktif</span>}</td>
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
                            {r.status === 'void' ? (
                              <span className="muted">—</span>
                            ) : (
                              <>
                                <button className="button button-sm button-secondary" type="button" onClick={() => doEdit(r)}>
                                  ✎ Edit
                                </button>
                                <button className="button button-sm button-danger" type="button" onClick={() => doDelete(r)}>
                                  Delete
                                </button>
                              </>
                            )}
                          </div>
                        </td>
                      )}
                    </tr>
                  )
                })}
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
            ;(async () => {
              setActiveAttachment(a)
              await loadPhotoUrl(a.url)
            })().catch(() => {})
          }}
          onClose={closePhoto}
        />
      )}

      {editRow && (
        <Modal open={true} ariaLabel="Edit tugas" onClose={() => setEditRow(null)}>
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
                      <div className="number-stepper">
                        <button
                          className="stepper-btn"
                          type="button"
                          onClick={() => setEditBoxCount(String(Math.max(0, (parseInt(editBoxCount, 10) || 0) - 1)))}
                          disabled={busy}
                          aria-label="Kurangi box"
                        >
                          -
                        </button>
                        <input
                          className="input"
                          type="number"
                          min={0}
                          step={1}
                          value={editBoxCount}
                          onChange={(e) => setEditBoxCount(e.target.value)}
                          placeholder="0"
                          disabled={busy}
                        />
                        <button
                          className="stepper-btn"
                          type="button"
                          onClick={() => setEditBoxCount(String((parseInt(editBoxCount, 10) || 0) + 1))}
                          disabled={busy}
                          aria-label="Tambah box"
                        >
                          +
                        </button>
                      </div>
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
                      <div className="number-stepper">
                        <button
                          className="stepper-btn"
                          type="button"
                          onClick={() => setEditGalonUsed(String(Math.max(0, (parseInt(editGalonUsed, 10) || 0) - 1)))}
                          disabled={busy}
                          aria-label="Kurangi galon dipakai"
                        >
                          -
                        </button>
                        <input
                          className="input"
                          type="number"
                          min={0}
                          step={1}
                          value={editGalonUsed}
                          onChange={(e) => setEditGalonUsed(e.target.value)}
                          placeholder="0"
                          disabled={busy}
                        />
                        <button
                          className="stepper-btn"
                          type="button"
                          onClick={() => setEditGalonUsed(String((parseInt(editGalonUsed, 10) || 0) + 1))}
                          disabled={busy}
                          aria-label="Tambah galon dipakai"
                        >
                          +
                        </button>
                      </div>
                    </div>
                    <div className="field">
                      <label className="label">Tidak Dipakai</label>
                      <div className="number-stepper">
                        <button
                          className="stepper-btn"
                          type="button"
                          onClick={() => setEditGalonUnused(String(Math.max(0, (parseInt(editGalonUnused, 10) || 0) - 1)))}
                          disabled={busy}
                          aria-label="Kurangi galon tidak dipakai"
                        >
                          -
                        </button>
                        <input
                          className="input"
                          type="number"
                          min={0}
                          step={1}
                          value={editGalonUnused}
                          onChange={(e) => setEditGalonUnused(e.target.value)}
                          placeholder="0"
                          disabled={busy}
                        />
                        <button
                          className="stepper-btn"
                          type="button"
                          onClick={() => setEditGalonUnused(String((parseInt(editGalonUnused, 10) || 0) + 1))}
                          disabled={busy}
                          aria-label="Tambah galon tidak dipakai"
                        >
                          +
                        </button>
                      </div>
                    </div>
                    <div className="field">
                      <label className="label">Dikembalikan</label>
                      <div className="number-stepper">
                        <button
                          className="stepper-btn"
                          type="button"
                          onClick={() => setEditGalonReturned(String(Math.max(0, (parseInt(editGalonReturned, 10) || 0) - 1)))}
                          disabled={busy}
                          aria-label="Kurangi galon dikembalikan"
                        >
                          -
                        </button>
                        <input
                          className="input"
                          type="number"
                          min={0}
                          step={1}
                          value={editGalonReturned}
                          onChange={(e) => setEditGalonReturned(e.target.value)}
                          placeholder="0"
                          disabled={busy}
                        />
                        <button
                          className="stepper-btn"
                          type="button"
                          onClick={() => setEditGalonReturned(String((parseInt(editGalonReturned, 10) || 0) + 1))}
                          disabled={busy}
                          aria-label="Tambah galon dikembalikan"
                        >
                          +
                        </button>
                      </div>
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
        </Modal>
      )}

      <button className="fab" type="button" onClick={() => document.getElementById('tasksForm')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
        + Tugas
      </button>
    </section>
  )
}
