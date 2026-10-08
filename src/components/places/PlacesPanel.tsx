'use client'

import { useEffect, useId, useRef } from 'react'
import { engineConfig } from '@/engine/config'
import { isAtPlace } from '@/engine/game'
import { copy } from '@/lib/copy'
import { homeName } from '@/lib/economyCopy'
import {
  boroughAccessFor,
  boroughClosedReason,
  boroughs,
  gateClout,
  isMemorial,
  mapPlaces,
  placeAccess,
  placeAccessibleName,
  placeName,
  type MapPlace,
} from '@/lib/world/places'
import { openPlace, useOpenPlaceId } from '@/state/placeSheet'
import {
  closePlacesPanel,
  keepPlacesPanel,
  openPlacesPanel,
  usePlacesPanel,
  usePlacesPanelShown,
} from '@/state/placesPanel'
import { useGameStore } from '@/state/store'
import { HOME_SPOT_ID } from '@/state/trip'
// Copy namespaces this module renders (DEC-11: they load with this module's chunk; places.ts
// registers boroughs, landmarks, places and venues).
import '@/lib/copy/ns/places'
import '@/lib/copy/ns/travel'

const BUTTON =
  'min-h-11 w-full rounded-xl px-3 py-2 text-left font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus'

/** Gives focus back to the HUD's Places button (or the scene when it is gone). */
function focusPlacesButton() {
  const target =
    document.querySelector<HTMLElement>('[data-places-button]') ?? document.querySelector('main')
  target?.focus()
}

/**
 * The Places panel (S04c): every place on the map as a native button, grouped by borough in
 * data/boroughs/boroughs.json order, so every place a 3D pin offers is reachable by keyboard and
 * screen reader too (A11Y-3). A button opens the same sheet a pin tap does (`openPlace`, origin
 * `panel`), and the map flies to the place. Closed places stay enabled: their sheet explains the
 * lock, and their accessible name already says why ("Brooklyn Bridge. Brooklyn is locked: ...").
 *
 * In chooser mode (a tap landed on several pins at once) it lists only those places, nearest
 * first, with a way back to the full list.
 *
 * A non-modal dialog in the sheet zone, like the place sheet, hidden while a place sheet is open
 * (or, when the app opened it, while a HUD panel is) and shown again when that closes. Focus moves to the title when the player opens it, never when
 * the app opens it because the 3D map is unavailable; Escape and Close close it and give focus
 * back to the HUD's Places button.
 */
