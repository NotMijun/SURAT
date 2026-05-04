import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiGet } from '../../lib/api'
import type { KeyTx, Me, ShiftReport } from '../../types'
import { fmtTime, toYmd } from '../../lib/time'
import { useConfirm, useToast } from '../../components/ToastHost'

type HandoverRes = {
  open_keys: Array<{ id: number; borrower_name: string; unit: string; key_name: string; checkout_at: string; notes: string | null; status: string }>
  open_keys_count?: number
  guests_in: Array<{ id: number; name: string; instansi: string; purpose: string; meet_person: string; checkin_at: string; status: string }>
  guests_in_count?: number
}

export default function DashboardPage({ me }: { me: Me }) {
  const toast = useToast()
  const confirm = useConfirm()
  const nav = useNavigate()
  const today = useMemo(() => toYmd(new Date()), [])
  const [reportDate, setReportDate] = useState(today)
  const [report, setReport] = useState<ShiftReport | null>(null)
  const [keysOpen, setKeysOpen] = useState<KeyTx[]>([])
  const [handover, setHandover] = useState<HandoverRes | null>(null)
  const [overdueCount, setOverdueCount] = useState(0)
  const [guestsOverdueCount, setGuestsOverdueCount] = useState(0)
  const [q, setQ] = useState('')
  const [loadingMeta, setLoadingMeta] = useState(true)
  const [loadingKeys, setLoadingKeys] = useState(true)
  const loading = loadingMeta || loadingKeys

  useEffect(() => {
    let cancelled = false
    setLoadingMeta(true)
    Promise.all([
      apiGet<ShiftReport>(`/api/report/shift?date=${encodeURIComponent(reportDate)}&shift=${encodeURIComponent(me.shift)}&post=${encodeURIComponent(me.post)}`),
      apiGet<HandoverRes>('/api/handover'),
    ])
      .then(([r, h]) => {
        if (cancelled) return
        setReport(r)
        setHandover(h)
      })
      .catch((err: any) => {
        if (cancelled) return
        toast.push(String(err?.message || err || 'Gagal memuat dashboard'), 'error')
      })
      .finally(() => {
        if (cancelled) return
        setLoadingMeta(false)
      })
    return () => {
      cancelled = true
    }
  }, [me.post, me.shift, toast, reportDate])

  useEffect(() => {
    let cancelled = false
    const t = window.setTimeout(() => {
      setLoadingKeys(true)
      apiGet<{ items: KeyTx[] }>(`/api/keys?status=open&q=${encodeURIComponent(q)}`)
        .then((k) => {
          if (cancelled) return
          setKeysOpen(k.items || [])
        })
        .catch((err: any) => {
          if (cancelled) return
          toast.push(String(err?.message || err || 'Gagal memuat data kunci'), 'error')
        })
        .finally(() => {
          if (cancelled) return
          setLoadingKeys(false)
        })
    }, 250)
    return () => {
      cancelled = true
      window.clearTimeout(t)
    }
  }, [q, toast])

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

  useEffect(() => {
    const rows = handover?.guests_in || []
    const now = Date.now()
    let n = 0
    for (const r of rows) {
      const ts = Date.parse(r.checkin_at || '')
      if (!Number.isFinite(ts)) continue
      if (now - ts > 2 * 60 * 60 * 1000) n += 1
    }
    setGuestsOverdueCount(n)
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
    if (r?.mutasi && r.mutasi.length > 0) {
      lines.push('')
      lines.push('Mutasi/Kejadian:')
      for (const m of r.mutasi) {
        lines.push(`- [${fmtTime(m.occurred_at)}] ${m.kind}: ${m.description}`)
      }
    }
    if (r?.tasks && r.tasks.length > 0) {
      lines.push('')
      lines.push('Tugas/Operasional:')
      for (const t of r.tasks) {
        lines.push(`- ${t.kind}: ${t.destination} (${t.status})`)
      }
    }
    const text = lines.join('\n')
    try {
      await navigator.clipboard.writeText(text)
      toast.push('Ringkasan disalin', 'success')
    } catch {
      await confirm.prompt({ title: 'Ringkasan Serah Terima', message: 'Salin ringkasan ini:', initialValue: text, readOnly: true, showCancel: false, confirmText: 'Tutup' })
    }
  }

  return (
    <section className="section">
      <div className="section-header">
        <h1 className="h1">Dashboard</h1>
        <div className="section-actions section-filters">
          <div className="filter-group" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <label className="label-sm" style={{ margin: 0 }}>Filter Tanggal</label>
            <input className="input input-sm" type="date" value={reportDate} onChange={(e) => setReportDate(e.target.value)} />
          </div>
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

      <section className="card">
        <header className="card-header">
          <div className="card-title">Aksi Cepat</div>
          <div className="muted">Buka modul dan catat kejadian lebih cepat</div>
        </header>
        <div className="card-body">
          <div className="quick-actions">
            <button className="quick-action" type="button" onClick={() => nav('/tamu')}>
              <div className="quick-action-title">Tamu</div>
              <div className="quick-action-meta">Catat tamu masuk/keluar</div>
            </button>
            <button className="quick-action" type="button" onClick={() => nav('/kunci')}>
              <div className="quick-action-title">Kunci</div>
              <div className="quick-action-meta">Penitipan & pengambilan</div>
            </button>
            <button className="quick-action" type="button" onClick={() => nav('/mutasi')}>
              <div className="quick-action-title">Mutasi</div>
              <div className="quick-action-meta">Catat kejadian</div>
            </button>
            <button className="quick-action" type="button" onClick={() => nav('/tugas')}>
              <div className="quick-action-title">Tugas</div>
              <div className="quick-action-meta">Operasional & POM</div>
            </button>
          </div>
        </div>
      </section>

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
                    <tr key={r.id} className="table-row-active">
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
                  {handover
                    ? `${typeof handover.open_keys_count === 'number' ? handover.open_keys_count : handover.open_keys.length} entri${
                        overdueCount ? ` · >4 jam: ${overdueCount}` : ''
                      }`
                    : '—'}
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
                  {handover
                    ? `${typeof handover.guests_in_count === 'number' ? handover.guests_in_count : handover.guests_in.length} entri${
                        guestsOverdueCount ? ` · >2 jam: ${guestsOverdueCount}` : ''
                      }`
                    : '—'}
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
