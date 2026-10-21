import { createContext, useContext, useState, useCallback, type ReactNode } from 'react'
import { CheckCircle, XCircle, AlertCircle, X } from 'lucide-react'

type ToastType = 'success' | 'error' | 'info'

interface Toast {
  id: string
  type: ToastType
  title: string
  message?: string
}

interface ToastContextValue {
  toast: (type: ToastType, title: string, message?: string) => void
  success: (title: string, message?: string) => void
  error: (title: string, message?: string) => void
  info: (title: string, message?: string) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])

  const dismiss = useCallback((id: string) => {
    setToasts(ts => ts.filter(t => t.id !== id))
  }, [])

  const toast = useCallback((type: ToastType, title: string, message?: string) => {
    const id = Math.random().toString(36).slice(2)
    setToasts(ts => [...ts, { id, type, title, message }])
    setTimeout(() => dismiss(id), 4000)
  }, [dismiss])

  const success = useCallback((t: string, m?: string) => toast('success', t, m), [toast])
  const error = useCallback((t: string, m?: string) => toast('error', t, m), [toast])
  const info = useCallback((t: string, m?: string) => toast('info', t, m), [toast])

  return (
    <ToastContext.Provider value={{ toast, success, error, info }}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
        {toasts.map(t => (
          <div
            key={t.id}
            className="pointer-events-auto flex items-start gap-3 bg-gray-900 border border-gray-700 rounded-xl shadow-2xl px-4 py-3 min-w-72 max-w-sm animate-slide-in"
          >
            <div className="flex-shrink-0 mt-0.5">
              {t.type === 'success' && <CheckCircle className="w-5 h-5 text-green-400" />}
              {t.type === 'error' && <XCircle className="w-5 h-5 text-red-400" />}
              {t.type === 'info' && <AlertCircle className="w-5 h-5 text-brand-400" />}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-white">{t.title}</p>
              {t.message && <p className="text-xs text-gray-400 mt-0.5">{t.message}</p>}
            </div>
            <button onClick={() => dismiss(t.id)} className="text-gray-600 hover:text-gray-400">
              <X className="w-4 h-4" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be inside ToastProvider')
  return ctx
}
