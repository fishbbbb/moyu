import React from 'react'

export type ToastState = {
  id: number
  type: 'success' | 'error'
  message: string
  sticky?: boolean
  actionLabel?: string
  onAction?: () => void
}

export function Toast({ toast, onDismiss }: { toast: ToastState | null; onDismiss?: () => void }) {
  if (!toast) return null
  const cls = toast.type === 'error' ? 'uiToast uiToastError' : 'uiToast'
  return (
    <div className={cls} role="status" aria-live="polite">
      <span className="uiToastMsg">{toast.message}</span>
      {toast.actionLabel ? (
        <button
          className="uiToastAction"
          onClick={() => {
            toast.onAction?.()
            if (!toast.sticky) onDismiss?.()
          }}
        >
          {toast.actionLabel}
        </button>
      ) : null}
    </div>
  )
}

