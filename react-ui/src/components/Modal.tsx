import { ReactNode, useEffect, useRef } from 'react'

type Props = {
  open: boolean
  ariaLabel: string
  onClose: () => void
  children: ReactNode
}

const selector = 'a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])'

export default function Modal({ open, ariaLabel, onClose, children }: Props) {
  const modalRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null

    const focusables = () =>
      Array.from((modalRef.current || document).querySelectorAll<HTMLElement>(selector)).filter((el) => !el.hasAttribute('disabled') && el.tabIndex !== -1)

    window.setTimeout(() => {
      focusables()[0]?.focus()
    }, 0)

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }
      if (e.key !== 'Tab') return
      const list = focusables()
      if (!list.length) return
      const first = list[0]
      const last = list[list.length - 1]
      const active = document.activeElement as HTMLElement | null
      if (e.shiftKey) {
        if (!active || active === first || !modalRef.current?.contains(active)) {
          e.preventDefault()
          last.focus()
        }
      } else {
        if (!active || active === last || !modalRef.current?.contains(active)) {
          e.preventDefault()
          first.focus()
        }
      }
    }

    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true } as any)
      previous?.focus()
    }
  }, [onClose, open])

  if (!open) return null

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label={ariaLabel} onClick={(e) => (e.currentTarget === e.target ? onClose() : null)}>
      <div className="modal" ref={modalRef}>
        {children}
      </div>
    </div>
  )
}
