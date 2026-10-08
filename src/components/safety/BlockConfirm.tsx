'use client'

import { useEffect, useId, useRef } from 'react'
import { copy } from '@/lib/copy'
import { SAFETY_BUTTON } from './styles'
// Copy namespaces this module renders (DEC-11: they load with this module's chunk).
import '@/lib/copy/ns/safety'

/**
 * The block confirmation (S18b): what a block does (hidden both ways, the friendship and any
 * roommate link end, they are not told) before it happens. Focus starts on its title; Escape or
 * Cancel steps back.
 */
export function BlockConfirm({
  handle,
  busy,
  onConfirm,
  onCancel,
}: {
  readonly handle: string
  readonly busy: boolean
  readonly onConfirm: () => void
  readonly onCancel: () => void
}) {
  const titleId = useId()
  const ref = useRef<HTMLElement>(null)

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('h3')?.focus()
  }, [])

  // Listened to directly: jsx-a11y does not allow key handlers on a non-interactive element.
  useEffect(() => {
    const element = ref.current
    if (element === null) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onCancel()
      }
    }
    element.addEventListener('keydown', onKeyDown)
    return () => element.removeEventListener('keydown', onKeyDown)
  }, [onCancel])

  return (
    <section
      ref={ref}
      data-block-confirm=""
      aria-labelledby={titleId}
      className="flex flex-col gap-2 rounded-xl border border-taxi bg-canvas p-3"
    >
      <h3
        id={titleId}
        tabIndex={-1}
        className="text-base font-extrabold text-taxi-ink focus:outline-none"
      >
        {copy('safety.block.title', { handle })}
      </h3>
      <p className="text-sm text-fg">{copy('safety.block.body')}</p>
      <p className="text-sm font-semibold text-fg">{copy('safety.block.ends')}</p>
      <p className="text-sm text-muted">{copy('safety.block.private')}</p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onConfirm}
          aria-disabled={busy ? true : undefined}
          aria-label={copy('safety.actions.blockLabel', { handle })}
          className={`${SAFETY_BUTTON} bg-taxi text-on-taxi`}
        >
          {copy('safety.block.confirm')}
        </button>
        <button type="button" onClick={onCancel} className={`${SAFETY_BUTTON} bg-raised text-fg`}>
          {copy('safety.block.cancel')}
        </button>
      </div>
    </section>
  )
}