export function PlacesPanel() {
  const panel = usePlacesPanel()
  const openId = useOpenPlaceId()
  // The same clout the engine's gates read (levelClout), never the raw total.
  const clout = useGameStore((state) => gateClout(state.player, engineConfig))
  const location = useGameStore((state) => state.player.location)
  const home = useGameStore((state) => state.player.home)
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const lastOpened = useRef<string | null>(null)
  const hidden = !usePlacesPanelShown()
  const chooser = panel.mode === 'chooser'

  // Focus the title when the player opened the panel (or switched it to a chooser).
  useEffect(() => {
    if (panel.auto) return
    ref.current?.querySelector<HTMLElement>('h2')?.focus()
  }, [panel.auto, panel.mode, panel.chooserIds])

  // Back from a place sheet: if focus was lost with it, return it to that place's button.
  useEffect(() => {
    if (openId !== null) {
      lastOpened.current = openId
      return
    }
    const id = lastOpened.current
    lastOpened.current = null
    if (id === null) return
    // The sheet hands focus back to what had it on open, or to <main> when that is gone; the
    // picked button was hidden by then, so either way focus is not on a control.
    const active = document.activeElement
    if (active !== null && active !== document.body && active.tagName !== 'MAIN') return
    ref.current?.querySelector<HTMLElement>(`[data-place-button="${CSS.escape(id)}"]`)?.focus()
  }, [openId])

  // Listened to directly: jsx-a11y does not allow key handlers on a non-interactive role.
  useEffect(() => {
    const dialog = ref.current
    if (dialog === null) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      closePlacesPanel()
      focusPlacesButton()
    }
    dialog.addEventListener('keydown', onKeyDown)
    return () => dialog.removeEventListener('keydown', onKeyDown)
  }, [])

  const pick = (place: MapPlace) => {
    keepPlacesPanel()
    openPlace(place.id, { origin: 'panel' })
  }

  /** A row's name, with "You're here" where the player stands (S08). */
  const rowLabel = (name: string, here: boolean) =>
    here ? copy('travel.panel.hereLabel', { name }) : name
  const hereBadge = (
    <span
      aria-hidden="true"
      className="shrink-0 rounded-full bg-taxi px-2 text-xs leading-5 font-bold text-on-taxi"
    >
      {copy('travel.hereBadge')}
    </span>
  )

  const placeButton = (place: MapPlace) => {
    const here = isAtPlace({ location }, place.id)
    return (
      <li key={place.id}>
        <button
          type="button"
          data-place-button={place.id}
          data-player-here={here ? '' : undefined}
          aria-label={rowLabel(placeAccessibleName(place, placeAccess(place, clout)), here)}
          onClick={() => pick(place)}
          className={`${BUTTON} flex items-center justify-between gap-2 bg-raised text-fg`}
        >
          <span className="min-w-0">{placeName(place)}</span>
          {here ? hereBadge : null}
        </button>
      </li>
    )
  }

  // Home (S08): the way back from anywhere, first in the list.
  const atHome = location.kind === 'home'
  const homeLabel = copy('travel.panel.home', { home: homeName(home) })
  const homeRow = (
    <ul className="flex flex-col gap-1.5">
      <li>
        <button
          type="button"
          data-place-button={HOME_SPOT_ID}
          data-player-here={atHome ? '' : undefined}
          aria-label={rowLabel(homeLabel, atHome)}
          onClick={() => {
            keepPlacesPanel()
            openPlace(HOME_SPOT_ID, { origin: 'panel' })
          }}
          className={`${BUTTON} flex items-center justify-between gap-2 bg-raised text-fg`}
        >
          <span className="min-w-0">{homeLabel}</span>
          {atHome ? hereBadge : null}
        </button>
      </li>
    </ul>
  )

  const places = mapPlaces()
  const chosen = chooser
    ? panel.chooserIds.flatMap((id) => places.filter((place) => place.id === id))
    : []

  return (
    <div
      ref={ref}
      role="dialog"
      aria-labelledby={titleId}
      hidden={hidden}
      data-places-panel={panel.mode}
      data-cc-feature="cc-feature:places-panel"
      className="m-2 flex flex-col gap-2 rounded-2xl border border-line glass p-3 shadow-lg"
    >
      <div className="flex items-start justify-between gap-2">
        <h2
          id={titleId}
          tabIndex={-1}
          className="text-base leading-tight font-extrabold text-fg focus:outline-none"
        >
          {copy(chooser ? 'places.panel.chooserTitle' : 'places.panel.title')}
        </h2>
        <button
          type="button"
          onClick={() => {
            closePlacesPanel()
            focusPlacesButton()
          }}
          aria-label={copy('places.panel.closeLabel')}
          className="min-h-11 min-w-11 shrink-0 rounded-xl bg-raised px-3 py-2 text-center font-semibold text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          {copy('places.panel.close')}
        </button>
      </div>
      {chooser ? (
        <>
          <p className="text-sm text-muted">{copy('places.panel.chooserHint')}</p>
          <ul className="flex flex-col gap-1.5">{chosen.map(placeButton)}</ul>
          <button
            type="button"
            onClick={openPlacesPanel}
            className={`${BUTTON} border border-line text-muted`}
          >
            {copy('places.panel.showAll')}
          </button>
        </>
      ) : (
        <>
          {homeRow}
          {boroughs.map((borough) => {
            const inBorough = places.filter((place) => place.borough === borough.id)
            if (inBorough.length === 0) return null
            const headingId = `${titleId}-${borough.id}`
            const reason = boroughClosedReason(borough.id, boroughAccessFor(borough.id, clout))
            // A borough's lock never attaches to a memorial (DEC-46): in a locked borough the
            // memorials sit apart from the locked places, under a plain note, and stay open.
            const memorials =
              reason === null ? [] : inBorough.filter((place) => isMemorial(place.id))
            const gated = inBorough.filter((place) => !memorials.includes(place))
            return (
              <section
                key={borough.id}
                aria-labelledby={headingId}
                className="flex flex-col gap-1.5"
              >
                <h3 id={headingId} className="text-sm font-bold text-fg">
                  {placeName({ id: borough.id, nameKey: borough.nameKey })}
                </h3>
                {reason === null ? null : <p className="text-xs text-muted">{reason}</p>}
                {gated.length === 0 ? null : (
                  <ul className="flex flex-col gap-1.5">{gated.map(placeButton)}</ul>
                )}
                {memorials.length === 0 ? null : (
                  <>
                    <p data-memorials-open="" className="text-xs text-muted">
                      {copy('places.memorials.open')}
                    </p>
                    <ul className="flex flex-col gap-1.5">{memorials.map(placeButton)}</ul>
                  </>
                )}
              </section>
            )
          })}
        </>
      )}
    </div>
  )
}
