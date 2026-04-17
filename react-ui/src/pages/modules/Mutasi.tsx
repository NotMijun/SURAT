import { FormEvent, useCallback, useEffect, useState } from 'react'
import { apiGet, apiGetBlob, apiPatch, apiPost, apiPostForm } from '../../lib/api'
import type { Me, MutasiEntry } from '../../types'
import { fmtDateTime, fmtTime, nowHm, shiftHm, toIsoLocal, toYmd } from '../../lib/time'
import { useToast } from '../../components/ToastHost'

const KATEGORI_OPTS: Record<string, string[]> = {
  'Kejadian Operasional': ['Catering', 'Galon', 'Patroli/Ronda', 'Pemeliharaan', 'Lainnya'],
  'Kejadian Khusus': ['Komplain', 'Kehilangan', 'Kecelakaan', 'Keributan', 'Lainnya'],
  Lainnya: ['Lainnya'],
}

export default function MutasiPage({ me }: { me: Me }) {
  const toast = useToast()
  const today = toYmd(new Date())
  const draftKey = `draft:mutasi:${me.user.id}`
  const [q, setQ] = useState('')
  const [filterKategori, setFilterKategori] = useState('')
  const [filterSub, setFilterSub] = useState('')
  const [date, setDate] = useState(today)
  const [sort, setSort] = useState<'occurred_desc' | 'occurred_asc'>('occurred_desc')
  const [limit, setLimit] = useState(200)
  const [items, setItems] = useState<MutasiEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState<string>('')

  const [kategori, setKategori] = useState('Kejadian Operasional')
  const [subKategori, setSubKategori] = useState('Catering')
  const [time, setTime] = useState(nowHm())
  const [desc, setDesc] = useState('')
  const [photo, setPhoto] = useState<File | null>(null)
  const [photoKey, setPhotoKey] = useState(0)
  const [photoView, setPhotoView] = useState<string | null>(null)

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

  const refresh = useCallback(async (opts: { q: string; date: string; sort: string; limit: number; fk: string; fs: string }) => {
    const { q, date, sort, limit, fk, fs } = opts
    setLoading(true)
    try {
      const res = await apiGet<{ items: MutasiEntry[] }>(
        `/api/mutasi?q=${encodeURIComponent(q.trim())}&kategori=${encodeURIComponent(fk)}&sub=${encodeURIComponent(fs)}&date=${encodeURIComponent(date)}&sort=${encodeURIComponent(sort)}&limit=${encodeURIComponent(String(limit))}&status=all`,
      )
      setItems(res.items || [])
    } catch (err: any) {
      toast.push(String(err?.message || err || 'Gagal memuat mutasi'), 'error')
    } finally {
      setLoading(false)
    }
  }, [toast])

  const fmtWhen = (iso: string | null | undefined) => (date ? fmtTime(iso) : fmtDateTime(iso))
  const canAdmin = me.user.role === 'admin' || me.user.role === 'supervisor'

  useEffect(() => {
    const t = window.setTimeout(() => refresh({ q, date, sort, limit, fk: filterKategori, fs: filterSub }).catch(() => {}), 250)
    return () => window.clearTimeout(t)
  }, [date, limit, q, refresh, sort, filterKategori, filterSub])

  useEffect(() => {
    refresh({ q: '', date: today, sort: 'occurred_desc', limit: 200, fk: '', fs: '' }).catch(() => {})
  }, [refresh, today])

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
      const payload = { kind: combinedKind, occurred_at: toIsoLocal(today, time), description: desc }
      try {
        if (photo) {
          const form = new FormData()
          form.set('kind', payload.kind)
          form.set('occurred_at', payload.occurred_at)
          form.set('description', payload.description)
          form.set('photo', photo)
          await apiPostForm('/api/mutasi_with_photo', form)
        } else {
          await apiPost('/api/mutasi', payload)
        }
      } catch (err: any) {
        if (err?.status === 409) {
          const ok = window.confirm(`${String(err?.message || 'Data serupa sudah ada')}\n\nTetap simpan?`)
          if (!ok) throw err
          if (photo) {
            const form = new FormData()
            form.set('kind', payload.kind)
            form.set('occurred_at', payload.occurred_at)
            form.set('description', payload.description)
            form.set('force', 'true')
            form.set('photo', photo)
            await apiPostForm('/api/mutasi_with_photo', form)
          } else {
            await apiPost('/api/mutasi', { ...payload, force: true })
          }
        } else {
          throw err
        }
      }
      setDesc('')
      setPhoto(null)
      setPhotoKey((x) => x + 1)
      localStorage.removeItem(draftKey)
      toast.push('Mutasi dicatat', 'success')
      await refresh({ q, date, sort, limit, fk: filterKategori, fs: filterSub })
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

  const doEdit = async (r: MutasiEntry) => {
    if (!canAdmin) return
    if (r.status === 'void') return
    const next = window.prompt('Ubah deskripsi mutasi:', r.description || '')
    if (next == null) return
    const value = next.trim()
    if (!value) return
    try {
      await apiPatch(`/api/mutasi/${r.id}`, { description: value })
      toast.push('Mutasi diperbarui', 'success')
      await refresh({ q, date, sort, limit, fk: filterKategori, fs: filterSub })
    } catch (err: any) {
      toast.push(String(err?.message || err || 'Gagal mengubah'), 'error')
    }
  }

  const doVoid = async (r: MutasiEntry) => {
    if (!canAdmin) return
    if (r.status === 'void') return
    const reason = window.prompt('Alasan void:', '')
    if (reason == null) return
    const value = reason.trim()
    if (!value) return
    try {
      await apiPost(`/api/mutasi/${r.id}/void`, { reason: value })
      toast.push('Mutasi di-void', 'success')
      await refresh({ q, date, sort, limit, fk: filterKategori, fs: filterSub })
    } catch (err: any) {
      toast.push(String(err?.message || err || 'Gagal void'), 'error')
    }
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
      <div className="section-header">
        <h2 className="h2">Buku Mutasi</h2>
        <div className="section-actions">
          <input className="input input-sm" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Cari kejadian..." />
          <select className="select select-sm" value={filterKategori} onChange={(e) => { setFilterKategori(e.target.value); setFilterSub('') }}>
            <option value="">Semua Kategori</option>
            {Object.keys(KATEGORI_OPTS).map(k => <option key={k} value={k}>{k}</option>)}
          </select>
          {filterKategori && filterKategori !== 'Lainnya' && (
            <select className="select select-sm" value={filterSub} onChange={(e) => setFilterSub(e.target.value)}>
              <option value="">Semua Sub</option>
              {KATEGORI_OPTS[filterKategori].map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          )}
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
          <button className="button button-secondary button-sm" type="button" onClick={() => refresh({ q, date, sort, limit, fk: filterKategori, fs: filterSub })}>
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
                Jam
              </label>
              <div className="time-row">
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
              <div className="muted">Akan tersimpan: {fmtDateTime(toIsoLocal(today, time))}</div>
            </div>
            <div className="field grid-span-4">
              <label className="label" htmlFor="mutasiDesc">
                Deskripsi
              </label>
              <input className="input" id="mutasiDesc" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Ringkasan kejadian (misal: jumlah box catering kurang)" required />
            </div>
            <div className="field grid-span-4">
              <label className="label" htmlFor="mutasiPhoto">
                Foto (opsional)
              </label>
              <input
                key={photoKey}
                className="input"
                id="mutasiPhoto"
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
                    const ok = window.confirm('Hapus draft mutasi?')
                    if (!ok) return
                    localStorage.removeItem(draftKey)
                    setFormError('')
                    setKategori('Kejadian Operasional')
                    setSubKategori('Catering')
                    setTime(nowHm())
                    setDesc('')
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
          <div className="card-title">Daftar mutasi</div>
          <div className="muted">{loading ? 'Memuat...' : `${items.length} entri`}</div>
        </header>
        <div className="card-body">
          <div className="table-wrap">
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
                {items.map((r) => (
                  <tr key={r.id}>
                    <td data-label="Jam">{fmtWhen(r.occurred_at)}</td>
                    <td data-label="Jenis">{r.kind}</td>
                    <td data-label="Deskripsi">
                      {r.description}
                      {r.status === 'void' && r.void_reason ? <div className="muted">Void: {r.void_reason}</div> : null}
                    </td>
                    <td data-label="Status">{r.status === 'void' ? <span className="badge badge-danger">Void</span> : <span className="badge badge-ok">Aktif</span>}</td>
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
                    {canAdmin && (
                      <td data-label="Aksi">
                        {r.status === 'void' ? (
                          <span className="muted">—</span>
                        ) : (
                          <div className="row">
                            <button className="button button-sm" type="button" onClick={() => doEdit(r)}>
                              Edit
                            </button>
                            <button className="button button-sm button-danger" type="button" onClick={() => doVoid(r)}>
                              Void
                            </button>
                          </div>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
                {items.length === 0 && (
                  <tr>
                    <td className="muted" colSpan={canAdmin ? 7 : 6}>
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

      <button className="fab" type="button" onClick={() => document.getElementById('mutasiForm')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
        + Mutasi
      </button>
    </section>
  )
}
