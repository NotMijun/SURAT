import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

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

type ConfirmOptions = {
  title?: string
  message: string
  confirmText?: string
  cancelText?: string
}

type PromptOptions = {
  title?: string
  message?: string
  initialValue?: string
  placeholder?: string
  confirmText?: string
  cancelText?: string
  required?: boolean
  readOnly?: boolean
  showCancel?: boolean
}

type ConfirmApi = {
  confirm: (opts: string | ConfirmOptions) => Promise<boolean>
  prompt: (opts: PromptOptions) => Promise<string | null>
  message: (opts: { title?: string; message: string; closeText?: string }) => Promise<void>
}

const ConfirmContext = createContext<ConfirmApi | null>(null)

export const useConfirm = () => {
  const v = useContext(ConfirmContext)
  if (!v) throw new Error('Confirm provider missing')
  return v
}

const clsForTone = (tone: ToastTone) => {
  if (tone === 'success') return 'toast toast-success'
  if (tone === 'warn') return 'toast toast-warn'
  return 'toast toast-error'
}

type DialogItem =
  | {
      id: string
      kind: 'confirm'
      title: string
      message: string
      confirmText: string
      cancelText: string
      resolve: (v: boolean) => void
    }
  | {
      id: string
      kind: 'prompt'
      title: string
      message: string
      confirmText: string
      cancelText: string
      required: boolean
      readOnly: boolean
      placeholder: string
      showCancel: boolean
      initialValue: string
      resolve: (v: string | null) => void
    }

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const queueRef = useRef<DialogItem[]>([])
  const [dialog, setDialog] = useState<DialogItem | null>(null)
  const [promptValue, setPromptValue] = useState('')
  const promptInputRef = useRef<HTMLInputElement | null>(null)

  const push = useCallback((message: string, tone: ToastTone = 'error') => {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const t: Toast = { id, tone, message }
    setToasts((x) => [t, ...x].slice(0, 4))
    window.setTimeout(() => {
      setToasts((x) => x.filter((y) => y.id !== id))
    }, 4000)
  }, [])

  const enqueue = useCallback((item: DialogItem) => {
    queueRef.current.push(item)
    setDialog((current) => current || queueRef.current.shift() || null)
  }, [])

  const resolveAndNext = useCallback((resolver: () => void) => {
    resolver()
    setDialog(() => queueRef.current.shift() || null)
  }, [])

  const confirm = useCallback(
    async (opts: string | ConfirmOptions) => {
      const o: ConfirmOptions = typeof opts === 'string' ? { message: opts } : opts
      return await new Promise<boolean>((resolve) => {
        enqueue({
          id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
          kind: 'confirm',
          title: (o.title || 'Konfirmasi').trim() || 'Konfirmasi',
          message: String(o.message || ''),
          confirmText: (o.confirmText || 'Lanjut').trim() || 'Lanjut',
          cancelText: (o.cancelText || 'Batal').trim() || 'Batal',
          resolve,
        })
      })
    },
    [enqueue],
  )

  const prompt = useCallback(
    async (opts: PromptOptions) => {
      const o = opts || ({} as PromptOptions)
      return await new Promise<string | null>((resolve) => {
        enqueue({
          id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
          kind: 'prompt',
          title: (o.title || 'Input').trim() || 'Input',
          message: String(o.message || ''),
          confirmText: (o.confirmText || 'Simpan').trim() || 'Simpan',
          cancelText: (o.cancelText || 'Batal').trim() || 'Batal',
          required: Boolean(o.required),
          readOnly: Boolean(o.readOnly),
          placeholder: String(o.placeholder || ''),
          showCancel: o.showCancel !== false,
          initialValue: String(o.initialValue || ''),
          resolve,
        })
      })
    },
    [enqueue],
  )

  const message = useCallback(
    async (opts: { title?: string; message: string; closeText?: string }) => {
      await new Promise<void>((resolve) => {
        enqueue({
          id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
          kind: 'prompt',
          title: (opts.title || 'Info').trim() || 'Info',
          message: String(opts.message || ''),
          confirmText: (opts.closeText || 'Tutup').trim() || 'Tutup',
          cancelText: 'Batal',
          required: false,
          readOnly: true,
          placeholder: '',
          showCancel: false,
          initialValue: '',
          resolve: () => resolve(),
        })
      })
    },
    [enqueue],
  )

  useEffect(() => {
    if (!dialog) return
    if (dialog.kind === 'prompt') setPromptValue(dialog.initialValue)
    const t = window.setTimeout(() => {
      if (dialog.kind === 'prompt') promptInputRef.current?.focus()
    }, 0)
    return () => window.clearTimeout(t)
  }, [dialog])

  useEffect(() => {
    if (!dialog) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        if (dialog.kind === 'confirm') resolveAndNext(() => dialog.resolve(false))
        else resolveAndNext(() => dialog.resolve(null))
        return
      }
      if (e.key !== 'Enter') return
      const el = document.activeElement
      if (dialog.kind === 'confirm') {
        e.preventDefault()
        resolveAndNext(() => dialog.resolve(true))
        return
      }
      if (dialog.kind === 'prompt') {
        if (el instanceof HTMLInputElement) {
          e.preventDefault()
          const v = String(promptValue || '')
          if (dialog.required && !v.trim()) return
          resolveAndNext(() => dialog.resolve(v))
        }
      }
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true } as any)
  }, [dialog, promptValue, resolveAndNext])

  const copyText = useCallback(
    async (text: string) => {
      const t = String(text || '')
      if (!t) return
      try {
        await navigator.clipboard.writeText(t)
        push('Disalin', 'success')
      } catch {
        push('Gagal menyalin', 'error')
      }
    },
    [push],
  )

  const toastApi = useMemo(() => ({ push }), [push])
  const confirmApi = useMemo<ConfirmApi>(() => ({ confirm, prompt, message }), [confirm, message, prompt])

  return (
    <ToastContext.Provider value={toastApi}>
      <ConfirmContext.Provider value={confirmApi}>
        {children}
      </ConfirmContext.Provider>
      <div id="toastContainer">
        {toasts.map((t) => (
          <div key={t.id} className={clsForTone(t.tone)}>
            <div>{t.message}</div>
            <button className="toast-close" type="button" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))} aria-label="Tutup notifikasi">
              ×
            </button>
          </div>
        ))}
      </div>
      {dialog && (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={dialog.title}
          onClick={(e) => {
            if (e.currentTarget !== e.target) return
            if (dialog.kind === 'confirm') resolveAndNext(() => dialog.resolve(false))
            else resolveAndNext(() => dialog.resolve(null))
          }}
        >
          <div className="modal">
            <div className="modal-header">
              <div className="modal-title">{dialog.title}</div>
              <button
                className="button button-secondary button-sm"
                type="button"
                onClick={() => {
                  if (dialog.kind === 'confirm') resolveAndNext(() => dialog.resolve(false))
                  else resolveAndNext(() => dialog.resolve(null))
                }}
                aria-label="Tutup dialog"
              >
                Tutup
              </button>
            </div>
            <div className="modal-body">
              {dialog.message ? <div style={{ whiteSpace: 'pre-wrap' }}>{dialog.message}</div> : null}
              {dialog.kind === 'prompt' && (
                <div style={{ marginTop: 12, display: 'grid', gap: 10 }}>
                  <div className="row" style={{ alignItems: 'stretch' }}>
                    <input
                      ref={promptInputRef}
                      className="input"
                      value={promptValue}
                      readOnly={dialog.readOnly}
                      placeholder={dialog.placeholder}
                      onChange={(e) => setPromptValue(e.target.value)}
                    />
                    {dialog.readOnly && promptValue ? (
                      <button className="button button-secondary" type="button" onClick={() => copyText(promptValue)}>
                        Salin
                      </button>
                    ) : null}
                  </div>
                </div>
              )}
              <div className="row row-right" style={{ marginTop: 14 }}>
                {dialog.kind === 'confirm' ? (
                  <>
                    <button className="button button-secondary" type="button" onClick={() => resolveAndNext(() => dialog.resolve(false))}>
                      {dialog.cancelText}
                    </button>
                    <button className="button button-primary" type="button" onClick={() => resolveAndNext(() => dialog.resolve(true))}>
                      {dialog.confirmText}
                    </button>
                  </>
                ) : dialog.showCancel ? (
                  <>
                    <button className="button button-secondary" type="button" onClick={() => resolveAndNext(() => dialog.resolve(null))}>
                      {dialog.cancelText}
                    </button>
                    <button
                      className="button button-primary"
                      type="button"
                      onClick={() => {
                        const v = String(promptValue || '')
                        if (dialog.required && !v.trim()) return
                        resolveAndNext(() => dialog.resolve(v))
                      }}
                    >
                      {dialog.confirmText}
                    </button>
                  </>
                ) : (
                  <button className="button button-primary" type="button" onClick={() => resolveAndNext(() => dialog.resolve(String(promptValue || '')))}>
                    {dialog.confirmText}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </ToastContext.Provider>
  )
}
