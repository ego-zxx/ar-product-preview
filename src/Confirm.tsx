import { useCallback, useRef, useState } from 'react'

type Options = {
  title: string
  message: string
  confirmLabel?: string
  danger?: boolean
}

/**
 * Promise-based confirm built on <dialog>, so focus trapping, Escape-to-cancel
 * and the backdrop come from the platform rather than from us.
 *
 * Not usable inside the WebXR DOM overlay — showModal() promotes to the browser
 * top layer, which sits outside the overlay's subtree. Confirm inline there.
 */
export function useConfirm() {
  const ref = useRef<HTMLDialogElement>(null)
  const resolveRef = useRef<((ok: boolean) => void) | null>(null)
  const [opts, setOpts] = useState<Options | null>(null)

  const confirm = useCallback((o: Options) => {
    setOpts(o)
    // wait a tick so the dialog has content before it opens
    queueMicrotask(() => ref.current?.showModal())
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve
    })
  }, [])

  const settle = (ok: boolean) => {
    ref.current?.close()
    resolveRef.current?.(ok)
    resolveRef.current = null
  }

  const dialog = (
    <dialog
      ref={ref}
      className="confirm"
      aria-labelledby="confirm-title"
      // Escape (and any other native close) counts as cancel
      onClose={() => {
        resolveRef.current?.(false)
        resolveRef.current = null
      }}
      onClick={(e) => {
        if (e.target === ref.current) settle(false)
      }}
    >
      <h2 className="confirm-title" id="confirm-title">
        {opts?.title}
      </h2>
      <p className="confirm-msg">{opts?.message}</p>
      <div className="confirm-actions">
        <button className="confirm-btn" onClick={() => settle(false)} autoFocus>
          Cancel
        </button>
        <button
          className="confirm-btn"
          data-danger={opts?.danger}
          onClick={() => settle(true)}
        >
          {opts?.confirmLabel ?? 'Confirm'}
        </button>
      </div>
    </dialog>
  )

  return [confirm, dialog] as const
}
