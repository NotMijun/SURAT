import { useEffect, useMemo, useState } from 'react'
import { apiGet } from '../../lib/api'
import type { KeyTx, Me, ShiftReport } from '../../types'
import { fmtTime, toYmd } from '../../lib/time'
import { useToast } from '../../components/ToastHost'

export default function DashboardPage({ me }: { me: Me }) {
  const toast = useToast()
  const today = useMemo(() => toYmd(new Date()), [])
  const [report, setReport] = useState<ShiftReport | null>(null)
  const [keysOpen, setKeysOpen] = useState<KeyTx[]>([])
  const [q, setQ] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    Promise.all([
      apiGet<ShiftReport>(`/api/report/shift?date=${encodeURIComponent(today)}&shift=${encodeURIComponent(me.shift)}&post=${encodeURIComponent(me.post)}`),
      apiGet<{ items: KeyTx[] }>(`/api/keys?status=open&q=${encodeURIComponent(q)}`),
    ])
      .then(([r, k]) => {
        if (cancelled) return
        setReport(r)
        setKeysOpen(k.items || [])
      })
      .catch((err: any) => {
        if (cancelled) return
        toast.push(String(err?.message || err || 'Gagal memuat dashboard'), 'error')
      })
      .finally(() => {
        if (cancelled) return
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [me.post, me.shift, q, toast, today])

  return (
    <section className="section">
      <div className="section-header">
        <h1 className="h1">Dashboard</h1>
        <div className="section-actions">
          <div className="search">
            <span className="search-icon" aria-hidden="true">
              ⌕
            </span>
            <input className="search-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Cari nama / ruangan / kegiatan..." />
          </div>
          <button className="button button-secondary" type="button" onClick={() => window.print()}>
            Cetak
          </button>
        </div>
      </div>

      <div className="grid grid-4">
        <article className="stat">
          <div className="stat-label">Penitipan aktif</div>
          <div className="stat-value">{loading ? '…' : String(report?.counts.keys_open ?? 0)}</div>
          <div className="stat-meta">Belum diambil</div>
        </article>
        <article className="stat">
          <div className="stat-label">Tamu hari ini</div>
          <div className="stat-value">{loading ? '…' : String(report?.counts.guests_total ?? 0)}</div>
          <div className="stat-meta">Masuk/keluar</div>
        </article>
        <article className="stat">
          <div className="stat-label">Tugas operasional</div>
          <div className="stat-value">{loading ? '…' : String(report?.counts.tasks_total ?? 0)}</div>
          <div className="stat-meta">Per shift</div>
        </article>
        <article className="stat">
          <div className="stat-label">Catatan mutasi</div>
          <div className="stat-value">{loading ? '…' : String(report?.counts.mutasi_total ?? 0)}</div>
          <div className="stat-meta">Kejadian khusus</div>
        </article>
      </div>

      <div className="grid grid-2">
        <section className="card">
          <header className="card-header">
            <div className="card-title">Kunci belum diambil</div>
          </header>
          <div className="card-body">
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Nama</th>
                    <th>Ruangan/Kunci</th>
                    <th>Jam titip</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {keysOpen.slice(0, 10).map((r) => (
                    <tr key={r.id}>
                      <td>{r.borrower_name}</td>
                      <td>{r.key_name}</td>
                      <td>{fmtTime(r.checkout_at)}</td>
                      <td>
                        <span className="badge badge-warn">Dititipkan</span>
                      </td>
                    </tr>
                  ))}
                  {keysOpen.length === 0 && (
                    <tr>
                      <td className="muted" colSpan={4}>
                        Tidak ada data.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section className="card">
          <header className="card-header">
            <div className="card-title">Ringkasan shift</div>
            <div className="muted">{report ? `${report.date} · Shift ${report.shift} · Pos ${report.post}` : today}</div>
          </header>
          <div className="card-body">
            <div className="list">
              <div className="list-item">
                <div className="list-title">Petugas</div>
                <div className="list-meta">{me.user.display_name}</div>
              </div>
              <div className="list-item">
                <div className="list-title">Penitipan kunci</div>
                <div className="list-meta">{report ? `${report.counts.keys_total} total · ${report.counts.keys_open} belum diambil` : '—'}</div>
              </div>
              <div className="list-item">
                <div className="list-title">Buku tamu</div>
                <div className="list-meta">{report ? `${report.counts.guests_total} hari ini` : '—'}</div>
              </div>
              <div className="list-item">
                <div className="list-title">Tugas & mutasi</div>
                <div className="list-meta">{report ? `${report.counts.tasks_total} tugas · ${report.counts.mutasi_total} mutasi` : '—'}</div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </section>
  )
}

