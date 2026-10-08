'use client'

import type { RentEvent } from '@/engine/rent'
import { copy } from '@/lib/copy'
import { rentNotice } from '@/lib/economyCopy'
import { useToastTimer } from './LevelUpToast'
// Copy namespaces this module renders (DEC-11: they load with this module's chunk).
import '@/lib/copy/ns/rent'

/**
 * The missed-rent toast: one notice in the overlay toast zone when rent was missed (or the
 * player was evicted), with what is owed and how many misses are left, the same words as the
 * Rent panel's last notice. It never takes focus, closes itself after `overlay.toastMs` with the
 * level-up toast's pause rules, and has a Close button. Loaded lazily by the toast host
 * (LevelUpToast.tsx) the first time rent goes unpaid.
 */
export function RentToast({
  event,
  onClose,
}: {
  readonly event: RentEvent
  readonly onClose: () => void
}) {
  const { ref, paused } = useToastTimer(onClose)
  return (
    <div
      ref={ref}
      data-rent-toast={event.kind}
      data-cc-feature="cc-feature:rent-toast"
      data-cc-notice="rent"
      data-paused={paused ? '' : undefined}
      className="level-up-pop mx-2 flex items-center gap-2 rounded-2xl border border-taxi glass px-3 py-1 shadow-lg"
    >
      <p className="min-w-0 flex-1 text-xs leading-tight text-fg">{rentNotice(event)}</p>
      <button
        type="button"
        onClick={onClose}
        aria-label={copy('rent.toast.closeLabel')}
        className="min-h-11 min-w-11 shrink-0 rounded-xl bg-raised px-3 text-sm font-semibold text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        {copy('rent.toast.close')}
      </button>
    </div>
  )
}
