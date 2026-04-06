export const toYmd = (d: Date) => {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export const toIsoLocal = (ymd: string, hm: string) => `${ymd}T${hm}:00`

export const nowHm = () => {
  const d = new Date()
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

export const shiftHm = (hm: string, minutesDelta: number) => {
  const [hRaw, mRaw] = String(hm || '').split(':', 2)
  const h = Number(hRaw)
  const m = Number(mRaw)
  if (!Number.isFinite(h) || !Number.isFinite(m)) return hm
  const base = new Date()
  base.setHours(h, m, 0, 0)
  base.setMinutes(base.getMinutes() + minutesDelta)
  const hh = String(base.getHours()).padStart(2, '0')
  const mm = String(base.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

export const fmtTime = (iso: string | null | undefined) => {
  if (!iso) return '—'
  const t = iso.includes('T') ? iso.split('T')[1] : iso
  return (t || '').slice(0, 5) || '—'
}
