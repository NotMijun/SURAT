export type Role = 'guard' | 'supervisor' | 'admin'

export type Me = {
  user: { id: number; username: string; display_name: string; role: Role }
  shift: string
  post: string
  session_ttl_seconds?: number
  session_expires_at?: number
  session_expires_at_iso?: string
}

export type ShiftReport = {
  date: string
  shift: string
  post: string
  counts: {
    keys_total: number
    keys_open: number
    guests_total: number
    tasks_total: number
    mutasi_total: number
  }
  mutasi?: MutasiEntry[]
  tasks?: TaskEntry[]
}

export type KeyTx = {
  id: number
  borrower_name: string
  unit?: string
  key_name: string
  checkout_at: string
  checkin_at?: string | null
  notes?: string
  status: 'open' | 'closed' | 'void'
  void_reason?: string | null
  created_by?: number
  created_at?: string
  created_by_name?: string
  has_photo?: boolean
  photo_count?: number
  photo_url?: string
}

export type GuestEntry = {
  id: number
  name: string
  instansi: string
  purpose: string
  meet_person: string
  checkin_at: string
  checkout_at?: string | null
  notes?: string
  status: 'in' | 'out' | 'void'
  void_reason?: string | null
  destination_room?: string | null
  visitor_card_no?: string | null
  ktp_exchanged?: boolean | null
  created_by?: number
  created_at?: string
  created_by_name?: string
  shift?: string
  post?: string
  has_photo?: boolean
  photo_count?: number
  photo_url?: string
}

export type TaskEntry = {
  id: number
  kind: string
  occurred_at: string
  destination: string
  notes: string
  extra?: any
  status?: 'active' | 'void'
  void_reason?: string | null
  created_by_name?: string
  shift?: string
  post?: string
  has_photo?: boolean
  photo_count?: number
  photo_url?: string
}

export type MutasiEntry = {
  id: number
  occurred_at: string
  kind: string
  description: string
  status?: 'active' | 'void'
  void_reason?: string | null
  created_by_name?: string
  shift?: string
  post?: string
  has_photo?: boolean
  photo_count?: number
  photo_url?: string
}

export type AttachmentItem = {
  id: number
  kind: string
  photo_name: string
  uploaded_at: string
  url: string
}

export type KeyMasterItem = {
  id: number
  name: string
}

export type AdminUser = {
  id: number
  username: string
  display_name: string
  role: Role
  is_active: number
  created_at: string
}

export type AuditRow = {
  id: number
  created_at: string
  actor_name: string
  actor_shift: string
  actor_post: string
  action: string
  table_name: string
  record_id: string
  target_label?: string | null
}
