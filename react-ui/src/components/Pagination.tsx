type Props = {
  page: number
  pageSize: number
  total: number
  onPageChange: (page: number) => void
}

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n))

export default function Pagination({ page, pageSize, total, onPageChange }: Props) {
  const size = Math.max(1, pageSize || 1)
  const t = Math.max(0, total || 0)
  const pages = Math.max(1, Math.ceil(t / size) || 1)
  const p = clamp(Math.floor(page || 1), 1, pages)

  const go = (next: number) => onPageChange(clamp(next, 1, pages))

  const nums: Array<number | '…'> = []
  if (pages <= 7) {
    for (let i = 1; i <= pages; i++) nums.push(i)
  } else {
    nums.push(1)
    const start = Math.max(2, p - 1)
    const end = Math.min(pages - 1, p + 1)
    if (start > 2) nums.push('…')
    for (let i = start; i <= end; i++) nums.push(i)
    if (end < pages - 1) nums.push('…')
    nums.push(pages)
  }

  return (
    <div className="row row-right" style={{ marginTop: 12, gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
      <span className="muted" style={{ marginRight: 6 }}>
        Total: {t}
      </span>
      <button className="button button-secondary button-sm" type="button" onClick={() => go(p - 1)} disabled={p <= 1}>
        Prev
      </button>
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        {nums.map((n, idx) =>
          n === '…' ? (
            <span key={`dots-${idx}`} className="muted" style={{ padding: '0 6px' }}>
              …
            </span>
          ) : (
            <button
              key={n}
              className={`button button-secondary button-sm${n === p ? ' button-active' : ''}`}
              type="button"
              onClick={() => go(n)}
              aria-current={n === p ? 'page' : undefined}
            >
              {n}
            </button>
          ),
        )}
      </div>
      <button className="button button-secondary button-sm" type="button" onClick={() => go(p + 1)} disabled={p >= pages}>
        Next
      </button>
      <span className="muted" style={{ marginLeft: 6 }}>
        Halaman {p}/{pages}
      </span>
    </div>
  )
}
