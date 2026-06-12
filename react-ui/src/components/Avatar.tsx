import React from 'react'

type Props = {
  name: string
  size?: 'sm' | 'md' | 'lg'
}

export default function Avatar({ name, size = 'md' }: Props) {
  const initials = name
    .split(' ')
    .map((w) => w.charAt(0))
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase()

  // Generate a consistent background color based on name hash
  const colors = [
    '#3b82f6', // blue-500
    '#10b981', // emerald-500
    '#f59e0b', // amber-500
    '#ef4444', // red-500
    '#8b5cf6', // violet-500
    '#ec4899', // pink-500
  ]

  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash)
  }

  const colorIndex = Math.abs(hash) % colors.length
  const bgColor = colors[colorIndex]

  return (
    <div
      className={`inline-flex items-center justify-center rounded-full font-medium text-white select-none`}
      style={{
        backgroundColor: bgColor,
        width: size === 'sm' ? '24px' : size === 'lg' ? '40px' : '32px',
        height: size === 'sm' ? '24px' : size === 'lg' ? '40px' : '32px',
        fontSize: size === 'sm' ? '10px' : size === 'lg' ? '14px' : '12px',
      }}
      aria-hidden="true"
    >
      {initials || '?'}
    </div>
  )
}
