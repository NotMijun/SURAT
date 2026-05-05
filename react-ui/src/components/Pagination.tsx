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
  const from = t === 0 ? 0 : (p - 1) * size + 1
  const to = t === 0 ? 0 : Math.min(p * size, t)

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
    <nav className="pagination" aria-label="Pagination">
      <div className="pagination-info">
        {t === 0 ? (
          <span className="muted">Tidak ada data</span>
        ) : (
          <span className="muted">
            Menampilkan {from}-{to} dari {t}
          </span>
        )}
      </div>
      <div className="pagination-controls">
        <button className="button button-secondary button-sm" type="button" onClick={() => go(p - 1)} disabled={p <= 1}>
          Prev
        </button>
        <div className="pagination-pages">
          {nums.map((n, idx) =>
            n === '…' ? (
              <span key={`dots-${idx}`} className="pagination-dots" aria-hidden="true">
                …
              </span>
            ) : (
              <button
                key={n}
                className={`button button-sm ${n === p ? 'button-primary' : 'button-secondary'}`}
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
        <span className="pagination-meta muted">
          Halaman {p}/{pages}
        </span>
      </div>
    </nav>
  )
}
