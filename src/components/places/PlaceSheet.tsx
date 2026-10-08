'use client'

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useModalOpen } from '@/components/overlay/modalState'
import { engineConfig } from '@/engine/config'
import { isAtPlace, type GameSnapshot } from '@/engine/game'
import { homeActions, hasShop, placeActions } from '@/engine/placeActions'
import type { Place } from '@/engine/places'
import { copy, isCopyKey, type CopyKey } from '@/lib/copy'
import { log } from '@/lib/log'
import { clubDoorLine, placeHoursLine } from '@/lib/world/placeActionCopy'
import { findPlace, placeName } from '@/lib/world/places'
import { arrivalText, homeBlurb } from '@/lib/world/travelCopy'
import {
  announcePlace,
  closePlace,
  reportPlaceActionDone,
  usePlaceOpenCount,
  usePlaceOrigin,
} from '@/state/placeSheet'
import { gameStore, useGameStore } from '@/state/store'
import {
  dismissArrival,
  HOME_SPOT_ID,
  spotId,
  useActiveTrip,
  useTripArrival,
  type TripArrival,
} from '@/state/trip'
import { ActionList, type DoneOutcome } from './ActionList'
import { ShopSection } from './ShopSection'
import { TravelSection } from './TravelSection'
import { TripProgress } from './TripProgress'
// Copy namespaces this module renders (DEC-11: they load with this module's chunk).
import '@/lib/copy/ns/boroughs'
import '@/lib/copy/ns/club'
import '@/lib/copy/ns/landmarks'
import '@/lib/copy/ns/place'
import '@/lib/copy/ns/places'
import '@/lib/copy/ns/travel'
import '@/lib/copy/ns/venues'

/**
 * The location action sheet (S09), in the overlay `sheet` zone. One sheet for every way into a
 * place (3D pin, Places panel): it lists what the engine says the player can do there right
 * now on the personal clock, each blocked action with its reason. Memorials get a muted info
 * card with no actions.
 *
 * A non-modal dialog on purpose: the map, HUD and tabs stay usable while it is open, so a
 * player can tap another place (which swaps the sheet) without closing this one first. Focus
 * moves into it on open and back on close; Escape and the Close button close it. Loaded
 * lazily on first use by PlaceSheetMount (DEC-11).
 */
export function PlaceSheet({ placeId }: { readonly placeId: string | null }) {
  const trip = useActiveTrip()
  const place = placeId === null || placeId === HOME_SPOT_ID ? undefined : findPlace(placeId)
  const unknown = placeId !== null && placeId !== HOME_SPOT_ID && place === undefined

  useEffect(() => {
    if (!unknown) return
    log.info('No place with that id; closing the place sheet', { placeId })
    closePlace()
  }, [unknown, placeId])

  // While a trip animates (S08) the sheet zone shows its progress; the destination's sheet
  // opens again on arrival.
  if (trip !== null) return <TripProgress trip={trip} />
  if (placeId === HOME_SPOT_ID) return <HomeCard />
  if (place === undefined) return null
  return <PlaceCard key={place.id} place={place} />
}

/** The arrival line for the card with `id` (`home` or a place id), or null. */
function useArrivalFor(id: string): TripArrival | null {
  const arrival = useTripArrival()
  return arrival !== null && spotId(arrival.destination) === id ? arrival : null
}

/** Announces every pick by name (A11Y-3), or the arrival when a trip just ended there. */
function useSheetAnnouncement(name: string) {
  const openCount = usePlaceOpenCount()
  const origin = usePlaceOrigin()
  useEffect(() => {
    announcePlace(
      copy(origin === 'travel' ? 'travel.announce.arrived' : 'places.announce.opened', {
        place: name,
      }),
    )
  }, [openCount, origin, name])
}

/** Gives focus back on close to what had it on open (or to the scene if that is gone). */
function useFocusReturn() {
  useEffect(() => {
    const previous = document.activeElement
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected && previous !== document.body) {
        previous.focus()
      } else {
        document.querySelector<HTMLElement>('main')?.focus()
      }
    }
  }, [])
}

