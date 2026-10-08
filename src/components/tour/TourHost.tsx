'use client'

import { useEffect, useMemo } from 'react'
import { useStore } from 'zustand'
import { HUD_MORE_SELECTOR, focusFirstVisible } from '@/components/overlay/focusVisible'
import { useModalOpen } from '@/components/overlay/modalState'
import { engineConfig } from '@/engine/config'
import { copy } from '@/lib/copy'
import { formatCount } from '@/lib/format'
import { tourNames, tourStepText } from '@/lib/tourCopy'
import { onPlaceActionDone, useOpenPlaceId } from '@/state/placeSheet'
import { usePlacesPanelShown } from '@/state/placesPanel'
import { isAtPlace } from '@/engine/game'
import { gameStore } from '@/state/store'
import { setArrivalEventsSuppressed } from '@/state/trip'
import { TOUR_STEPS, isFreshStart, tourStore, type ActiveTour, type TourUi } from '@/state/tour'
import { TOUR_TARGET, tourConfig, tourHighlightCss, tourHighlightSelector } from './tourControl'
// Copy namespaces this module renders (DEC-11: they load with this module's chunk).
import '@/lib/copy/ns/tour'

/**
 * The first-run tour (S06, GR-9) in the overlay's banner zone: one line of coach-mark text over
 * the live map with Next or Skip, and a focus-coloured ring on the control the step is about. It
 * never takes focus, holds nothing inert and runs no timers: each step moves on what the player does
 * (opening Places, picking the place, buying there), so play is never blocked.
 *
 * A feature island loaded once the map is playable (TourMount). On load it settles this device's
 * first tour: a fresh game starts it; anyone else is marked done and never sees it unasked.
 */
export function TourHost() {
  const record = useStore(tourStore, (state) => state.record)
  const modalOpen = useModalOpen()
  const panelShown = usePlacesPanelShown()
  const openPlaceId = useOpenPlaceId()

  useEffect(() => {
    const game = gameStore.getState()
    tourStore.getState().begin(isFreshStart(game, engineConfig, tourConfig))
  }, [])

  useEffect(() => {
    const ui: TourUi = { panelShown, openPlaceId }
    tourStore.getState().dispatch({ type: 'ui', ui }, TOUR_TARGET)
  }, [panelShown, openPlaceId])

  // No random event greets an arrival while the tour runs (S06 rule, GR-9).
  const touring = record?.status === 'active'
  useEffect(() => {
    setArrivalEventsSuppressed(touring)
    return () => setArrivalEventsSuppressed(false)
  }, [touring])

  useEffect(
    () =>
      onPlaceActionDone((done) =>
        tourStore.getState().dispatch({ type: 'purchased', done }, TOUR_TARGET),
      ),
    [],
  )

  // The welcome card (or any modal) comes first; the tour waits behind it.
  if (modalOpen || record?.status !== 'active') return null
  return <TourCard record={record} ui={{ panelShown, openPlaceId }} />
}

/**
 * The card goes away with the button that had focus: focus moves to the More button, which
 * holds Help (the way back into the tour), instead of dropping to the page.
 */
function focusHelpOpener() {
  focusFirstVisible([HUD_MORE_SELECTOR, 'main'])
}

const BUTTON =
  'min-h-11 min-w-11 shrink-0 rounded-xl px-3 text-sm font-bold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus'

function TourCard({ record, ui }: { readonly record: ActiveTour; readonly ui: TourUi }) {
  const { step } = record
  const names = useMemo(() => {
    const { clock, player } = gameStore.getState()
    return tourNames(TOUR_TARGET, { clock, player })
  }, [])
  const here = useStore(gameStore, (state) => isAtPlace(state.player, TOUR_TARGET.placeId))
  const text = tourStepText(record, names, { here })
  const highlight = tourHighlightCss(tourHighlightSelector(step, TOUR_TARGET, CSS.escape))
  const number = formatCount(TOUR_STEPS.indexOf(step) + 1)
  const total = formatCount(TOUR_STEPS.length)
  // Steps that wait on the player doing something have no Next: the action is the way on.
  const advance = step === 'hud' || step === 'cash' || step === 'done'

  // The Places panel lists the place near its top, but on a short screen it may sit below the
  // fold of the scrolling sheet zone.
  useEffect(() => {
    if (step !== 'pick' || !ui.panelShown) return
    document
      .querySelector(tourHighlightSelector('pick', TOUR_TARGET, CSS.escape))
      ?.scrollIntoView({ block: 'nearest' })
  }, [step, ui.panelShown])

  return (
    <section
      aria-label={copy('tour.label')}
      data-cc-notice="tour"
      data-cc-feature="cc-feature:tour"
      data-tour-step={step}
      className="mx-2 flex h-full items-center gap-2 rounded-2xl border border-taxi glass px-2"
    >
      <style>{highlight}</style>
      <span
        aria-hidden="true"
        className="shrink-0 rounded-full bg-raised px-1.5 text-[0.6875rem] leading-5 font-bold text-taxi-ink"
      >
        {copy('tour.progress', { step: number, total })}
      </span>
      <span className="sr-only">{copy('tour.progressLabel', { step: number, total })}</span>
      <p role="status" className="line-clamp-2 min-w-0 flex-1 text-xs leading-tight text-fg">
        {text}
      </p>
      {advance ? (
        <button
          type="button"
          data-tour-next=""
          onClick={() => {
            tourStore.getState().dispatch({ type: 'next', ui }, TOUR_TARGET)
            if (step === 'done') focusHelpOpener()
          }}
          className={`${BUTTON} bg-taxi text-on-taxi`}
        >
          {copy(step === 'done' ? 'tour.done' : 'tour.next')}
        </button>
      ) : null}
      {step === 'done' ? null : (
        <button
          type="button"
          data-tour-skip=""
          aria-label={copy('tour.skipLabel')}
          onClick={() => {
            tourStore.getState().dispatch({ type: 'skip' }, TOUR_TARGET)
            focusHelpOpener()
          }}
          className={`${BUTTON} bg-raised text-fg`}
        >
          {copy('tour.skip')}
        </button>
      )}
    </section>
  )
}
