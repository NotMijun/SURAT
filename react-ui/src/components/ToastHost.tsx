import { createContext, useCallback, useContext, useMemo, useState } from 'react'

type ToastTone = 'success' | 'error' | 'warn'

type Toast = { id: string; tone: ToastTone; message: string }

type ToastApi = {
  push: (message: string, tone?: ToastTone) => void
}

const ToastContext = createContext<ToastApi | null>(null)

export const useToast = () => {
  const v = useContext(ToastContext)
  if (!v) throw new Error('Toast provider missing')
  return v
}

const clsForTone = (tone: ToastTone) => {
  if (tone === 'success') return 'toast toast-success'
  if (tone === 'warn') return 'toast toast-warn'
  return 'toast toast-error'
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])

  const push = useCallback((message: string, tone: ToastTone = 'error') => {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const t: Toast = { id, tone, message }
    setToasts((x) => [t, ...x].slice(0, 4))
    window.setTimeout(() => {
      setToasts((x) => x.filter((y) => y.id !== id))
    }, 4000)
  }, [])

  const api = useMemo(() => ({ push }), [push])

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div id="toastContainer">
        {toasts.map((t) => (
          <div key={t.id} className={clsForTone(t.tone)}>
            <div>{t.message}</div>
            <button className="toast-close" type="button" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}>
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

