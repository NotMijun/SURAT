export const toYmd = (d: Date) => {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export const toIsoLocal = (ymd: string, hm: string) => `${ymd}T${hm}:00`

export const fmtTime = (iso: string | null | undefined) => {
  if (!iso) return '—'
  const t = iso.includes('T') ? iso.split('T')[1] : iso
  return (t || '').slice(0, 5) || '—'
}

