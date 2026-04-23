import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { apiDelete, apiGet, apiPatch, apiPost } from '../../lib/api'
import type { AdminUser, AuditRow, Me } from '../../types'
import { useConfirm, useToast } from '../../components/ToastHost'

type SecurityHistoryRow = {
  id: number
  created_at: string
  actor_name: string
  actor_shift: string
  actor_post: string
  action: string
  table_name: string
  record_id: string
  target_label?: string | null
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
  const confirm = useConfirm()
  const [userQ, setUserQ] = useState('')
  const [auditQ, setAuditQ] = useState('')
  const [auditTable, setAuditTable] = useState('')
  const [auditActorUserId, setAuditActorUserId] = useState('')
  const [auditDateFrom, setAuditDateFrom] = useState('')
  const [auditDateTo, setAuditDateTo] = useState('')
  const [users, setUsers] = useState<AdminUser[]>([])
  const [vendors, setVendors] = useState<Array<{ id: number; name: string; created_at?: string }>>([])
  const [newVendor, setNewVendor] = useState('')
  const [keyMaster, setKeyMaster] = useState<Array<{ id: number; name: string; is_active?: boolean; created_at?: string; updated_at?: string }>>([])
  const [newKeyName, setNewKeyName] = useState('')
  const [roomMaster, setRoomMaster] = useState<Array<{ id: number; name: string; is_active?: boolean; created_at?: string; updated_at?: string }>>([])
  const [newRoomName, setNewRoomName] = useState('')
  const [pomUnits, setPomUnits] = useState<Array<{ id: number; name: string; sort_order?: number; is_active?: boolean; created_at?: string; updated_at?: string }>>([])
  const [newPomUnitName, setNewPomUnitName] = useState('')
  const [newPomUnitOrder, setNewPomUnitOrder] = useState('')
  const [audit, setAudit] = useState<AuditRow[]>([])
  const [history, setHistory] = useState<SecurityHistoryRow[]>([])
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null)
  const [historyLimit, setHistoryLimit] = useState(50)
  const [loading, setLoading] = useState(true)

  const selectedUser = useMemo(() => users.find((u) => u.id === selectedUserId) || null, [selectedUserId, users])
  const loadHistory = useCallback(
    async (userId: number | null, limitValue: number) => {
      if (!userId) {
        setHistory([])
        return
      }
      try {
        const h = await apiGet<{ items: SecurityHistoryRow[] }>(
          `/api/admin/security_history?user_id=${encodeURIComponent(String(userId))}&limit=${encodeURIComponent(String(limitValue))}`,
        )
        setHistory(h.items || [])
      } catch (err: any) {
        toast.push(String(err?.message || err || 'Gagal memuat riwayat'), 'error')
      }
    },
    [toast],
  )

  const refresh = useCallback(
    async (opts: { userQ: string; auditQ: string; auditTable: string; auditActorUserId: string; auditDateFrom: string; auditDateTo: string }) => {
      const { userQ, auditQ, auditTable, auditActorUserId, auditDateFrom, auditDateTo } = opts
      setLoading(true)
      try {
        const auditUrl =
          `/api/admin/audit?q=${encodeURIComponent(auditQ)}` +
          `&limit=160` +
          `&table_name=${encodeURIComponent(auditTable)}` +
          `&actor_user_id=${encodeURIComponent(auditActorUserId)}` +
          `&date_from=${encodeURIComponent(auditDateFrom)}` +
          `&date_to=${encodeURIComponent(auditDateTo)}`
        const [u, a] = await Promise.all([
          apiGet<{ items: AdminUser[] }>(`/api/admin/users?q=${encodeURIComponent(userQ)}`),
          apiGet<{ items: AuditRow[] }>(auditUrl),
        ])
        const userItems = u.items || []
        setUsers(userItems)
        setAudit(a.items || [])
        try {
          const v = await apiGet<{ items: Array<{ id: number; name: string; created_at?: string }> }>('/api/admin/vendors/catering')
          setVendors(v.items || [])
        } catch {
          setVendors([])
        }
        try {
          const km = await apiGet<{ items: Array<{ id: number; name: string; is_active?: boolean; created_at?: string; updated_at?: string }> }>('/api/admin/keys/master')
          setKeyMaster(km.items || [])
        } catch {
          setKeyMaster([])
        }
        try {
          const rm = await apiGet<{ items: Array<{ id: number; name: string; is_active?: boolean; created_at?: string; updated_at?: string }> }>('/api/admin/rooms/master')
          setRoomMaster(rm.items || [])
        } catch {
          setRoomMaster([])
        }
        try {
          const pu = await apiGet<{ items: Array<{ id: number; name: string; sort_order?: number; is_active?: boolean; created_at?: string; updated_at?: string }> }>('/api/admin/pom_units')
          setPomUnits(pu.items || [])
        } catch {
          setPomUnits([])
        }
        const selectedStillExists = selectedUserId != null && userItems.some((x) => x.id === selectedUserId)
        const fallbackId = selectedStillExists ? selectedUserId : userItems.find((x) => x.role === 'guard')?.id ?? userItems[0]?.id ?? null
        if (fallbackId !== selectedUserId) {
          setSelectedUserId(fallbackId)
        }
      } catch (err: any) {
        toast.push(String(err?.message || err || 'Gagal memuat admin'), 'error')
      } finally {
        setLoading(false)
      }
    },
    [selectedUserId, toast],
  )

  useEffect(() => {
    const t = window.setTimeout(() => refresh({ userQ, auditQ, auditTable, auditActorUserId, auditDateFrom, auditDateTo }).catch(() => {}), 300)
    return () => window.clearTimeout(t)
  }, [auditActorUserId, auditDateFrom, auditDateTo, auditQ, auditTable, refresh, userQ])

  useEffect(() => {
    loadHistory(selectedUserId, historyLimit).catch(() => {})
  }, [historyLimit, loadHistory, selectedUserId])

  const selectUser = (id: number) => {
    setSelectedUserId(id)
  }

  const saveUser = async (u: AdminUser, patch: Partial<Pick<AdminUser, 'display_name' | 'role' | 'is_active'>>) => {
    try {
      await apiPatch(`/api/admin/users/${u.id}`, patch)
      toast.push('User disimpan', 'success')
      await refresh({ userQ, auditQ, auditTable, auditActorUserId, auditDateFrom, auditDateTo })
    } catch (err: any) {
      toast.push(String(err?.message || err || 'Gagal simpan user'), 'error')
    }
  }

  const resetPassword = async (id: number) => {
    const ok = await confirm.confirm({ title: 'Reset Password', message: 'Reset password user ini? Password lama akan diganti.', confirmText: 'Reset' })
    if (!ok) return
    try {
      const res = await apiPost<{ temp_password: string }>(`/api/admin/users/${id}/reset_password`, {})
      await confirm.prompt({
        title: 'Password Sementara',
        message: 'Password sementara (simpan dan segera sampaikan):',
        initialValue: res.temp_password,
        readOnly: true,
        showCancel: false,
        confirmText: 'Tutup',
      })
      toast.push('Password user berhasil direset', 'success')
    } catch (err: any) {
      toast.push(String(err?.message || err || 'Gagal reset password'), 'error')
    }
  }

  const deleteUser = async (id: number) => {
    const ok = await confirm.confirm({
      title: 'Hapus Akun',
      message: 'Hapus akun ini? Jika tidak bisa dihapus karena ada relasi data, akun akan dinonaktifkan.',
      confirmText: 'Hapus',
    })
    if (!ok) return
    try {
      const res = await apiDelete<{ mode: string }>(`/api/admin/users/${id}/delete`)
      toast.push(res.mode === 'deleted' ? 'Akun dihapus' : 'Akun dinonaktifkan', 'success')
      await refresh({ userQ, auditQ, auditTable, auditActorUserId, auditDateFrom, auditDateTo })
    } catch (err: any) {
      toast.push(String(err?.message || err || 'Gagal hapus akun'), 'error')
    }
  }

  const clearHistory = async () => {
    if (!selectedUserId) return
    const ok = await confirm.confirm({
      title: 'Hapus Riwayat',
      message: 'Hapus semua riwayat security ini? Ini akan menghapus catatan login/logout dan aktivitasnya.',
      confirmText: 'Hapus',
    })
    if (!ok) return
    try {
      const res = await apiDelete<{ deleted: number }>(`/api/admin/security_history?user_id=${encodeURIComponent(String(selectedUserId))}&keep=0`)
      toast.push(`Riwayat dihapus (${res.deleted} entri)`, 'success')
      await refresh({ userQ, auditQ, auditTable, auditActorUserId, auditDateFrom, auditDateTo })
      await loadHistory(selectedUserId, historyLimit)
    } catch (err: any) {
      toast.push(String(err?.message || err || 'Gagal hapus riwayat'), 'error')
    }
  }

  const addVendor = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const name = newVendor.trim()
    if (!name) return
    try {
      await apiPost('/api/admin/vendors/catering', { name })
      setNewVendor('')
      toast.push('Vendor ditambahkan', 'success')
      await refresh({ userQ, auditQ, auditTable, auditActorUserId, auditDateFrom, auditDateTo })
    } catch (err: any) {
      toast.push(String(err?.message || err || 'Gagal menambah vendor'), 'error')
    }
  }

  const addKeyMaster = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const name = newKeyName.trim()
    if (!name) return
    try {
      await apiPost('/api/admin/keys/master', { name })
      setNewKeyName('')
      toast.push('Master kunci ditambahkan', 'success')
      await refresh({ userQ, auditQ, auditTable, auditActorUserId, auditDateFrom, auditDateTo })
    } catch (err: any) {
      toast.push(String(err?.message || err || 'Gagal menambah master kunci'), 'error')
    }
  }

  const updateKeyMaster = async (id: number, name: string, is_active: boolean) => {
    try {
      await apiPatch(`/api/admin/keys/master/${id}`, { name, is_active })
      toast.push('Master kunci disimpan', 'success')
      await refresh({ userQ, auditQ, auditTable, auditActorUserId, auditDateFrom, auditDateTo })
    } catch (err: any) {
      toast.push(String(err?.message || err || 'Gagal mengubah master kunci'), 'error')
    }
  }

  const disableKeyMaster = async (id: number) => {
    const ok = await confirm.confirm({ title: 'Nonaktifkan Master Kunci', message: 'Nonaktifkan master kunci ini?', confirmText: 'Nonaktifkan' })
    if (!ok) return
    try {
      await apiDelete(`/api/admin/keys/master/${id}`)
      toast.push('Master kunci dinonaktifkan', 'success')
      await refresh({ userQ, auditQ, auditTable, auditActorUserId, auditDateFrom, auditDateTo })
    } catch (err: any) {
      toast.push(String(err?.message || err || 'Gagal menonaktifkan'), 'error')
    }
  }

  const updateVendor = async (id: number, name: string) => {
    try {
      await apiPatch(`/api/admin/vendors/catering/${id}`, { name })
      toast.push('Vendor disimpan', 'success')
      await refresh({ userQ, auditQ, auditTable, auditActorUserId, auditDateFrom, auditDateTo })
    } catch (err: any) {
      toast.push(String(err?.message || err || 'Gagal mengubah vendor'), 'error')
    }
  }

  const deleteVendor = async (id: number) => {
    const ok = await confirm.confirm({ title: 'Hapus Vendor', message: 'Hapus vendor ini?', confirmText: 'Hapus' })
    if (!ok) return
    try {
      await apiDelete(`/api/admin/vendors/catering/${id}`)
      toast.push('Vendor dihapus', 'success')
      await refresh({ userQ, auditQ, auditTable, auditActorUserId, auditDateFrom, auditDateTo })
    } catch (err: any) {
      toast.push(String(err?.message || err || 'Gagal menghapus vendor'), 'error')
    }
  }

  const onDeleteRecord = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const fd = new FormData(e.currentTarget)
    const table = String(fd.get('table') || '')
    const id = String(fd.get('id') || '')
    const note = String(fd.get('note') || '')
    if (!table || !id) return
    const ok = await confirm.confirm({ title: 'Hapus Data', message: `Hapus data ${table} ID ${id}?`, confirmText: 'Hapus' })
    if (!ok) return
    try {
      await apiDelete(`/api/admin/records/${encodeURIComponent(table)}?id=${encodeURIComponent(id)}&note=${encodeURIComponent(note)}`)
      toast.push('Data diproses', 'success')
      e.currentTarget.reset()
      await refresh({ userQ, auditQ, auditTable, auditActorUserId, auditDateFrom, auditDateTo })
    } catch (err: any) {
      toast.push(String(err?.message || err || 'Gagal hapus data'), 'error')
    }
  }

  const resetAllData = async () => {
    const ok = await confirm.confirm({
      title: 'Delete Data',
      message: 'Hapus SEMUA data (tamu, mutasi, tugas, kunci, attachments, audit, dll) untuk reset database?\n\nTindakan ini tidak bisa dibatalkan.',
      confirmText: 'Lanjut',
      cancelText: 'Batal',
    })
    if (!ok) return

    const typed = await confirm.prompt({
      title: 'Konfirmasi',
      message: 'Ketik DELETE untuk melanjutkan:',
      placeholder: 'DELETE',
      initialValue: '',
      confirmText: 'Delete Data',
      cancelText: 'Batal',
      required: true,
    })
    if (typed == null) return
    if (typed.trim() !== 'DELETE') {
      toast.push('Konfirmasi tidak sesuai', 'error')
      return
    }

    try {
      const res = await apiPost<{ ok: boolean; deleted?: Record<string, number> }>('/api/admin/reset_data', { confirm: 'DELETE' })
      toast.push('Database direset', 'success')
      const lines = Object.entries(res.deleted || {})
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n')
      if (lines) {
        await confirm.message({ title: 'Hasil Reset', message: lines, closeText: 'Tutup' })
      }
      await refresh({ userQ, auditQ, auditTable, auditActorUserId, auditDateFrom, auditDateTo })
    } catch (err: any) {
      toast.push(String(err?.message || err || 'Gagal reset database'), 'error')
    }
  }

  return (
    <section className="section">
      <div className="section-header">
        <h2 className="h2">Admin</h2>
        <div className="section-actions section-filters">
          <input className="input input-sm" value={userQ} onChange={(e) => setUserQ(e.target.value)} placeholder="Cari user..." />
          <input className="input input-sm" value={auditQ} onChange={(e) => setAuditQ(e.target.value)} placeholder="Cari audit..." />
          <select className="select select-sm" value={auditTable} onChange={(e) => setAuditTable(e.target.value)}>
            <option value="">Semua modul</option>
            <option value="key_transactions">Kunci</option>
            <option value="guest_entries">Tamu</option>
            <option value="mutasi_entries">Mutasi</option>
            <option value="task_entries">Tugas</option>
            <option value="users">User</option>
          </select>
          <select className="select select-sm" value={auditActorUserId} onChange={(e) => setAuditActorUserId(e.target.value)}>
            <option value="">Semua user</option>
            {users.map((u) => (
              <option key={u.id} value={String(u.id)}>
                {u.display_name || u.username}
              </option>
            ))}
          </select>
          <input className="input input-sm" type="date" value={auditDateFrom} onChange={(e) => setAuditDateFrom(e.target.value)} />
          <input className="input input-sm" type="date" value={auditDateTo} onChange={(e) => setAuditDateTo(e.target.value)} />
          <button
            className="button button-secondary button-sm"
            type="button"
            onClick={() => refresh({ userQ, auditQ, auditTable, auditActorUserId, auditDateFrom, auditDateTo })}
          >
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
                      <td>{h.target_label ? `${h.target_label} (${h.table_name}:${h.record_id})` : `${h.table_name}:${h.record_id}`}</td>
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
          <div className="card-title">Vendor Catering</div>
          <div className="muted">Dipakai di tab Tugas › Pom Catering</div>
        </header>
        <div className="card-body">
          <form className="form grid grid-4" onSubmit={addVendor}>
            <div className="field grid-span-3">
              <label className="label">Nama vendor</label>
              <input className="input" value={newVendor} onChange={(e) => setNewVendor(e.target.value)} placeholder="mis. Catering Sinar Pagi" />
            </div>
            <div className="row row-right grid-span-1">
              <button className="button button-primary" type="submit">
                Tambah Vendor
              </button>
            </div>
          </form>
          <div className="table-wrap" style={{ marginTop: 12 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Nama</th>
                  <th>Dibuat</th>
                  <th>Aksi</th>
                </tr>
              </thead>
              <tbody>
                {vendors.map((v) => (
                  <VendorRow key={v.id} v={v} onSave={updateVendor} onDelete={deleteVendor} />
                ))}
                {vendors.length === 0 && (
                  <tr>
                    <td className="muted" colSpan={3}>
                      Belum ada vendor.
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
          <div className="card-title">Master Kunci/Ruangan</div>
          <div className="muted">Dipakai sebagai saran/autocomplete di form Penitipan Kunci</div>
        </header>
        <div className="card-body">
          <form className="form grid grid-4" onSubmit={addKeyMaster}>
            <div className="field grid-span-3">
              <label className="label">Nama kunci/ruangan</label>
              <input className="input" value={newKeyName} onChange={(e) => setNewKeyName(e.target.value)} placeholder="mis. Radiologi" />
            </div>
            <div className="row row-right grid-span-1">
              <button className="button button-primary" type="submit">
                Tambah
              </button>
            </div>
          </form>
          <div className="table-wrap" style={{ marginTop: 12 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Nama</th>
                  <th>Status</th>
                  <th>Aksi</th>
                </tr>
              </thead>
              <tbody>
                {keyMaster.map((k) => (
                  <KeyMasterRow key={k.id} k={k} onSave={updateKeyMaster} onDisable={disableKeyMaster} />
                ))}
                {keyMaster.length === 0 && (
                  <tr>
                    <td className="muted" colSpan={3}>
                      Belum ada data.
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
          <div className="card-title">Master Ruangan</div>
          <div className="muted">Dipakai sebagai saran/autocomplete tujuan ruang</div>
        </header>
        <div className="card-body">
          <form
            className="form grid grid-4"
            onSubmit={async (e) => {
              e.preventDefault()
              const name = newRoomName.trim()
              if (!name) return
              try {
                await apiPost('/api/admin/rooms/master', { name })
                setNewRoomName('')
                toast.push('Master ruangan ditambahkan', 'success')
                await refresh({ userQ, auditQ, auditTable, auditActorUserId, auditDateFrom, auditDateTo })
              } catch (err: any) {
                toast.push(String(err?.message || err || 'Gagal menambah master ruangan'), 'error')
              }
            }}
          >
            <div className="field grid-span-3">
              <label className="label">Nama ruangan</label>
              <input className="input" value={newRoomName} onChange={(e) => setNewRoomName(e.target.value)} placeholder="mis. Poli Anak" />
            </div>
            <div className="row row-right grid-span-1">
              <button className="button button-primary" type="submit">
                Tambah
              </button>
            </div>
          </form>
          <div className="table-wrap" style={{ marginTop: 12 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Nama</th>
                  <th>Status</th>
                  <th>Aksi</th>
                </tr>
              </thead>
              <tbody>
                {roomMaster.map((r) => (
                  <RoomMasterRow
                    key={r.id}
                    r={r}
                    onSave={async (id, name, is_active) => {
                      try {
                        await apiPatch(`/api/admin/rooms/master/${id}`, { name, is_active })
                        toast.push('Master ruangan disimpan', 'success')
                        await refresh({ userQ, auditQ, auditTable, auditActorUserId, auditDateFrom, auditDateTo })
                      } catch (err: any) {
                        toast.push(String(err?.message || err || 'Gagal menyimpan'), 'error')
                      }
                    }}
                    onDisable={async (id) => {
                      const ok = await confirm.confirm({ title: 'Nonaktifkan Master Ruangan', message: 'Nonaktifkan master ruangan ini?', confirmText: 'Nonaktifkan' })
                      if (!ok) return
                      try {
                        await apiDelete(`/api/admin/rooms/master/${id}`)
                        toast.push('Master ruangan dinonaktifkan', 'success')
                        await refresh({ userQ, auditQ, auditTable, auditActorUserId, auditDateFrom, auditDateTo })
                      } catch (err: any) {
                        toast.push(String(err?.message || err || 'Gagal menonaktifkan'), 'error')
                      }
                    }}
                  />
                ))}
                {roomMaster.length === 0 && (
                  <tr>
                    <td className="muted" colSpan={3}>
                      Belum ada data.
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
          <div className="card-title">Master Unit POM</div>
          <div className="muted">Menentukan urutan & daftar unit pada sheet POM Catering</div>
        </header>
        <div className="card-body">
          <form
            className="form grid grid-4"
            onSubmit={async (e) => {
              e.preventDefault()
              const name = newPomUnitName.trim()
              if (!name) return
              const sort_order = parseInt(newPomUnitOrder, 10)
              try {
                await apiPost('/api/admin/pom_units', { name, sort_order: Number.isFinite(sort_order) ? sort_order : 0 })
                setNewPomUnitName('')
                setNewPomUnitOrder('')
                toast.push('Master unit POM ditambahkan', 'success')
                await refresh({ userQ, auditQ, auditTable, auditActorUserId, auditDateFrom, auditDateTo })
              } catch (err: any) {
                toast.push(String(err?.message || err || 'Gagal menambah master unit POM'), 'error')
              }
            }}
          >
            <div className="field grid-span-2">
              <label className="label">Nama unit</label>
              <input className="input" value={newPomUnitName} onChange={(e) => setNewPomUnitName(e.target.value)} placeholder="mis. Farmasi" />
            </div>
            <div className="field">
              <label className="label">Urutan</label>
              <input className="input" value={newPomUnitOrder} onChange={(e) => setNewPomUnitOrder(e.target.value)} placeholder="0" />
            </div>
            <div className="row row-right grid-span-1">
              <button className="button button-primary" type="submit">
                Tambah
              </button>
            </div>
          </form>
          <div className="table-wrap" style={{ marginTop: 12 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Nama</th>
                  <th>Urutan</th>
                  <th>Status</th>
                  <th>Aksi</th>
                </tr>
              </thead>
              <tbody>
                {pomUnits.map((p) => (
                  <PomUnitRow
                    key={p.id}
                    p={p}
                    onSave={async (id, name, sort_order, is_active) => {
                      try {
                        await apiPatch(`/api/admin/pom_units/${id}`, { name, sort_order, is_active })
                        toast.push('Master unit POM disimpan', 'success')
                        await refresh({ userQ, auditQ, auditTable, auditActorUserId, auditDateFrom, auditDateTo })
                      } catch (err: any) {
                        toast.push(String(err?.message || err || 'Gagal menyimpan'), 'error')
                      }
                    }}
                    onDisable={async (id) => {
                      const ok = await confirm.confirm({ title: 'Nonaktifkan Unit POM', message: 'Nonaktifkan unit ini?', confirmText: 'Nonaktifkan' })
                      if (!ok) return
                      try {
                        await apiDelete(`/api/admin/pom_units/${id}`)
                        toast.push('Unit POM dinonaktifkan', 'success')
                        await refresh({ userQ, auditQ, auditTable, auditActorUserId, auditDateFrom, auditDateTo })
                      } catch (err: any) {
                        toast.push(String(err?.message || err || 'Gagal menonaktifkan'), 'error')
                      }
                    }}
                  />
                ))}
                {pomUnits.length === 0 && (
                  <tr>
                    <td className="muted" colSpan={4}>
                      Belum ada data.
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
          <div className="hint">Catatan: Aksi ini menghapus data secara permanen.</div>
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
                    <td>{a.target_label ? `${a.target_label} (${a.table_name}:${a.record_id})` : `${a.table_name}:${a.record_id}`}</td>
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

      <section className="card">
        <header className="card-header">
          <div className="card-title">Delete Data</div>
          <div className="muted">Reset database untuk testing (hapus semua jejak data)</div>
        </header>
        <div className="card-body">
          <button className="button button-danger" type="button" onClick={resetAllData}>
            Delete Data
          </button>
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

function VendorRow({
  v,
  onSave,
  onDelete,
}: {
  v: { id: number; name: string; created_at?: string }
  onSave: (id: number, name: string) => void
  onDelete: (id: number) => void
}) {
  const [name, setName] = useState(v.name || '')

  useEffect(() => {
    setName(v.name || '')
  }, [v.name])

  return (
    <tr>
      <td>
        <input className="input input-sm" value={name} onChange={(e) => setName(e.target.value)} />
      </td>
      <td>{v.created_at || '-'}</td>
      <td className="row">
        <button className="button button-sm" type="button" onClick={() => onSave(v.id, name)}>
          Simpan
        </button>
        <button className="button button-sm" type="button" onClick={() => onDelete(v.id)}>
          Hapus
        </button>
      </td>
    </tr>
  )
}

function KeyMasterRow({
  k,
  onSave,
  onDisable,
}: {
  k: { id: number; name: string; is_active?: boolean; created_at?: string; updated_at?: string }
  onSave: (id: number, name: string, is_active: boolean) => void
  onDisable: (id: number) => void
}) {
  const [name, setName] = useState(k.name || '')
  const [active, setActive] = useState(k.is_active !== false)

  useEffect(() => {
    setName(k.name || '')
    setActive(k.is_active !== false)
  }, [k.id, k.is_active, k.name])

  return (
    <tr>
      <td>
        <input className="input input-sm" value={name} onChange={(e) => setName(e.target.value)} />
      </td>
      <td>
        <label className="row" style={{ gap: 8 }}>
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          <span className="muted">{active ? 'Aktif' : 'Nonaktif'}</span>
        </label>
      </td>
      <td className="row">
        <button className="button button-sm" type="button" onClick={() => onSave(k.id, name, active)}>
          Simpan
        </button>
        <button className="button button-sm" type="button" onClick={() => onDisable(k.id)}>
          Nonaktifkan
        </button>
      </td>
    </tr>
  )
}

function RoomMasterRow({
  r,
  onSave,
  onDisable,
}: {
  r: { id: number; name: string; is_active?: boolean }
  onSave: (id: number, name: string, is_active: boolean) => void
  onDisable: (id: number) => void
}) {
  const [name, setName] = useState(r.name || '')
  const [active, setActive] = useState(r.is_active !== false)

  useEffect(() => {
    setName(r.name || '')
    setActive(r.is_active !== false)
  }, [r.id, r.is_active, r.name])

  return (
    <tr>
      <td>
        <input className="input input-sm" value={name} onChange={(e) => setName(e.target.value)} />
      </td>
      <td>
        <label className="row" style={{ gap: 8 }}>
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          <span className="muted">{active ? 'Aktif' : 'Nonaktif'}</span>
        </label>
      </td>
      <td className="row">
        <button className="button button-sm" type="button" onClick={() => onSave(r.id, name, active)}>
          Simpan
        </button>
        <button className="button button-sm" type="button" onClick={() => onDisable(r.id)}>
          Nonaktifkan
        </button>
      </td>
    </tr>
  )
}

function PomUnitRow({
  p,
  onSave,
  onDisable,
}: {
  p: { id: number; name: string; sort_order?: number; is_active?: boolean }
  onSave: (id: number, name: string, sort_order: number, is_active: boolean) => void
  onDisable: (id: number) => void
}) {
  const [name, setName] = useState(p.name || '')
  const [order, setOrder] = useState(String(typeof p.sort_order === 'number' ? p.sort_order : 0))
  const [active, setActive] = useState(p.is_active !== false)

  useEffect(() => {
    setName(p.name || '')
    setOrder(String(typeof p.sort_order === 'number' ? p.sort_order : 0))
    setActive(p.is_active !== false)
  }, [p.id, p.is_active, p.name, p.sort_order])

  const parsedOrder = parseInt(order, 10)
  const orderValue = Number.isFinite(parsedOrder) ? parsedOrder : 0

  return (
    <tr>
      <td>
        <input className="input input-sm" value={name} onChange={(e) => setName(e.target.value)} />
      </td>
      <td style={{ width: 120 }}>
        <input className="input input-sm" value={order} onChange={(e) => setOrder(e.target.value)} />
      </td>
      <td>
        <label className="row" style={{ gap: 8 }}>
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          <span className="muted">{active ? 'Aktif' : 'Nonaktif'}</span>
        </label>
      </td>
      <td className="row">
        <button className="button button-sm" type="button" onClick={() => onSave(p.id, name, orderValue, active)}>
          Simpan
        </button>
        <button className="button button-sm" type="button" onClick={() => onDisable(p.id)}>
          Nonaktifkan
        </button>
      </td>
    </tr>
  )
}