/** Escape closes the sheet. Listened to directly: jsx-a11y allows no key handler on a dialog. */
function useEscapeCloses(ref: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const dialog = ref.current
    if (dialog === null) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closePlace()
    }
    dialog.addEventListener('keydown', onKeyDown)
    return () => dialog.removeEventListener('keydown', onKeyDown)
  }, [ref])
}

/** Focuses the title on open (once a modal holding the page inert at boot has closed). */
function useTitleFocus(ref: React.RefObject<HTMLDivElement | null>) {
  const blocked = useModalOpen()
  const titleFocused = useRef(false)
  useEffect(() => {
    if (blocked || titleFocused.current) return
    titleFocused.current = true
    ref.current?.querySelector<HTMLElement>('h2')?.focus()
  }, [blocked, ref])
}

/** The arrival line with its Dismiss button, in the card's status. */
function ArrivalNote({ arrival }: { readonly arrival: TripArrival }) {
  const dismissButton = useRef<HTMLButtonElement>(null)
  // A trip ends with focus here (TRV-3): the button the player pressed went with the trip, and
  // when the trip cut straight to the arrival (reduced motion, no 3D map) the sheet never closed,
  // so nothing else would take it. A sheet that mounts on arrival then focuses its title.
  useEffect(() => {
    dismissButton.current?.focus()
  }, [arrival.id])
  const dismiss = () => {
    // The button goes with the note: focus moves to the sheet's title, not the page.
    dismissButton.current?.closest('[role="dialog"]')?.querySelector<HTMLElement>('h2')?.focus()
    dismissArrival(arrival.id)
  }
  return (
    <div className="flex items-center justify-between gap-2" data-trip-arrival="">
      <p role="status" className="text-sm font-semibold text-taxi-ink">
        {arrivalText(arrival)}
      </p>
      <button
        ref={dismissButton}
        type="button"
        onClick={dismiss}
        className={`${BUTTON} min-w-11 shrink-0 bg-raised text-center text-fg`}
      >
        {copy('place.result.dismiss')}
      </button>
    </div>
  )
}

/**
 * The home card (reserved id `home`, S08): where the player lives, the way back there from
 * anywhere, and what they can do there (B1): sleep, nap and cook, which bring energy and
 * fullness back. Away from home those rows stay listed, each saying to head home first
 * (DEC-22), under "Get there". The Home panel (HUD) is where the apartment itself is decorated.
 */
function HomeCard() {
  const clock = useGameStore((state) => state.clock)
  const player = useGameStore((state) => state.player)
  const snapshot: GameSnapshot = useMemo(() => ({ clock, player }), [clock, player])
  const actions = useMemo(() => homeActions(snapshot, engineConfig), [snapshot])
  const [resultShown, setResultShown] = useState(false)
  const home = player.home
  const atHome = player.location.kind === 'home'
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const name = copy('travel.home.title')
  const arrival = useArrivalFor(HOME_SPOT_ID)
  useSheetAnnouncement(name)
  useFocusReturn()
  useTitleFocus(ref)
  useEscapeCloses(ref)

  return (
    <div
      ref={ref}
      role="dialog"
      aria-labelledby={titleId}
      data-place-sheet={HOME_SPOT_ID}
      data-player-here={atHome ? '' : undefined}
      data-cc-feature="cc-feature:place-sheet"
      className="m-2 flex flex-col gap-2 rounded-2xl border border-line glass p-3 shadow-lg"
    >
      <div className="flex items-start justify-between gap-2">
        <h2
          id={titleId}
          tabIndex={-1}
          className="text-base leading-tight font-extrabold text-taxi-ink focus:outline-none"
        >
          {name}
        </h2>
        <button
          type="button"
          onClick={closePlace}
          aria-label={copy('place.sheet.closeLabel', { place: name })}
          className={`${BUTTON} min-w-11 shrink-0 bg-raised text-center text-fg`}
        >
          {copy('place.sheet.close')}
        </button>
      </div>
      <p className="text-sm text-fg">{homeBlurb(home)}</p>
      {atHome ? (
        <p className="text-sm font-semibold text-muted">{copy('travel.hereHome')}</p>
      ) : (
        <TravelSection
          destination={{ kind: 'home' }}
          place={null}
          headingId={`${titleId}-travel`}
        />
      )}
      {arrival === null || resultShown ? null : <ArrivalNote arrival={arrival} />}
      <ActionList
        headingId={`${titleId}-actions`}
        actions={actions}
        place={null}
        snapshot={snapshot}
        perform={performHomeAction}
        onResultShown={setResultShown}
      />
    </div>
  )
}

