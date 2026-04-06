import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { apiDelete, apiGet, apiPatch, apiPost } from '../../lib/api'
import type { AdminUser, AuditRow, Me } from '../../types'
import { useToast } from '../../components/ToastHost'

type SecurityHistoryRow = {
  id: number
  created_at: string
  actor_name: string
  actor_shift: string
  actor_post: string
  action: string
  table_name: string
  record_id: string
  before: any
  after: any
}

const titleForRole = (role: string) => {
  if (role === 'admin') return 'Komandan Security'
  if (role === 'supervisor') return 'Supervisor'
  return 'Security'
}

export default function AdminPage({ me }: { me: Me }) {
  const toast = useToast()
  const [userQ, setUserQ] = useState('')
  const [auditQ, setAuditQ] = useState('')
  const [users, setUsers] = useState<AdminUser[]>([])
  const [audit, setAudit] = useState<AuditRow[]>([])
  const [history, setHistory] = useState<SecurityHistoryRow[]>([])
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null)
  const [historyLimit, setHistoryLimit] = useState(50)
  const [loading, setLoading] = useState(true)

  const selectedUser = useMemo(() => users.find((u) => u.id === selectedUserId) || null, [selectedUserId, users])

  const refresh = useCallback(
    async (opts: { userQ: string; auditQ: string; historyLimit: number; selectedUserId: number | null }) => {
      const { userQ, auditQ, historyLimit, selectedUserId } = opts
      setLoading(true)
      try {
        const [u, a] = await Promise.all([
          apiGet<{ items: AdminUser[] }>(`/api/admin/users?q=${encodeURIComponent(userQ)}`),
          apiGet<{ items: AuditRow[] }>(`/api/admin/audit?q=${encodeURIComponent(auditQ)}&limit=120`),
        ])
        const userItems = u.items || []
        setUsers(userItems)
        setAudit(a.items || [])
        const fallbackId = selectedUserId ?? userItems.find((x) => x.role === 'guard')?.id ?? userItems[0]?.id ?? null
        setSelectedUserId(fallbackId)
        if (fallbackId) {
          const h = await apiGet<{ items: SecurityHistoryRow[] }>(
            `/api/admin/security_history?user_id=${encodeURIComponent(String(fallbackId))}&limit=${encodeURIComponent(String(historyLimit))}`,
          )
          setHistory(h.items || [])
        } else {
          setHistory([])
        }
      } catch (err: any) {
        toast.push(String(err?.message || err || 'Gagal memuat admin'), 'error')
      } finally {
        setLoading(false)
      }
    },
    [toast],
  )

  useEffect(() => {
    const t = window.setTimeout(() => refresh({ userQ, auditQ, historyLimit, selectedUserId }).catch(() => {}), 300)
    return () => window.clearTimeout(t)
  }, [auditQ, historyLimit, refresh, selectedUserId, userQ])

  useEffect(() => {
    refresh({ userQ: '', auditQ: '', historyLimit, selectedUserId: null }).catch(() => {})
  }, [historyLimit, refresh])

  const selectUser = async (id: number) => {
    setSelectedUserId(id)
    try {
      const h = await apiGet<{ items: SecurityHistoryRow[] }>(
        `/api/admin/security_history?user_id=${encodeURIComponent(String(id))}&limit=${encodeURIComponent(String(historyLimit))}`,
      )
      setHistory(h.items || [])
    } catch (err: any) {
      toast.push(String(err?.message || err || 'Gagal memuat riwayat'), 'error')
    }
  }

  const saveUser = async (u: AdminUser, patch: Partial<Pick<AdminUser, 'display_name' | 'role' | 'is_active'>>) => {
    try {
      await apiPatch(`/api/admin/users/${u.id}`, patch)
      toast.push('User disimpan', 'success')
      await refresh({ userQ, auditQ, historyLimit, selectedUserId })
    } catch (err: any) {
      toast.push(String(err?.message || err || 'Gagal simpan user'), 'error')
    }
  }

  const resetPassword = async (id: number) => {
    const ok = window.confirm('Reset password user ini? Password lama akan diganti.')
    if (!ok) return
    try {
      const res = await apiPost<{ temp_password: string }>(`/api/admin/users/${id}/reset_password`, {})
      toast.push(`Password baru: ${res.temp_password}`, 'success')
    } catch (err: any) {
      toast.push(String(err?.message || err || 'Gagal reset password'), 'error')
    }
  }

  const deleteUser = async (id: number) => {
    const ok = window.confirm('Hapus akun ini? Jika tidak bisa dihapus karena ada relasi data, akun akan dinonaktifkan.')
    if (!ok) return
    try {
      const res = await apiDelete<{ mode: string }>(`/api/admin/users/${id}/delete`)
      toast.push(res.mode === 'deleted' ? 'Akun dihapus' : 'Akun dinonaktifkan', 'success')
      await refresh({ userQ, auditQ, historyLimit, selectedUserId })
    } catch (err: any) {
      toast.push(String(err?.message || err || 'Gagal hapus akun'), 'error')
    }
  }

  const clearHistory = async () => {
    if (!selectedUserId) return
    const ok = window.confirm('Hapus semua riwayat security ini? Ini akan menghapus catatan login/logout dan aktivitasnya.')
    if (!ok) return
    try {
      const res = await apiDelete<{ deleted: number }>(`/api/admin/security_history?user_id=${encodeURIComponent(String(selectedUserId))}&keep=0`)
      toast.push(`Riwayat dihapus (${res.deleted} entri)`, 'success')
      await refresh({ userQ, auditQ, historyLimit, selectedUserId })
    } catch (err: any) {
      toast.push(String(err?.message || err || 'Gagal hapus riwayat'), 'error')
    }
  }

  const onDeleteRecord = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    const table = String(fd.get('table') || '')
    const id = String(fd.get('id') || '')
    const note = String(fd.get('note') || '')
    if (!table || !id) return
    const ok = window.confirm(`Hapus data ${table} ID ${id}?`)
    if (!ok) return
    try {
      await apiDelete(`/api/admin/records/${encodeURIComponent(table)}?id=${encodeURIComponent(id)}&note=${encodeURIComponent(note)}`)
      toast.push('Data diproses', 'success')
      e.currentTarget.reset()
      await refresh({ userQ, auditQ, historyLimit, selectedUserId })
    } catch (err: any) {
      toast.push(String(err?.message || err || 'Gagal hapus data'), 'error')
    }
  }

  return (
    <section className="section">
      <div className="section-header">
        <h2 className="h2">Admin</h2>
        <div className="section-actions">
          <input className="input input-sm" value={userQ} onChange={(e) => setUserQ(e.target.value)} placeholder="Cari user..." />
          <input className="input input-sm" value={auditQ} onChange={(e) => setAuditQ(e.target.value)} placeholder="Cari audit..." />
          <button className="button button-secondary button-sm" type="button" onClick={() => refresh({ userQ, auditQ, historyLimit, selectedUserId })}>
            Refresh
          </button>
        </div>
      </div>

      <div className="grid grid-2">
        <section className="card" style={{ boxShadow: 'none' }}>
          <header className="card-header">
            <div className="card-title">Securities</div>
            <div className="muted">{loading ? 'Memuat...' : `${users.length} user`}</div>
          </header>
          <div className="card-body">
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Nama</th>
                    <th>Role</th>
                    <th>Aktif</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.id} style={u.id === selectedUserId ? { background: 'rgba(212,175,55,.10)' } : undefined}>
                      <td>
                        <button className="button button-ghost" type="button" onClick={() => selectUser(u.id)} style={{ padding: 0, borderRadius: 10 }}>
                          <div style={{ fontWeight: 850 }}>{u.display_name || u.username}</div>
                          <div className="muted" style={{ fontSize: 12 }}>
                            {u.username}
                          </div>
                        </button>
                      </td>
                      <td>
                        <span className="muted">{titleForRole(u.role)}</span>
                      </td>
                      <td>{u.is_active === 1 ? <span className="badge badge-ok">Aktif</span> : <span className="badge badge-danger">Nonaktif</span>}</td>
                    </tr>
                  ))}
                  {users.length === 0 && (
                    <tr>
                      <td className="muted" colSpan={3}>
                        Tidak ada data.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section className="card" style={{ boxShadow: 'none' }}>
          <header className="card-header">
            <div>
              <div className="card-title">Riwayat · {selectedUser ? selectedUser.display_name || selectedUser.username : '-'}</div>
              <div className="muted">Menampilkan login/logout + aktivitas input/edit/hapus.</div>
            </div>
            <div className="row">
              <select className="select select-sm" value={historyLimit} onChange={(e) => setHistoryLimit(parseInt(e.target.value, 10))}>
                <option value={10}>10</option>
                <option value={20}>20</option>
                <option value={50}>50</option>
              </select>
              <button className="button button-secondary button-sm" type="button" onClick={clearHistory} disabled={!selectedUserId}>
                Hapus Riwayat
              </button>
            </div>
          </header>
          <div className="card-body">
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Waktu</th>
                    <th>Shift/Pos</th>
                    <th>Aksi</th>
                    <th>Target</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((h) => (
                    <tr key={h.id}>
                      <td>{h.created_at || '-'}</td>
                      <td>{`${h.actor_shift || '-'} / ${h.actor_post || '-'}`}</td>
                      <td>{h.action || '-'}</td>
                      <td>{`${h.table_name}:${h.record_id}`}</td>
                    </tr>
                  ))}
                  {history.length === 0 && (
                    <tr>
                      <td className="muted" colSpan={4}>
                        Belum ada riwayat.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      </div>

      <section className="card">
        <header className="card-header">
          <div className="card-title">Manajemen User</div>
          <div className="muted">Ubah role, aktif/nonaktif, reset password</div>
        </header>
        <div className="card-body">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Username</th>
                  <th>Nama tampil</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Aksi</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <AdminUserRow key={u.id} u={u} isSelf={u.id === me.user.id} onSave={saveUser} onReset={resetPassword} onDelete={deleteUser} />
                ))}
                {users.length === 0 && (
                  <tr>
                    <td className="muted" colSpan={6}>
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
          <div className="card-title">Hapus Data</div>
          <div className="muted">Untuk kebutuhan koreksi (admin)</div>
        </header>
        <div className="card-body">
          <form className="form grid grid-4" onSubmit={onDeleteRecord}>
            <div className="field">
              <label className="label">Jenis data</label>
              <select className="select" name="table" defaultValue="key_transactions">
                <option value="key_transactions">Penitipan kunci</option>
                <option value="mutasi_entries">Buku mutasi</option>
                <option value="guest_entries">Buku tamu</option>
                <option value="task_entries">Tugas operasional</option>
              </select>
            </div>
            <div className="field">
              <label className="label">ID data</label>
              <input className="input" name="id" type="number" min={1} required />
            </div>
            <div className="field grid-span-2">
              <label className="label">Catatan (opsional)</label>
              <input className="input" name="note" />
            </div>
            <div className="row row-right grid-span-4">
              <button className="button button-primary" type="submit">
                Hapus Data
              </button>
            </div>
          </form>
          <div className="hint">Catatan: Penitipan kunci akan di-void (bukan dihapus permanen), agar jejak audit tetap ada.</div>
        </div>
      </section>

      <section className="card">
        <header className="card-header">
          <div className="card-title">Audit Log</div>
          <div className="muted">Riwayat perubahan data (backend)</div>
        </header>
        <div className="card-body">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Waktu</th>
                  <th>Aktor</th>
                  <th>Aksi</th>
                  <th>Target</th>
                </tr>
              </thead>
              <tbody>
                {audit.map((a) => (
                  <tr key={a.id}>
                    <td>{a.id}</td>
                    <td>{a.created_at || '-'}</td>
                    <td>{a.actor_name || '-'}</td>
                    <td>{a.action || '-'}</td>
                    <td>{`${a.table_name}:${a.record_id}`}</td>
                  </tr>
                ))}
                {audit.length === 0 && (
                  <tr>
                    <td className="muted" colSpan={5}>
                      Tidak ada data.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </section>
  )
}

function AdminUserRow({
  u,
  isSelf,
  onSave,
  onReset,
  onDelete,
}: {
  u: AdminUser
  isSelf: boolean
  onSave: (u: AdminUser, patch: Partial<Pick<AdminUser, 'display_name' | 'role' | 'is_active'>>) => void
  onReset: (id: number) => void
  onDelete: (id: number) => void
}) {
  const [displayName, setDisplayName] = useState(u.display_name || '')
  const [role, setRole] = useState(u.role)
  const [active, setActive] = useState(u.is_active === 1)

  useEffect(() => {
    setDisplayName(u.display_name || '')
    setRole(u.role)
    setActive(u.is_active === 1)
  }, [u.display_name, u.is_active, u.role])

  return (
    <tr>
      <td>{u.id}</td>
      <td>{u.username}</td>
      <td>
        <input className="input input-sm" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
      </td>
      <td>
        <select className="select select-sm" value={role} onChange={(e) => setRole(e.target.value as any)}>
          <option value="guard">guard</option>
          <option value="supervisor">supervisor</option>
          <option value="admin">admin</option>
        </select>
      </td>
      <td>
        <label className="checkbox">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} disabled={isSelf} />
          <span>{active ? 'Aktif' : 'Nonaktif'}</span>
        </label>
      </td>
      <td className="row">
        <button className="button button-sm" type="button" onClick={() => onSave(u, { display_name: displayName, role, is_active: active ? 1 : 0 })}>
          Simpan
        </button>
        <button className="button button-sm" type="button" onClick={() => onReset(u.id)}>
          Reset Password
        </button>
        <button className="button button-sm" type="button" onClick={() => onDelete(u.id)} disabled={isSelf}>
          Hapus
        </button>
      </td>
    </tr>
  )
}
