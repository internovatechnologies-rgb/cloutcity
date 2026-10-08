'use client'

import { useEffect, useRef, useState } from 'react'
import { useActionGuard } from '@/components/overlay/useActionGuard'
import type { GameSnapshot } from '@/engine/game'
import type { PlaceAction, PlaceActionResult } from '@/engine/placeActions'
import { copy } from '@/lib/copy'
import { rentNotice } from '@/lib/economyCopy'
import { log } from '@/lib/log'
import {
  placeActionAccessibleName,
  placeActionDetails,
  placeActionDone,
  placeActionName,
  placeBlockReason,
} from '@/lib/world/placeActionCopy'
import type { MapPlace } from '@/lib/world/places'
import '@/lib/copy/ns/place'

const BUTTON =
  'min-h-11 rounded-xl px-3 py-2 text-left font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus'

export type DoneOutcome = Extract<PlaceActionResult, { ok: true }>

/**
 * "Things to do" (S09, B1): one row per action the engine lists for a place or for home, each
 * with its plain time, costs and effects, and, when it cannot be done now, why (in its text and
 * its accessible name, GR-10/11). The place card and the home card (place sheet) and the Home
 * panel all use it, so every action behaves the same:
 * - a held Enter or Space acts once, a mouse double click's second click never acts, and a touch
 *   tap that lands again on the row it just pressed is ignored for the cooldown
 *   (`useActionGuard`);
 * - the action just done stays disabled while its result shows, so a fast double tap cannot run
 *   it twice; the result takes focus to its Dismiss button, and Dismiss gives focus back.
 * Rent that fell due while the action ran is part of the result line.
 */
export function ActionList({
  headingId,
  actions,
  place,
  snapshot,
  perform,
  onDone,
  onResultShown,
}: {
  readonly headingId: string
  readonly actions: readonly PlaceAction[]
  /** The place the actions are at, or null for home. */
  readonly place: Pick<MapPlace, 'id' | 'nameKey' | 'borough'> | null
  readonly snapshot: GameSnapshot
  /** Runs the action through the store (the engine re-checks every rule). */
  readonly perform: (actionId: string) => PlaceActionResult
  /** Called after an action succeeds, with the cash before it. */
  readonly onDone?: (outcome: DoneOutcome, actionId: string, cashBefore: number) => void
  /** Told whether a result line is showing (the card hides its arrival note meanwhile). */
  readonly onResultShown?: (shown: boolean) => void
}) {
  const [result, setResult] = useState<{ readonly actionId: string; readonly text: string } | null>(
    null,
  )
  const busy = useRef<string | null>(null)
  const refocus = useRef<string | null>(null)
  const dismissButton = useRef<HTMLButtonElement>(null)
  const ref = useRef<HTMLElement>(null)
  const { guard, onKeyDown, onPointerDown, coolingDown } = useActionGuard()

  useEffect(() => {
    onResultShown?.(result !== null)
  }, [result, onResultShown])

  // A new result takes focus to its Dismiss button (the action's own button is now disabled);
  // dismissing gives focus back to that action.
  useEffect(() => {
    if (result !== null) {
      dismissButton.current?.focus()
      return
    }
    const actionId = refocus.current
    refocus.current = null
    if (actionId === null) return
    ref.current
      ?.querySelector<HTMLButtonElement>(`button[data-place-action="${CSS.escape(actionId)}"]`)
      ?.focus()
  }, [result])

  const run = (action: PlaceAction) => {
    if (busy.current === action.id) return
    busy.current = action.id
    const cashBefore = snapshot.player.cash
    const outcome = perform(action.id)
    if (outcome.ok) {
      onDone?.(outcome, action.id, cashBefore)
      const text = [
        placeActionDone(outcome, place),
        ...outcome.rent.map((event) => rentNotice(event)),
      ]
      setResult({ actionId: action.id, text: text.join(' ') })
      return
    }
    // The UI only enables allowed actions, so a refusal here means the state moved under it.
    log.info('A place action was refused', {
      placeId: place?.id ?? 'home',
      code: outcome.error.code,
    })
    const text =
      outcome.error.code === 'BLOCKED'
        ? placeBlockReason(outcome.error.block, place, {}, action)
        : null
    if (text === null) {
      busy.current = null
      setResult(null)
    } else {
      setResult({ actionId: action.id, text })
    }
  }

  const dismiss = () => {
    refocus.current = result?.actionId ?? null
    busy.current = null
    setResult(null)
  }

  return (
    <section ref={ref} aria-labelledby={headingId} className="flex flex-col gap-1.5">
      <h3 id={headingId} className="text-xs font-bold text-muted uppercase">
        {copy('place.actions.heading')}
      </h3>
      {actions.length === 0 ? (
        <p className="text-sm text-muted">{copy('place.actions.none')}</p>
      ) : (
        <ul aria-busy={coolingDown} className="flex flex-col gap-1.5">
          {actions.map((action) => {
            const resultShowing = action.block === null && result?.actionId === action.id
            const name = placeActionAccessibleName(action, place, snapshot)
            return (
              <li key={action.id}>
                <button
                  type="button"
                  disabled={action.block !== null || resultShowing}
                  data-place-action={action.id}
                  aria-label={
                    resultShowing
                      ? copy('place.action.blockedLabel', {
                          action: name,
                          reason: copy('place.busy.reason'),
                        })
                      : name
                  }
                  onKeyDown={onKeyDown}
                  onPointerDown={onPointerDown}
                  // The guard drops a mouse double click's second click (the sheet grows with
                  // the result, so it can land on the next action) and a repeat touch tap.
                  onClick={(event) => guard(event, action.id, () => run(action))}
                  className={`${BUTTON} flex w-full flex-col bg-raised text-fg enabled:hover:bg-pressed disabled:opacity-70`}
                >
                  <span>{placeActionName(action)}</span>
                  <span className="text-xs font-normal text-muted">
                    {placeActionDetails(action, snapshot)}
                  </span>
                  {action.block === null ? null : (
                    <span className="text-xs font-normal text-taxi-ink">
                      {placeBlockReason(action.block, place, {}, action)}
                    </span>
                  )}
                  {resultShowing ? (
                    <span className="text-xs font-normal text-taxi-ink">
                      {copy('place.busy.reason')}
                    </span>
                  ) : null}
                </button>
              </li>
            )
          })}
        </ul>
      )}
      <div className="flex items-center justify-between gap-2">
        <p role="status" className="text-sm font-semibold text-taxi-ink">
          {result?.text}
        </p>
        {result === null ? null : (
          <button
            ref={dismissButton}
            type="button"
            onClick={dismiss}
            className={`${BUTTON} min-w-11 shrink-0 bg-raised text-center text-fg`}
          >
            {copy('place.result.dismiss')}
          </button>
        )}
      </div>
    </section>
  )
}
