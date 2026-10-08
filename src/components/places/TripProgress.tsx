'use client'

import { useEffect, useRef } from 'react'
import { ignoreKeyRepeat } from '@/components/overlay/useActionGuard'
import { copy } from '@/lib/copy'
import { formatCount } from '@/lib/format'
import { tripProgressText } from '@/lib/world/travelCopy'
import { useTripProgress, type ActiveTrip } from '@/state/trip'
import '@/lib/copy/ns/travel'

const PERCENT = 100

/**
 * The trip under way (S08 part 2), in the sheet zone while the avatar travels: where to, how,
 * a progress bar, and Skip. One compact row, so it fits the 90 px sheet zone of a short
 * landscape phone (UX-11). The trip is already in the save; Skip only ends the animation.
 */
export function TripProgress({ trip }: { readonly trip: ActiveTrip }) {
  const progress = useTripProgress()
  const text = tripProgressText(trip.destination, trip.mode)
  const percent = Math.round(Math.min(1, Math.max(0, progress)) * PERCENT)
  const skipButton = useRef<HTMLButtonElement>(null)

  // Focus stays with the trip: the button the player pressed has gone with the sheet.
  useEffect(() => {
    skipButton.current?.focus()
  }, [trip.id])

  return (
    <div
      data-trip-progress={trip.mode}
      data-cc-feature="cc-feature:trip-progress"
      className="m-2 flex items-center gap-2 rounded-2xl border border-line glass p-2 shadow-lg"
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm leading-tight font-extrabold text-fg">{text.title}</p>
        <p className="truncate text-xs text-muted">{text.mode}</p>
        <div
          role="progressbar"
          aria-label={copy('travel.progress.label')}
          aria-valuemin={0}
          aria-valuemax={PERCENT}
          aria-valuenow={percent}
          aria-valuetext={copy('travel.progress.value', { percent: formatCount(percent) })}
          className="mt-1 h-1.5 overflow-hidden rounded-full bg-raised"
        >
          <div className="h-full bg-taxi" style={{ width: `${percent}%` }} />
        </div>
      </div>
      <button
        ref={skipButton}
        type="button"
        data-trip-skip=""
        aria-label={copy('travel.skipLabel')}
        onClick={() => void import('@/state/tripDriver').then((module) => module.skipTrip())}
        // Focus lands here while the Enter that started the trip may still be held (TRV-6): its
        // repeats must not skip the trip.
        onKeyDown={ignoreKeyRepeat}
        className="min-h-11 min-w-11 shrink-0 rounded-xl bg-raised px-3 text-sm font-bold text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        {copy('travel.skip')}
      </button>
    </div>
  )
}
