import React from 'react'

type Props = {
  label: string
  active?: boolean
  direction?: 'asc' | 'desc'
  onClick: () => void
}

export default function SortButton({ label, active, direction, onClick }: Props) {
  return (
    <button
      className="button button-ghost button-sm"
      type="button"
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        fontWeight: active ? 600 : 400,
      }}
    >
      {label}
      {active && (
        <span style={{ fontSize: '0.75em' }}>
          {direction === 'desc' ? '▼' : '▲'}
        </span>
      )}
    </button>
  )
}
