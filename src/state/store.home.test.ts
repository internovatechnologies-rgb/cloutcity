/** S16 in the store: decor placement, colour variants and moving home persist; level-ups toast. */
import { describe, expect, it } from 'vitest'
import { engineConfig } from '@/engine/config'
import { homeClout } from '@/engine/home'
import { playerWithClout } from '@/engine/test-support'
import { createLogger } from '@/lib/log'
import { createSafeJsonStorage } from './storage'
import {
  STORE_KEY,
  STORE_VERSION,
  createGameStore,
  initialPersistedState,
  type PersistedState,
} from './store'

class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>()
  get length() {
    return this.map.size
  }
  clear() {
    this.map.clear()
  }
  getItem(key: string) {
    return this.map.get(key) ?? null
  }
  key(index: number) {
    return [...this.map.keys()][index] ?? null
  }
  removeItem(key: string) {
    this.map.delete(key)
  }
  setItem(key: string, value: string) {
    this.map.set(key, value)
  }
}

function setup(local = new MemoryStorage()) {
  const logger = createLogger({ level: 'debug', sink: () => {} })
  const storage = createSafeJsonStorage<PersistedState>(() => local, logger)
  return { local, store: () => createGameStore(storage, logger) }
}

const saved = (local: Storage) =>
  JSON.parse(local.getItem(STORE_KEY) ?? 'null') as { state: PersistedState; version: number }

const NEON = 'custom-neon-sign'
const fresh = initialPersistedState()

/** A save with `cash` and earned clout `clout`, written to `local` before the store loads. */
function seeded(cash: number, clout = 0) {
  const { local, store } = setup()
  const player = playerWithClout({ ...fresh.player, cash }, clout, engineConfig)
  local.setItem(STORE_KEY, JSON.stringify({ state: { ...fresh, player }, version: STORE_VERSION }))
  return { local, game: store(), reload: store }
}

describe('decor in the store', () => {
  it('a placement persists across a reload', () => {
    const { local, game, reload } = seeded(1000)
    expect(game.getState().buyItem(NEON).ok).toBe(true)
    expect(game.getState().placeDecor(NEON, 'wall-1').ok).toBe(true)
    expect(saved(local).state.player.apartment.placed).toEqual({ 'wall-1': NEON })
    const again = reload().getState()
    expect(again.player.apartment.placed).toEqual({ 'wall-1': NEON })
    expect(again.player.inventory.decor.map((owned) => owned.itemId)).toEqual([NEON])
    expect(homeClout(again.player, engineConfig)).toBeGreaterThan(0)
  })

  it('a colour change and a removal persist too', () => {
    const { local, game, reload } = seeded(1000)
    game.getState().buyItem(NEON)
    game.getState().placeDecor(NEON, 'wall-1')
    expect(game.getState().setDecorVariant(NEON, 'mint').ok).toBe(true)
    expect(saved(local).state.player.inventory.decor[0]?.variant).toBe('mint')
    expect(game.getState().removeDecor('wall-1').ok).toBe(true)
    expect(saved(local).state.player.apartment.placed).toEqual({})
    expect(reload().getState().player.inventory.decor[0]?.variant).toBe('mint')
  })

  it('a refused placement changes nothing and writes nothing', () => {
    const { local, game } = seeded(1000)
    game.getState().buyItem(NEON)
    const before = local.getItem(STORE_KEY)
    const result = game.getState().placeDecor(NEON, 'floor-1')
    expect(result.ok === false && result.error.code).toBe('WRONG_SLOT_KIND')
    expect(local.getItem(STORE_KEY)).toBe(before)
    expect(game.getState().player.apartment.placed).toEqual({})
  })

  it('a placement that reaches a level shows the level-up toast and reaches the goal', () => {
    const item = engineConfig.items.catalog.find((entry) => entry.id === NEON)
    const neonScore = item?.category === 'decor' ? item.decor.homeScore : Number.NaN
    const local = engineConfig.clout.levels[1]
    const { game } = seeded(1000, (local?.minClout ?? 0) - neonScore)
    game.getState().buyItem(NEON)
    expect(game.getState().lastLevelUp).toBeNull()
    const result = game.getState().placeDecor(NEON, 'wall-1')
    expect(result.ok && result.levelUp).toMatchObject({ to: 'local', source: 'home' })
    expect(game.getState().lastLevelUp).toMatchObject({ to: 'local', source: 'home' })
    expect(game.getState().goals.achieved['reach-local']).toBeDefined()
  })
})

describe('moving home in the store', () => {
  it('a move persists the new home, the cash paid and the move log', () => {
    const { local, game, reload } = seeded(2000, 100)
    const result = game.getState().moveHome('brooklyn-1br')
    expect(result.ok).toBe(true)
    const cost = engineConfig.housing.moveInCost['brooklyn-1br'] ?? 0
    const written = saved(local).state.player
    expect(written.home).toBe('brooklyn-1br')
    expect(written.cash).toBe(2000 - cost)
    expect(written.apartment.moveLog).toHaveLength(1)
    expect(reload().getState().player.home).toBe('brooklyn-1br')
  })

  it('a home in a locked borough is refused and nothing changes', () => {
    const { game } = seeded(0)
    const result = game.getState().moveHome('brooklyn-1br')
    expect(result.ok === false && result.error.code).toBe('BOROUGH_LOCKED')
    expect(game.getState().player.home).toBe(engineConfig.startHome)
  })

  it('a move whose base score reaches a level shows the toast', () => {
    const known = engineConfig.clout.levels.find((level) => level.id === 'known')?.minClout ?? 0
    const { game } = seeded(50_000, known - engineConfig.home.baseScore['manhattan-loft'])
    const result = game.getState().moveHome('manhattan-loft')
    expect(result.ok).toBe(true)
    expect(game.getState().lastLevelUp).toMatchObject({ to: 'known', source: 'home' })
  })
})