const performHomeAction = (actionId: string) => gameStore.getState().performHomeAction(actionId)

const BUTTON =
  'min-h-11 rounded-xl px-3 py-2 text-left font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus'

function PlaceCard({ place }: { readonly place: Place }) {
  const clock = useGameStore((state) => state.clock)
  const player = useGameStore((state) => state.player)
  const snapshot: GameSnapshot = useMemo(() => ({ clock, player }), [clock, player])
  const view = useMemo(() => placeActions(place, snapshot, engineConfig), [place, snapshot])
  const [resultShown, setResultShown] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const name = placeName(place)
  const lookOnly = view.kind === 'look-only'

  const here = isAtPlace(player, place.id)
  const arrival = useArrivalFor(place.id)

  // Every pick, from the map or the Places panel, is announced by name (A11Y-3), including a
  // repeat pick of the open place (openPlace cleared the announcement); an arrival says so.
  useSheetAnnouncement(name)
  // On close, give focus back to what had it on open. Runs before the title takes focus, so it
  // records the control the player was on.
  useFocusReturn()
  useTitleFocus(ref)
  useEscapeCloses(ref)

  const perform = useCallback(
    (actionId: string) => gameStore.getState().performPlaceAction(place, actionId),
    [place],
  )
  const onDone = useCallback(
    (outcome: DoneOutcome, actionId: string, cashBefore: number) =>
      reportPlaceActionDone({
        placeId: place.id,
        actionId,
        cashBefore,
        cashAfter: outcome.snapshot.player.cash,
      }),
    [place],
  )

  const info = 'category' in place ? place.infoKey : place.blurbKey

  return (
    <div
      ref={ref}
      role="dialog"
      aria-labelledby={titleId}
      data-place-sheet={place.id}
      data-cc-feature="cc-feature:place-sheet"
      data-look-only={lookOnly ? '' : undefined}
      data-player-here={here ? '' : undefined}
      className={`m-2 flex flex-col gap-2 rounded-2xl border p-3 shadow-lg ${
        lookOnly ? 'border-line bg-canvas' : 'border-line glass'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2
            id={titleId}
            tabIndex={-1}
            className="text-base leading-tight font-extrabold text-fg focus:outline-none"
          >
            {name}
          </h2>
          <p className="text-xs text-muted">
            {view.kind === 'look-only' ? copy('place.memorial.label') : placeHoursLine(view.hours)}
          </p>
          {view.kind === 'actions' && view.door !== null ? (
            <p data-club-door={view.door.met ? 'met' : 'below'} className="text-xs text-muted">
              {clubDoorLine(view.door, snapshot)}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={closePlace}
          aria-label={copy('place.sheet.closeLabel', { place: name })}
          className={`${BUTTON} min-w-11 shrink-0 bg-raised text-center text-fg`}
        >
          {copy('place.sheet.close')}
        </button>
      </div>
      <p className="text-sm text-fg">{copy(infoKeyOf(info))}</p>
      {here ? (
        <p data-here-note="" className="text-sm font-semibold text-muted">
          {copy('travel.here')}
        </p>
      ) : (
        <TravelSection
          destination={{ kind: 'place', placeId: place.id }}
          place={place}
          headingId={`${titleId}-travel`}
        />
      )}
      {arrival === null || resultShown ? null : <ArrivalNote arrival={arrival} />}
      {view.kind === 'look-only' ? (
        <p className="text-sm text-muted">{copy('place.memorial.note')}</p>
      ) : (
        <ActionList
          headingId={`${titleId}-actions`}
          actions={view.actions}
          place={place}
          snapshot={snapshot}
          perform={perform}
          onDone={onDone}
          onResultShown={setResultShown}
        />
      )}
      {view.kind !== 'look-only' && hasShop(place) ? (
        <ShopSection place={place} headingId={`${titleId}-shop`} />
      ) : null}
    </div>
  )
}

function infoKeyOf(key: string): CopyKey {
  if (!isCopyKey(key)) throw new Error(`No copy key "${key}" for a place blurb or info`)
  return key
}
