import { useEffect, useMemo, useState } from 'react'
import { apiGet } from '../../lib/api'
import type { KeyTx, Me, ShiftReport } from '../../types'
import { fmtTime, toYmd } from '../../lib/time'
import { useToast } from '../../components/ToastHost'

type HandoverRes = {
  open_keys: Array<{ id: number; borrower_name: string; unit: string; key_name: string; checkout_at: string; notes: string | null; status: string }>
  open_keys_count?: number
  guests_in: Array<{ id: number; name: string; instansi: string; purpose: string; meet_person: string; checkin_at: string; status: string }>
  guests_in_count?: number
}

export default function DashboardPage({ me }: { me: Me }) {
  const toast = useToast()
  const today = useMemo(() => toYmd(new Date()), [])
  const [report, setReport] = useState<ShiftReport | null>(null)
  const [keysOpen, setKeysOpen] = useState<KeyTx[]>([])
  const [handover, setHandover] = useState<HandoverRes | null>(null)
  const [overdueCount, setOverdueCount] = useState(0)
  const [q, setQ] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    Promise.all([
      apiGet<ShiftReport>(`/api/report/shift?date=${encodeURIComponent(today)}&shift=${encodeURIComponent(me.shift)}&post=${encodeURIComponent(me.post)}`),
      apiGet<{ items: KeyTx[] }>(`/api/keys?status=open&q=${encodeURIComponent(q)}`),
      apiGet<HandoverRes>('/api/handover'),
    ])
      .then(([r, k, h]) => {
        if (cancelled) return
        setReport(r)
        setKeysOpen(k.items || [])
        setHandover(h)
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

  useEffect(() => {
    const rows = handover?.open_keys || []
    const now = Date.now()
    let n = 0
    for (const r of rows) {
      const ts = Date.parse(r.checkout_at || '')
      if (!Number.isFinite(ts)) continue
      if (now - ts > 4 * 60 * 60 * 1000) n += 1
    }
    setOverdueCount(n)
  }, [handover])

  const copyHandover = async () => {
    const h = handover
    const r = report
    const keysCount = typeof h?.open_keys_count === 'number' ? h.open_keys_count : (h?.open_keys?.length || 0)
    const guestsCount = typeof h?.guests_in_count === 'number' ? h.guests_in_count : (h?.guests_in?.length || 0)
    const lines: string[] = []
    lines.push('LOGBOOK SECURITY RS — SERAH TERIMA')
    if (r) lines.push(`${r.date} · Shift ${r.shift} · Pos ${r.post}`)
    lines.push(`Petugas: ${me.user.display_name}`)
    lines.push('')
    lines.push(`Kunci masih dipinjam: ${keysCount}`)
    for (const x of (h?.open_keys || []).slice(0, 10)) {
      lines.push(`- ${x.key_name} · ${x.borrower_name} · ${fmtTime(x.checkout_at)} · ${x.unit || '-'}${x.notes ? ` · ${x.notes}` : ''}`)
    }
    if ((h?.open_keys || []).length > 10) lines.push('- …')
    lines.push('')
    lines.push(`Tamu masih di dalam: ${guestsCount}`)
    for (const x of (h?.guests_in || []).slice(0, 10)) {
      lines.push(`- ${x.name} · ${x.instansi} · ${fmtTime(x.checkin_at)} · ${x.purpose} · ${x.meet_person}`)
    }
    if ((h?.guests_in || []).length > 10) lines.push('- …')
    const text = lines.join('\n')
    try {
      await navigator.clipboard.writeText(text)
      toast.push('Ringkasan disalin', 'success')
    } catch {
      window.prompt('Salin ringkasan ini:', text)
    }
  }

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
          <div className="stat-meta">{overdueCount > 0 ? `${overdueCount} overdue` : 'Belum diambil'}</div>
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
              <table className="table table-mobile-cards">
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
                      <td data-label="Nama">{r.borrower_name}</td>
                      <td data-label="Ruangan/Kunci">{r.key_name}</td>
                      <td data-label="Jam titip">{fmtTime(r.checkout_at)}</td>
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

      <section className="card">
        <header className="card-header">
          <div className="card-title">Serah terima (ringkas)</div>
          <div className="row">
            <button className="button button-secondary button-sm" type="button" onClick={copyHandover}>
              Copy ringkasan
            </button>
            <button className="button button-secondary button-sm" type="button" onClick={() => window.print()}>
              Cetak
            </button>
          </div>
        </header>
        <div className="card-body">
          <div className="grid grid-2">
            <div className="list">
              <div className="list-item">
                <div className="list-title">Kunci masih dipinjam</div>
                <div className="list-meta">
                  {handover ? `${typeof handover.open_keys_count === 'number' ? handover.open_keys_count : handover.open_keys.length} entri` : '—'}
                </div>
              </div>
              {(handover?.open_keys || []).slice(0, 6).map((r) => (
                <div key={r.id} className="list-item">
                  <div className="list-title">
                    {r.key_name} · {r.borrower_name}
                  </div>
                  <div className="list-meta">
                    {fmtTime(r.checkout_at)} · {r.unit || '-'} {r.notes ? `· ${r.notes}` : ''}
                  </div>
                </div>
              ))}
            </div>
            <div className="list">
              <div className="list-item">
                <div className="list-title">Tamu masih di dalam</div>
                <div className="list-meta">
                  {handover ? `${typeof handover.guests_in_count === 'number' ? handover.guests_in_count : handover.guests_in.length} entri` : '—'}
                </div>
              </div>
              {(handover?.guests_in || []).slice(0, 6).map((r) => (
                <div key={r.id} className="list-item">
                  <div className="list-title">
                    {r.name} · {r.instansi}
                  </div>
                  <div className="list-meta">
                    {fmtTime(r.checkin_at)} · {r.purpose} · {r.meet_person}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>
    </section>
  )
}
