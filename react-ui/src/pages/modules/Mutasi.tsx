import { FormEvent, useCallback, useEffect, useState } from 'react'
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
          <div className="table-wrap" aria-busy={loading}>
            <table className="table table-mobile-cards">
              <thead>
                <tr>
                  <th>Jam</th>
                  <th>Jenis</th>
                  <th>Deskripsi</th>
                  <th>Status</th>
                  <th>Foto</th>
                  <th>Petugas</th>
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
                  : items.map((r) => (
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
                {!loading && items.length === 0 && (
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
