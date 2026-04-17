import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { apiGet, apiGetBlob, apiPost, apiPostForm } from '../../lib/api'
import type { Me, TaskEntry } from '../../types'
import { fmtDateTime, nowHm, shiftHm, toIsoLocal, toYmd } from '../../lib/time'
import { useToast } from '../../components/ToastHost'

export default function TasksPage({ me }: { me: Me }) {
  const toast = useToast()
  const today = toYmd(new Date())
  const draftKey = useMemo(() => `draft:tasks:${me.user.id}`, [me.user.id])
  const [q, setQ] = useState('')
  const [date, setDate] = useState(today)
  const [sort, setSort] = useState<'occurred_desc' | 'occurred_asc'>('occurred_desc')
  const [limit, setLimit] = useState(200)
  const [items, setItems] = useState<TaskEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState<string>('')

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
  const [photo, setPhoto] = useState<File | null>(null)
  const [photoKey, setPhotoKey] = useState(0)
  const [photoView, setPhotoView] = useState<string | null>(null)

  const refresh = useCallback(async (opts: { q: string; date: string; sort: string; limit: number }) => {
    const { q, date, sort, limit } = opts
    setLoading(true)
    try {
      const res = await apiGet<{ items: TaskEntry[] }>(
        `/api/tasks?q=${encodeURIComponent(q)}&date=${encodeURIComponent(date)}&sort=${encodeURIComponent(sort)}&limit=${encodeURIComponent(String(limit))}`,
      )
      setItems(res.items || [])
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
    refresh({ q: '', date: today, sort: 'occurred_desc', limit: 200 }).catch(() => {})
  }, [refresh, today])

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
      const occurredAt = toIsoLocal(today, time)
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
        const arrivedAt = pomArrivedTime ? toIsoLocal(today, pomArrivedTime) : null
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
      if (photo) {
        const form = new FormData()
        form.set('kind', payload.kind)
        form.set('occurred_at', payload.occurred_at)
        form.set('destination', payload.destination)
        form.set('notes', payload.notes)
        if (payload.extra) form.set('extra_json', JSON.stringify(payload.extra))
        form.set('photo', photo)
        await apiPostForm('/api/tasks_with_photo', form)
      } else {
        await apiPost('/api/tasks', payload)
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
      setPhoto(null)
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
          <button type="button" className={`tab${tab === 'umum' ? ' tab-active' : ''}`} onClick={() => setTab('umum')}>Umum</button>
          <button type="button" className={`tab${tab === 'pom' ? ' tab-active' : ''}`} onClick={() => setTab('pom')}>Pom Catering</button>
          <button type="button" className={`tab${tab === 'galon' ? ' tab-active' : ''}`} onClick={() => setTab('galon')}>Galon</button>
        </div>
      </div>
      <div className="section-header">
        <h2 className="h2">Tugas Operasional Security</h2>
        <div className="section-actions">
          <input className="input input-sm" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Cari tugas..." />
          <input className="input input-sm" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <select className="select select-sm" value={sort} onChange={(e) => setSort(e.target.value as any)}>
            <option value="occurred_desc">Terbaru</option>
            <option value="occurred_asc">Terlama</option>
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
                  <input className="input" id="taskPomBox" type="number" min={0} step={1} value={boxCount} onChange={(e) => setBoxCount(e.target.value)} placeholder="0" />
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
                  <input className="input" id="taskGalonUsed" type="number" min={0} step={1} value={galonUsed} onChange={(e) => setGalonUsed(e.target.value)} placeholder="0" />
                </div>
                <div className="field">
                  <label className="label" htmlFor="taskGalonUnused">
                    Galon tidak dipakai
                  </label>
                  <input className="input" id="taskGalonUnused" type="number" min={0} step={1} value={galonUnused} onChange={(e) => setGalonUnused(e.target.value)} placeholder="0" />
                </div>
                <div className="field">
                  <label className="label" htmlFor="taskGalonReturned">
                    Galon dikembalikan
                  </label>
                  <input className="input" id="taskGalonReturned" type="number" min={0} step={1} value={galonReturned} onChange={(e) => setGalonReturned(e.target.value)} placeholder="0" />
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
                Jam
              </label>
              <div className="time-row">
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
              <div className="muted">Akan tersimpan: {fmtDateTime(toIsoLocal(today, time))}</div>
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
                Foto (opsional)
              </label>
              <input
                key={photoKey}
                className="input"
                id="taskPhoto"
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
                    const ok = window.confirm('Hapus draft input tugas?')
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
        </div>
      </section>

      <section className="card">
        <header className="card-header">
          <div className="card-title">Daftar tugas</div>
          <div className="muted">{loading ? 'Memuat...' : `${viewItems.length} entri`}</div>
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
                  <th>Foto</th>
                  <th>Petugas</th>
                </tr>
              </thead>
              <tbody>
                {viewItems.map((r) => (
                  <tr key={r.id}>
                    <td data-label="Waktu">{fmtDateTime(r.occurred_at)}</td>
                    <td data-label="Jenis">{r.kind}</td>
                    <td data-label="Tujuan">{r.destination}</td>
                    <td data-label="Detail">{renderDetails(r) || <span className="muted">-</span>}</td>
                    <td data-label="Catatan">{r.notes}</td>
                    <td data-label="Foto">
                      {r.has_photo && r.photo_url ? (
                        <button className="button button-sm button-secondary" type="button" onClick={() => openPhoto(r.photo_url!)}>
                          Foto
                        </button>
                      ) : (
                        <span className="muted">-</span>
                      )}
                    </td>
                    <td data-label="Petugas">{r.created_by_name || '-'}</td>
                  </tr>
                ))}
                {viewItems.length === 0 && (
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

      <button className="fab" type="button" onClick={() => document.getElementById('tasksForm')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
        + Tugas
      </button>
    </section>
  )
}
