'use client'

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { ignoreKeyRepeat } from '@/components/overlay/useActionGuard'
import type { PlayerLocation } from '@/engine/game'
import type { TravelMode } from '@/engine/transit/plan'
import { copy } from '@/lib/copy'
import { log } from '@/lib/log'
import {
  tripBlockReason,
  tripModeAction,
  tripOptionAccessibleName,
  tripOptionDetails,
} from '@/lib/world/travelCopy'
import { tripEnd } from '@/lib/world/tripEnds'
import type { MapPlace } from '@/lib/world/places'
import { useGameStore } from '@/state/store'
import { useActiveTrip } from '@/state/trip'
import type { StartTripError } from '@/state/tripDriver'
import '@/lib/copy/ns/travel'

type TripDriver = typeof import('@/state/tripDriver')

const BUTTON =
  'min-h-11 rounded-xl px-3 py-2 text-left font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus'

interface DriverLoad {
  readonly driver: TripDriver | null
  readonly failed: boolean
  readonly retry: () => void
}

/** The travel chunk (src/state/tripDriver.ts), loaded on first use, with a retry on failure. */
function useTripDriver(): DriverLoad {
  const [driver, setDriver] = useState<TripDriver | null>(null)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let active = true
    import('@/state/tripDriver').then(
      (module) => {
        if (!active) return
        setFailed(false)
        setDriver(module)
      },
      (error: unknown) => {
        // Offline before the chunk was cached: expected; the section offers a retry.
        log.info('The travel chunk could not load', {
          error: error instanceof Error ? error.name : typeof error,
        })
        if (active) setFailed(true)
      },
    )
    return () => {
      active = false
    }
  }, [attempt])
  return { driver, failed, retry: () => setAttempt((value) => value + 1) }
}

/**
 * "Get there" (S08 part 2): one row per mode from where the player stands to this place (or
 * home), built from the engine's own planning so each row's time and fare are what the trip
 * does (GR-10). A mode that cannot be taken stays listed, disabled, with why in its text and
 * accessible name. While the routes load the rows wait; if they cannot load, the taxi estimate
 * stays available with a Retry.
 */
export function TravelSection({
  destination,
  place,
  headingId,
}: {
  readonly destination: PlayerLocation
  /** The destination place (its borough explains a lock), or null for home. */
  readonly place: Pick<MapPlace, 'borough'> | null
  readonly headingId: string
}) {
  const { driver, failed, retry } = useTripDriver()
  return (
    <section aria-labelledby={headingId} data-get-there="" className="flex flex-col gap-1.5">
      <h3 id={headingId} className="text-xs font-bold text-muted uppercase">
        {copy('travel.getThere.heading')}
      </h3>
      {driver === null && failed ? (
        <RetryRow onRetry={retry} />
      ) : driver === null ? (
        <p role="status" className="text-sm text-muted">
          {copy('travel.status.loading')}
        </p>
      ) : (
        <TravelRows driver={driver} destination={destination} place={place} />
      )}
    </section>
  )
}

function RetryRow({ onRetry, note }: { readonly onRetry: () => void; readonly note?: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <p role="status" className="text-sm text-muted">
        {note ?? copy('travel.status.failed')}
      </p>
      <button
        type="button"
        data-travel-retry=""
        onClick={onRetry}
        aria-label={copy('travel.retryLabel')}
        className={`${BUTTON} min-w-11 shrink-0 bg-raised text-center text-fg`}
      >
        {copy('travel.retry')}
      </button>
    </div>
  )
}

function TravelRows({
  driver,
  destination,
  place,
}: {
  readonly driver: TripDriver
  readonly destination: PlayerLocation
  readonly place: Pick<MapPlace, 'borough'> | null
}) {
  const store = driver.transitWorldStore
  const status = useSyncExternalStore(
    store.subscribe,
    () => store.getState().status,
    () => 'idle' as const,
  )
  const clock = useGameStore((state) => state.clock)
  const player = useGameStore((state) => state.player)
  const tripActive = useActiveTrip() !== null
  const [refusal, setRefusal] = useState<StartTripError | null>(null)

  const plan = useMemo(() => {
    const from = tripEnd(player.location, player.home)
    const to = tripEnd(destination, player.home)
    return from === undefined || to === undefined ? null : { from, to }
  }, [player.location, player.home, destination])
  // Planned again when the routes finish loading, the clock moves (rush hour) or the player
  // changes (cash against fares, the at-zero slowdown).
  const rows = useMemo(
    () =>
      plan === null
        ? null
        : { ...driver.tripOptionsFor(plan, { clock, player }), shownFor: status },
    [driver, plan, clock, player, status],
  )

  if (plan === null || rows === null) return null
  if (rows.options.length === 0) {
    return (
      <p role="status" className="text-sm text-muted">
        {copy('travel.status.loading')}
      </p>
    )
  }

  const take = (mode: TravelMode) => {
    const result = driver.startTrip(plan, mode)
    setRefusal(result.ok ? null : result.error)
  }

  return (
    <>
      {status === 'failed' ? <RetryRow onRetry={() => void driver.retryTransitWorld()} /> : null}
      <ul className="flex flex-col gap-1.5">
        {rows.options.map((option) => {
          const block = tripActive ? ({ code: 'TRIP_IN_PROGRESS' } as const) : option.block
          const shown = { ...option, block }
          return (
            <li key={option.mode}>
              <button
                type="button"
                disabled={block !== null}
                data-trip-mode={option.mode}
                aria-label={tripOptionAccessibleName(shown, place)}
                onClick={() => take(option.mode)}
                // A held Enter starts one trip; its repeats must not press what replaces the row.
                onKeyDown={ignoreKeyRepeat}
                className={`${BUTTON} flex w-full flex-col bg-raised text-fg enabled:hover:bg-pressed disabled:opacity-70`}
              >
                <span>{tripModeAction(option.mode)}</span>
                <span className="text-xs font-normal text-muted">
                  {tripOptionDetails(option)}
                  {status === 'failed' && option.route !== null
                    ? `, ${copy('travel.option.estimate')}`
                    : ''}
                </span>
                {block === null ? null : (
                  <span className="text-xs font-normal text-taxi-ink">
                    {tripBlockReason(block, place)}
                  </span>
                )}
              </button>
            </li>
          )
        })}
      </ul>
      {refusal === null ? null : (
        <p role="status" className="text-sm font-semibold text-taxi-ink">
          {tripBlockReason(refusal, place)}
        </p>
      )}
    </>
  )
}
