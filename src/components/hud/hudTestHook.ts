import { minutesPerDay } from '@/engine/clock'
import { engineConfig } from '@/engine/config'
import { shopItems } from '@/engine/items'
import { nextRentDueDay, rentFor } from '@/engine/rent'
import { gameStore } from '@/state/store'

/**
 * Test-only hook for the S10a shop, inventory and rent flows (tests/e2e/shop-jobs-rent.spec.ts)
 * and the S16 home (tests/e2e/home-apartment.spec.ts),
 * on `window.__cloutcityTest.hud`. Only builds with NEXT_PUBLIC_TEST_HOOKS=1 load it (from its
 * own chunk, see HudPanelMount), and it installs only when the page also sets
 * `window.__CLOUTCITY_E2E__ = true` before the app loads (Playwright's addInitScript). Time moves through the
 * store's `advanceMinutes`, so decay and rent run through the engine like any other advance.
 * The energy setter writes the local save directly, which anyone with devtools can already do.
 */
export interface HudTestHook {
  /**
   * Fast-forwards the personal clock to the first minute of the next rent day, so that rent
   * is charged. Returns the 1-based day it fell on.
   */
  advancePastNextRentDay(): number
  /** Fast-forwards the personal clock by whole game minutes (decay and rent apply). */
  advanceMinutes(minutes: number): void
  setEnergy(energy: number): void
  /** Buys an item through the store and engine (funds and ownership still apply); false if refused. */
  buy(itemId: string): boolean
  state(): {
    readonly cash: number
    readonly minute: number
    readonly energy: number
    readonly home: string
    readonly rentForHome: number
    readonly owned: readonly string[]
    readonly outfit: Readonly<Record<string, string>>
    readonly gifts: Readonly<Record<string, number>>
    /** Owned decor (S16): item id → the colour variant shown. */
    readonly decor: Readonly<Record<string, string>>
    /** Decor placed in the current home: slot id → item id. */
    readonly placed: Readonly<Record<string, string>>
    readonly lastRentEvent: string | null
  }
  /**
   * Every item the shop sells, with its price, so specs assert against data, not literals;
   * `gift` and `decor` mark those that are not wearables.
   */
  shop(): readonly {
    readonly id: string
    readonly price: number
    readonly gift: boolean
    readonly decor: boolean
  }[]
}

declare global {
  interface CloutcityTestHooks {
    hud?: HudTestHook
  }
}

export function installHudTestHook(): void {
  if (window.__CLOUTCITY_E2E__ !== true) return
  window.__cloutcityTest = { ...window.__cloutcityTest, hud: createHudTestHook() }
}

function createHudTestHook(): HudTestHook {
  return {
    advancePastNextRentDay: () => {
      const { clock } = gameStore.getState()
      const day = nextRentDueDay(clock.minute, engineConfig)
      const target = (day - 1) * minutesPerDay(engineConfig)
      gameStore.getState().advanceMinutes(target - clock.minute)
      return day
    },
    advanceMinutes: (minutes) => gameStore.getState().advanceMinutes(minutes),
    setEnergy: (energy) => {
      const { max } = engineConfig.stats
      if (!Number.isSafeInteger(energy) || energy < 0 || energy > max) {
        throw new RangeError(`energy must be a whole number from 0 to ${max}: ${energy}`)
      }
      const { player } = gameStore.getState()
      gameStore.setState({ player: { ...player, stats: { ...player.stats, energy } } })
    },
    buy: (itemId) => gameStore.getState().buyItem(itemId).ok,
    state: () => {
      const { player, clock, lastRentEvent } = gameStore.getState()
      return {
        cash: player.cash,
        minute: clock.minute,
        energy: player.stats.energy,
        home: player.home,
        rentForHome: rentFor(player.home, engineConfig),
        owned: player.inventory.wearables.map((owned) => owned.itemId),
        outfit: { ...player.inventory.outfit },
        gifts: Object.fromEntries(player.inventory.gifts.map((g) => [g.itemId, g.count])),
        decor: Object.fromEntries(player.inventory.decor.map((d) => [d.itemId, d.variant])),
        placed: { ...player.apartment.placed },
        lastRentEvent: lastRentEvent?.kind ?? null,
      }
    },
    shop: () =>
      shopItems(engineConfig).map((item) => ({
        id: item.id,
        price: item.price,
        gift: item.category === 'gift',
        decor: item.category === 'decor',
      })),
  }
}
