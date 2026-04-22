import type { CSSProperties } from 'react'

type LoadingMode = 'overlay' | 'inline'

export default function LoadingScreen({
  mode = 'overlay',
  label = 'Loading...',
  minHeight,
}: {
  mode?: LoadingMode
  label?: string
  minHeight?: number
}) {
  const style = typeof minHeight === 'number' ? ({ ['--bsh-loading-minh' as any]: `${minHeight}px` } satisfies CSSProperties) : undefined

  return (
    <div className={mode === 'overlay' ? 'bsh-loading-overlay' : 'bsh-loading-inline'} style={style} role="status" aria-live="polite" aria-busy="true">
      <div className="bsh-loading-card">
        <div className="bsh-loading-logo-wrap" aria-hidden="true">
          <svg className="bsh-loading-ring" viewBox="0 0 120 120">
            <circle className="bsh-loading-ring-track" cx="60" cy="60" r="52" />
            <circle className="bsh-loading-ring-indicator" cx="60" cy="60" r="52" />
          </svg>
          <img className="bsh-loading-logo" src="/api/brand/logo.png" alt="" />
        </div>
        <div className="bsh-loading-text">{label}</div>
        <div className="bsh-loading-bar" aria-hidden="true">
          <div className="bsh-loading-bar-fill" />
        </div>
      </div>
    </div>
  )
}

