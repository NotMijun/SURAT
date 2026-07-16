import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { apiGet, apiGetBlob, apiPatch, apiPost, apiPostForm } from '../../lib/api'
import type { Me } from '../../types'
import { compressImageFile } from '../../lib/image'
import { fmtDateTime, toYmd } from '../../lib/time'
import { useConfirm, useToast } from '../../components/ToastHost'
import Modal from '../../components/Modal'
import PhotoModal from '../../components/PhotoModal'
import Pagination from '../../components/Pagination'

type PatrolEntry = {
  id: number
  security_name: string
  patrol_date: string
  patrol_time: string
  location: string
  findings: string
  status?: string
  void_reason?: string | null
  voided_by?: number | null
  voided_at?: string | null
  photo_b64?: string | null
  photo_mime?: string | null
  photo_name?: string | null
  photo_uploaded_at?: string | null
  created_by: number
  created_by_name?: string
  shift: string
  post: string
  created_at: string
  updated_at: string
  photo_count?: number
  has_photo?: boolean
  photo_url?: string
}

export default function PatrolsPage({ me }: { me: Me }) {
  const toast = useToast()
  const confirm = useConfirm()
  const location = useLocation()
  const today = toYmd(new Date())
  const [q, setQ] = useState('')
  const [date, setDate] = useState('')
  const [sort, setSort] = useState<'date_desc' | 'date_asc'>('date_desc')
  const [limit, setLimit] = useState(200)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [items, setItems] = useState<PatrolEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState<string>('')
  const [filtersSheetOpen, setFiltersSheetOpen] = useState(false)
  const didInitFromUrlRef = useRef(false)

  const [addOpen, setAddOpen] = useState(false)
  const [editRow, setEditRow] = useState<PatrolEntry | null>(null)
  const [detailRow, setDetailRow] = useState<PatrolEntry | null>(null)
  const [photoModalUrl, setPhotoModalUrl] = useState<string | null>(null)

  const [editSecurityName, setEditSecurityName] = useState(me.user.display_name || '')
  const [editPatrolDate, setEditPatrolDate] = useState(today)
  const [editPatrolTime, setEditPatrolTime] = useState(
    new Date().toTimeString().slice(0, 5)
  )
  const [editLocation, setEditLocation] = useState('')
  const [editFindings, setEditFindings] = useState('')
  const [editPhotoFiles, setEditPhotoFiles] = useState<File[]>([])

  useEffect(() => {
    if (didInitFromUrlRef.current) return
    didInitFromUrlRef.current = true
    const qp = new URLSearchParams(location.search).get('q')
    if (qp && qp.trim()) setQ(qp)
  }, [location.search])

  const fetchData = useCallback(async () => {
    setLoading(true)
    const offset = (page - 1) * limit
    try {
      const r = await apiGet<{ items: PatrolEntry[]; total: number }>(
        `/api/patrols?q=${encodeURIComponent(q || '')}&date=${encodeURIComponent(date || '')}&sort=${sort}&limit=${limit}&offset=${offset}`
      )
      setItems(r.items)
      setTotal(r.total)
    } catch (err: any) {
      toast.push(String(err?.message || err || 'Gagal memuat data'), 'error')
    } finally {
      setLoading(false)
    }
  }, [q, date, sort, limit, page, toast])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const resetForm = () => {
    setEditRow(null)
    setEditSecurityName(me.user.display_name || '')
    setEditPatrolDate(today)
    setEditPatrolTime(new Date().toTimeString().slice(0, 5))
    setEditLocation('')
    setEditFindings('')
    setEditPhotoFiles([])
    setFormError('')
  }

  const openAdd = () => {
    resetForm()
    setAddOpen(true)
  }

  const openEdit = (row: PatrolEntry) => {
    resetForm()
    setEditRow(row)
    setEditSecurityName(row.security_name)
    setEditPatrolDate(row.patrol_date)
    setEditPatrolTime(row.patrol_time)
    setEditLocation(row.location)
    setEditFindings(row.findings)
    setAddOpen(true)
  }

  const handleSave = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setFormError('')
    try {
      if (editRow) {
        await apiPatch(`/api/patrols/${editRow.id}`, {
          security_name: editSecurityName,
          patrol_date: editPatrolDate,
          patrol_time: editPatrolTime,
          location: editLocation,
          findings: editFindings,
        })
        toast.push('Patroli diperbarui', 'success')
      } else {
        if (editPhotoFiles.length > 0) {
          const fd = new FormData()
          fd.set('security_name', editSecurityName)
          fd.set('patrol_date', editPatrolDate)
          fd.set('patrol_time', editPatrolTime)
          fd.set('location', editLocation)
          fd.set('findings', editFindings)
          fd.set('force', 'true')
          for (const f of editPhotoFiles) {
            const compressed = await compressImageFile(f)
            fd.append('photo', compressed, compressed.name)
          }
          await apiPostForm('/api/patrols_with_photo', fd)
        } else {
          await apiPost('/api/patrols', {
            security_name: editSecurityName,
            patrol_date: editPatrolDate,
            patrol_time: editPatrolTime,
            location: editLocation,
            findings: editFindings,
            force: true,
          })
        }
        toast.push('Patroli ditambahkan', 'success')
      }
      setAddOpen(false)
      fetchData()
    } catch (err: any) {
      setFormError(String(err?.message || err || 'Gagal menyimpan'))
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async (row: PatrolEntry) => {
    const ok = await confirm.confirm({
      title: 'Hapus patroli',
      message: 'Yakin ingin menghapus patroli ini?',
      confirmText: 'Hapus',
    })
    if (!ok) return
    setBusy(true)
    try {
      await apiPost(`/api/patrols/${row.id}/delete`, {})
      toast.push('Patroli dihapus', 'success')
      fetchData()
    } catch (err: any) {
      toast.push(String(err?.message || err || 'Gagal menghapus'), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card">
      <div className="card-header">
        <div>
          <h2 style={{ margin: 0 }}>Patroli</h2>
          <p className="muted" style={{ margin: '4px 0 0', fontSize: 14 }}>
            Catatan patroli keamanan
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            className="button button-secondary button-sm section-filter-toggle"
            type="button"
            onClick={() => setFiltersSheetOpen(true)}
          >
            Filter
          </button>
          <button className="button button-primary" type="button" onClick={openAdd}>
            Tambah Patroli
          </button>
        </div>
      </div>

      <div className="card-body filters-responsive">
        <div className="table-footer-filters">
          <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div style={{ flex: '1 1 200px' }}>
              <label className="label">Cari</label>
              <div className="search">
                <span className="search-icon">⌕</span>
                <input
                  className="search-input"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Nama security, lokasi, temuan..."
                />
              </div>
            </div>
            <div style={{ minWidth: 120 }}>
              <label className="label">Tanggal</label>
              <input
                type="date"
                className="input"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </div>
            <div style={{ minWidth: 140 }}>
              <label className="label">Urutan</label>
              <select className="select" value={sort} onChange={(e) => setSort(e.target.value as any)}>
                <option value="date_desc">Terbaru dulu</option>
                <option value="date_asc">Terlama dulu</option>
              </select>
            </div>
            {(q || date) && (
              <button
                className="button button-secondary button-sm"
                type="button"
                onClick={() => {
                  setQ('')
                  setDate('')
                }}
              >
                Reset
              </button>
            )}
          </div>
        </div>

        <div className="table-container">
          <table className="table table-mobile-cards">
            <thead>
              <tr>
                <th>Tanggal & Waktu</th>
                <th>Petugas</th>
                <th>Lokasi</th>
                <th>Temuan</th>
                <th style={{ width: 120 }}>Aksi</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={5}>
                    <div style={{ padding: 24, textAlign: 'center' }}>
                      <span className="shimmer shimmer-inline" />
                    </div>
                  </td>
                </tr>
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan={5} style={{ textAlign: 'center', padding: 32 }}>
                    <span className="muted">Belum ada data</span>
                  </td>
                </tr>
              ) : (
                items.map((r) => (
                  <tr key={r.id}>
                    <td data-label="Tanggal & Waktu">
                      <div style={{ display: 'grid', gap: 2 }}>
                        <span>{r.patrol_date}</span>
                        <span className="muted">{r.patrol_time}</span>
                      </div>
                    </td>
                    <td data-label="Petugas">
                      <div style={{ display: 'grid', gap: 2 }}>
                        <span>{r.security_name}</span>
                        <span className="muted" style={{ fontSize: 12 }}>
                          {r.created_by_name} · {r.shift} · {r.post}
                        </span>
                      </div>
                    </td>
                    <td data-label="Lokasi">
                      {r.location}
                      {r.has_photo && <span style={{ marginLeft: 6 }}>📷</span>}
                    </td>
                    <td data-label="Temuan">{r.findings}</td>
                    <td data-label="Aksi">
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button
                          className="button button-secondary button-sm"
                          type="button"
                          onClick={() => setDetailRow(r)}
                        >
                          Lihat
                        </button>
                        <button
                          className="button button-secondary button-sm"
                          type="button"
                          onClick={() => openEdit(r)}
                          disabled={busy}
                        >
                          Edit
                        </button>
                        <button
                          className="button button-danger button-sm"
                          type="button"
                          onClick={() => handleDelete(r)}
                          disabled={busy}
                        >
                          Hapus
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {total > limit && (
          <div className="card-footer">
            <Pagination
              total={total}
              limit={limit}
              page={page}
              setPage={setPage}
              setLimit={setLimit}
            />
          </div>
        )}
      </div>

      <Modal open={addOpen} ariaLabel="Tambah/Edit Patroli" onClose={() => setAddOpen(false)}>
        <div className="modal-header">
          <div className="modal-title">{editRow ? 'Edit Patroli' : 'Tambah Patroli'}</div>
          <button
            className="button button-secondary button-sm"
            type="button"
            onClick={() => setAddOpen(false)}
          >
            Tutup
          </button>
        </div>
        <div className="modal-body">
          {formError && (
            <div
              className="card"
              style={{ marginBottom: 16, background: 'var(--color-danger-5)', border: '1px solid var(--color-danger-30)' }}
            >
              <div className="card-body">
                <strong style={{ color: 'var(--color-danger-60)' }}>Kesalahan:</strong> {formError}
              </div>
            </div>
          )}
          <form onSubmit={handleSave}>
            <div className="grid" style={{ gap: 12 }}>
              <div>
                <label className="label">Nama Security</label>
                <input
                  className="input"
                  data-autofocus="true"
                  value={editSecurityName}
                  onChange={(e) => setEditSecurityName(e.target.value)}
                  placeholder="Nama petugas"
                  required
                />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <label className="label">Tanggal</label>
                  <input
                    type="date"
                    className="input"
                    value={editPatrolDate}
                    onChange={(e) => setEditPatrolDate(e.target.value)}
                    required
                  />
                </div>
                <div>
                  <label className="label">Waktu</label>
                  <input
                    type="time"
                    className="input"
                    value={editPatrolTime}
                    onChange={(e) => setEditPatrolTime(e.target.value)}
                    required
                  />
                </div>
              </div>
              <div>
                <label className="label">Lokasi</label>
                <input
                  className="input"
                  value={editLocation}
                  onChange={(e) => setEditLocation(e.target.value)}
                  placeholder="Lokasi patroli"
                  required
                />
              </div>
              <div>
                <label className="label">Temuan / Hasil</label>
                <textarea
                  className="textarea"
                  value={editFindings}
                  onChange={(e) => setEditFindings(e.target.value)}
                  placeholder="Temuan atau hasil patroli"
                  rows={4}
                  required
                />
              </div>
              {!editRow && (
                <div>
                  <label className="label">Foto (opsional)</label>
                  <input
                    type="file"
                    className="input"
                    accept="image/*"
                    multiple
                    onChange={(e) => {
                      const files = Array.from(e.target.files || [])
                      setEditPhotoFiles(files)
                    }}
                  />
                  {editPhotoFiles.length > 0 && (
                    <div style={{ marginTop: 8, fontSize: 13 }}>
                      <span className="muted">{editPhotoFiles.length} foto dipilih</span>
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="row" style={{ marginTop: 16, gap: 8, justifyContent: 'flex-end' }}>
              <button
                className="button button-secondary"
                type="button"
                onClick={() => setAddOpen(false)}
                disabled={busy}
              >
                Batal
              </button>
              <button className="button button-primary" type="submit" disabled={busy}>
                {busy ? 'Menyimpan...' : editRow ? 'Simpan Perubahan' : 'Tambah'}
              </button>
            </div>
          </form>
        </div>
      </Modal>

      <Modal open={!!detailRow} ariaLabel="Detail Patroli" onClose={() => setDetailRow(null)}>
        {detailRow && (
          <>
            <div className="modal-header">
              <div className="modal-title">Detail Patroli</div>
              <button
                className="button button-secondary button-sm"
                type="button"
                onClick={() => setDetailRow(null)}
              >
                Tutup
              </button>
            </div>
            <div className="modal-body">
              <div className="grid" style={{ gap: 12 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div>
                    <div className="label-sm">Tanggal</div>
                    <div>{detailRow.patrol_date}</div>
                  </div>
                  <div>
                    <div className="label-sm">Waktu</div>
                    <div>{detailRow.patrol_time}</div>
                  </div>
                </div>
                <div>
                  <div className="label-sm">Nama Security</div>
                  <div>{detailRow.security_name}</div>
                </div>
                <div>
                  <div className="label-sm">Lokasi</div>
                  <div>{detailRow.location}</div>
                </div>
                <div>
                  <div className="label-sm">Temuan / Hasil</div>
                  <div style={{ whiteSpace: 'pre-wrap' }}>{detailRow.findings}</div>
                </div>
                <div>
                  <div className="label-sm">Petugas Pencatat</div>
                  <div>
                    {detailRow.created_by_name} · {detailRow.shift} · {detailRow.post}
                  </div>
                </div>
                <div>
                  <div className="label-sm">Waktu dibuat</div>
                  <div>{fmtDateTime(detailRow.created_at)}</div>
                </div>
                {detailRow.has_photo && (
                  <div>
                    <div className="label-sm">Foto</div>
                    <button
                      className="button button-secondary button-sm"
                      type="button"
                      onClick={async () => {
                        const blob = await apiGetBlob(detailRow.photo_url || '')
                        const url = URL.createObjectURL(blob)
                        setPhotoModalUrl(url)
                      }}
                    >
                      Lihat Foto
                    </button>
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </Modal>

      <Modal open={filtersSheetOpen} ariaLabel="Filter" onClose={() => setFiltersSheetOpen(false)} variant="sheet">
        <div className="modal-header">
          <div className="modal-title">Filter</div>
          <button
            className="button button-secondary button-sm"
            type="button"
            onClick={() => setFiltersSheetOpen(false)}
          >
            Tutup
          </button>
        </div>
        <div className="modal-body">
          <div className="grid" style={{ gap: 12 }}>
            <div>
              <label className="label">Cari</label>
              <div className="search">
                <span className="search-icon">⌕</span>
                <input
                  className="search-input"
                  data-autofocus="true"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Nama security, lokasi, temuan..."
                />
              </div>
            </div>
            <div>
              <label className="label">Tanggal</label>
              <input
                type="date"
                className="input"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </div>
            <div>
              <label className="label">Urutan</label>
              <select className="select" value={sort} onChange={(e) => setSort(e.target.value as any)}>
                <option value="date_desc">Terbaru dulu</option>
                <option value="date_asc">Terlama dulu</option>
              </select>
            </div>
          </div>
          <div className="row" style={{ marginTop: 16, gap: 8, justifyContent: 'space-between' }}>
            <button
              className="button button-secondary"
              type="button"
              onClick={() => {
                setQ('')
                setDate('')
              }}
            >
              Reset
            </button>
            <button
              className="button button-primary"
              type="button"
              onClick={() => setFiltersSheetOpen(false)}
            >
              Terapkan
            </button>
          </div>
        </div>
      </Modal>

      {photoModalUrl && (
        <PhotoModal src={photoModalUrl} onClose={() => setPhotoModalUrl(null)} />
      )}
    </div>
  )
}
