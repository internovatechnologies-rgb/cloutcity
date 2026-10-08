import { calendar, minutesPerDay } from '@/engine/clock'
import { cloutLevel, itemClout, legacyCloutState, playerLevel, totalClout } from '@/engine/clout'
import { engineConfig } from '@/engine/config'
import { homeClout } from '@/engine/home'
import { placeActions } from '@/engine/placeActions'
import { findPlace } from '@/lib/world/places'
import type { PlayerLocation } from '@/engine/game'
import { closePlace, onPlacePicked, openPlace } from '@/state/placeSheet'
import { gameStore } from '@/state/store'
import { HOME_SPOT_ID } from '@/state/trip'

/**
 * Test-only hook so Playwright can open any place by id and set up the player
 * (tests/e2e/place-sheet.spec.ts). Installed only when the page sets
 * `window.__CLOUTCITY_E2E__ = true` before the app loads (Playwright's addInitScript), from its
 * own lazily loaded chunk. Opening goes through `openPlace` (origin `hook`, so the 3D map brings
 * the place into view), the same entry point the 3D pins and Places panel use, and actions still
 * run through the engine. The setters write the local
 * save directly, which anyone with devtools can already do.
 *
 * Location (S08, DEC-22): a place's actions need the player there. Specs about a place's own
 * rules run with the e2e fixture option `location: 'follow'`, which sets
 * `window.__CLOUTCITY_E2E_LOCATION__ = 'follow'`: every place picked (pin, panel, hook) then
 * puts the player there, as if they had travelled. The default, `home`, plays it straight.
 */
export interface PlaceTestHook {
  /** Opens a place's sheet (or the home card, `home`); false when no place has that id. */
  open(placeId: string): boolean
  /** Puts the player at a place, or at home with `home`, without travelling. */
  setLocation(placeId: string): void
  close(): void
  /** Moves the personal clock forward to the next `minuteOfDay` (0..1439). */
  setTimeOfDay(minuteOfDay: number): void
  /**
   * Sets the player's total clout to `clout`: the ledger becomes one legacy entry (less the
   * clout their wearables and home already carry), and the level it lands on counts as reached,
   * so no level-up is reported for it.
   */
  setClout(clout: number): void
  setCash(cash: number): void
  state(): {
    readonly cash: number
    /** Total clout (src/engine/clout.ts `totalClout`). */
    readonly clout: number
    /** The current clout level id. */
    readonly level: string
    readonly minute: number
    readonly minuteOfDay: number
    readonly stats: { readonly energy: number; readonly hunger: number; readonly mood: number }
    readonly location: PlayerLocation
  }
  /** The engine's view of a place's actions, so specs assert against config, not literals. */
  actions(placeId: string): readonly {
    readonly id: string
    readonly durationMin: number
    readonly cashCost: number
    readonly mood: number
    readonly cloutGain: number
    readonly blocked: string | null
  }[]
}

declare global {
  interface Window {
    __CLOUTCITY_E2E__?: boolean
    /** `follow`: picking a place puts the player there (see PlaceTestHook). */
    __CLOUTCITY_E2E_LOCATION__?: 'follow' | 'home'
    __cloutcityPlaces?: PlaceTestHook
  }
}

const wholeNonNegative = (value: number, what: string) => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${what} must be a whole, non-negative number: ${value}`)
  }
}

const locationOf = (placeId: string): PlayerLocation =>
  placeId === HOME_SPOT_ID ? { kind: 'home' } : { kind: 'place', placeId }

function setLocation(placeId: string): void {
  if (placeId !== HOME_SPOT_ID && findPlace(placeId) === undefined) {
    throw new Error(`No place "${placeId}"`)
  }
  const { player } = gameStore.getState()
  gameStore.setState({ player: { ...player, location: locationOf(placeId) } })
}

export function installPlaceTestHook(): void {
  if (window.__CLOUTCITY_E2E__ !== true) return
  if (window.__CLOUTCITY_E2E_LOCATION__ === 'follow') {
    // Runs inside openPlace, before the sheet renders: it opens with the player already there.
    onPlacePicked((placeId) => setLocation(placeId))
  }
  window.__cloutcityPlaces = {
    open: (placeId) => {
      if (placeId !== HOME_SPOT_ID && findPlace(placeId) === undefined) return false
      openPlace(placeId, { origin: 'hook' })
      return true
    },
    setLocation,
    close: closePlace,
    setTimeOfDay: (minuteOfDay) => {
      const perDay = minutesPerDay(engineConfig)
      wholeNonNegative(minuteOfDay, 'minuteOfDay')
      if (minuteOfDay >= perDay) throw new RangeError(`minuteOfDay must be below ${perDay}`)
      const { clock } = gameStore.getState()
      const now = calendar(clock.minute, engineConfig).minuteOfDay
      const ahead = (minuteOfDay - now + perDay) % perDay
      gameStore.setState({ clock: { ...clock, minute: clock.minute + ahead } })
    },
    setClout: (clout) => {
      wholeNonNegative(clout, 'clout')
      const { player } = gameStore.getState()
      const carried = itemClout(player, engineConfig) + homeClout(player, engineConfig)
      const earned = Math.max(0, clout - carried)
      const peak = cloutLevel(clout, engineConfig).index
      const ledger = {
        ...legacyCloutState(earned, peak),
        firstPaycheckPaid: player.clout.firstPaycheckPaid,
      }
      gameStore.setState({ player: { ...player, clout: ledger } })
    },
    setCash: (cash) => {
      wholeNonNegative(cash, 'cash')
      const { player } = gameStore.getState()
      gameStore.setState({ player: { ...player, cash } })
    },
    state: () => {
      const { player, clock } = gameStore.getState()
      return {
        cash: player.cash,
        clout: totalClout(player, engineConfig),
        level: playerLevel(player, engineConfig).id,
        minute: clock.minute,
        minuteOfDay: calendar(clock.minute, engineConfig).minuteOfDay,
        stats: player.stats,
        location: player.location,
      }
    },
    actions: (placeId) => {
      const place = findPlace(placeId)
      if (place === undefined) throw new Error(`No place "${placeId}"`)
      const view = placeActions(place, gameStore.getState(), engineConfig)
      if (view.kind === 'look-only') return []
      return view.actions.map((action) => ({
        id: action.id,
        durationMin: action.def.durationMin,
        cashCost: action.def.cashCost,
        mood: action.def.statEffects.mood ?? 0,
        cloutGain: action.kind === 'club-night' || action.kind === 'flex' ? action.cloutGain : 0,
        blocked: action.block?.code ?? null,
      }))
    },
  }
}
