import { describe, expect, it } from 'vitest'
import { minutesPerDay } from '@/engine/clock'
import { engineConfig } from '@/engine/config'
import { initialCloutState, legacyCloutState } from '@/engine/clout'
import { playerWithClout } from '@/engine/test-support'
import { initialFlexState } from '@/engine/game'
import { initialApartment } from '@/engine/home'
import type { EventContext } from '@/engine/events'
import { nextRentDueDay } from '@/engine/rent'
import { createLogger, type LogRecord } from '@/lib/log'
import { toNpcId } from '@/engine/items'
import { createSafeJsonStorage } from './storage'
import {
  PersistedStateSchema,
  STORE_KEY,
  STORE_VERSION,
  createGameStore,
  initialPersistedState,
  type PersistedState,
} from './store'

/** A minimal in-memory Web Storage, standing in for window.localStorage. */
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

/** Throws on every access, like Safari private mode or blocked site data. */
class ThrowingStorage extends MemoryStorage {
  override getItem(): string | null {
    throw new DOMException('denied', 'SecurityError')
  }
  override setItem(): void {
    throw new DOMException('full', 'QuotaExceededError')
  }
}

function setup(local: Storage | undefined = new MemoryStorage()) {
  const records: LogRecord[] = []
  const logger = createLogger({ level: 'debug', sink: (record) => records.push(record) })
  const storage = createSafeJsonStorage<PersistedState>(() => local, logger)
  return { local, records, logger, store: () => createGameStore(storage, logger) }
}

const saved = (local: Storage) => JSON.parse(local.getItem(STORE_KEY) ?? 'null') as unknown

const fresh = initialPersistedState()
const saveOf = (cash: number): PersistedState => ({ ...fresh, player: { ...fresh.player, cash } })
/** The shipped bodega breakfast's price (balance.json is tuned, so tests read it). */
const BODEGA = engineConfig.actions.catalog['bodega-breakfast']?.cashCost ?? Number.NaN
const START_CASH = engineConfig.startCash

describe('game store persistence', () => {
  it('starts from the balance anchors', () => {
    const { store } = setup()
    const state = store().getState()
    expect(state.player).toEqual({
      cash: 150,
      stats: { energy: 100, hunger: 80, mood: 70 },
      clout: initialCloutState,
      flex: initialFlexState,
      home: 'queens-room',
      rent: { owed: 0, missed: 0 },
      inventory: { wearables: [], gifts: [], outfit: {}, decor: [] },
      clubNights: {},
      visited: {},
      apartment: initialApartment,
      location: { kind: 'home' },
      transit: { rngState: 0 },
    })
    expect(state.lastLevelUp).toBeNull()
    expect(state.clock).toEqual({ minute: 480, remainderMs: 0 })
    expect(state.speed).toBe(1)
  })

  it('persists state with the schema version on every change', () => {
    const { local, store } = setup()
    const game = store()
    expect(game.getState().performAction('bodega-breakfast').ok).toBe(true)
    const after = saved(local!) as { state: PersistedState; version: number }
    expect(after.version).toBe(STORE_VERSION)
    expect(after.state.player.cash).toBe(START_CASH - BODEGA)
    expect(after.state.clock.minute).toBe(500)
    expect(Object.keys(after.state).sort()).toEqual([
      'actions',
      'clock',
      'events',
      'goals',
      'grants',
      'player',
      'prestige',
      'speed',
    ])
  })

  it('rehydrates a new store from what an earlier one saved', () => {
    const local = new MemoryStorage()
    const first = setup(local).store()
    first.getState().performAction('bodega-breakfast')
    first.getState().setSpeed(2)
    const reloaded = setup(local).store()
    expect(reloaded.persist.hasHydrated()).toBe(true)
    expect(reloaded.getState().player).toEqual(first.getState().player)
    expect(reloaded.getState().clock).toEqual(first.getState().clock)
    expect(reloaded.getState().speed).toBe(2)
    expect(typeof reloaded.getState().performAction).toBe('function')
  })

  it('migrates a v1 save: keeps cash, starts clock and stats fresh, and re-saves it', () => {
    const local = new MemoryStorage()
    local.setItem(STORE_KEY, JSON.stringify({ state: { player: { cash: 999 } }, version: 1 }))
    const { records, store } = setup(local)
    expect(store().getState().player).toEqual(saveOf(999).player)
    expect(saved(local)).toEqual({ state: saveOf(999), version: STORE_VERSION })
    expect(records.some((r) => r.level === 'info' && /upgraded/i.test(r.msg))).toBe(true)
  })

  it('migrates a save from an unknown older version to a fresh state and re-saves it', () => {
    const local = new MemoryStorage()
    local.setItem(STORE_KEY, JSON.stringify({ state: { money: 5 }, version: 0 }))
    const store = setup(local).store()
    expect(store.getState().player).toEqual(fresh.player)
    expect(saved(local)).toEqual({ state: fresh, version: STORE_VERSION })
  })

  it('does not load or overwrite a save from a newer build', () => {
    const local = new MemoryStorage()
    const newer = JSON.stringify({ state: saveOf(5000), version: STORE_VERSION + 1 })
    local.setItem(STORE_KEY, newer)
    const { records, store } = setup(local)
    expect(store().getState().player).toEqual(fresh.player)
    expect(local.getItem(STORE_KEY)).toBe(newer)
    // Expected, so info (warn fails the e2e console guard); the save is kept untouched.
    expect(records.some((r) => r.level === 'info' && /newer build/i.test(r.msg))).toBe(true)
    expect(records.filter((r) => r.level === 'warn' || r.level === 'error')).toEqual([])
  })

  it.each([
    ['corrupt JSON', '{not json'],
    ['the wrong envelope', JSON.stringify(['cash', 1])],
    ['negative cash', JSON.stringify({ state: saveOf(-5), version: STORE_VERSION })],
    [
      'a stat of the wrong type',
      JSON.stringify({
        state: {
          ...fresh,
          player: { ...fresh.player, stats: { ...fresh.player.stats, mood: 'high' } },
        },
        version: STORE_VERSION,
      }),
    ],
    ['a missing clock', JSON.stringify({ state: { ...saveOf(10), clock: undefined }, version: 2 })],
    [
      'a fractional clock minute',
      JSON.stringify({
        state: { ...fresh, clock: { minute: 1.5, remainderMs: 0 } },
        version: STORE_VERSION,
      }),
    ],
    ['unknown keys', JSON.stringify({ state: { ...fresh, admin: true }, version: STORE_VERSION })],
  ])('ignores %s and starts fresh', (_label, raw) => {
    const local = new MemoryStorage()
    local.setItem(STORE_KEY, raw)
    const { records, store } = setup(local)
    expect(store().getState().player).toEqual(fresh.player)
    expect(records.some((r) => r.level === 'info' && /saved game/i.test(r.msg))).toBe(true)
    expect(records.filter((r) => r.level === 'warn' || r.level === 'error')).toEqual([])
  })

  it('repairs individually invalid fields and keeps the rest of the progress', () => {
    const local = new MemoryStorage()
    const damaged = {
      clock: { minute: 2000, remainderMs: 'soon' },
      player: {
        cash: 777,
        stats: { energy: 140, hunger: -3, mood: 41.6 },
        clout: legacyCloutState(12, 0),
        home: 'penthouse',
        rent: { owed: 280, missed: 1.4 },
        inventory: { wearables: [], gifts: [], outfit: {}, decor: [] },
      },
      speed: 3,
    }
    local.setItem(STORE_KEY, JSON.stringify({ state: damaged, version: STORE_VERSION }))
    const { records, store } = setup(local)
    const { clock, player, speed } = store().getState()
    expect({ clock, player, speed }).toEqual({
      clock: { minute: 2000, remainderMs: 0 },
      player: {
        cash: 777,
        stats: { energy: 100, hunger: 0, mood: 42 },
        clout: legacyCloutState(12, 0),
        flex: initialFlexState,
        home: 'queens-room',
        rent: { owed: 280, missed: 1 },
        inventory: { wearables: [], gifts: [], outfit: {}, decor: [] },
        clubNights: {},
        visited: {},
        apartment: initialApartment,
        location: { kind: 'home' },
        transit: { rngState: 0 },
      },
      speed: 1,
    })
    expect(records.some((r) => r.level === 'info' && /repaired/i.test(r.msg))).toBe(true)
    expect(records.filter((r) => r.level === 'warn' || r.level === 'error')).toEqual([])
  })

  it('the fresh state fits the save schema', () => {
    expect(PersistedStateSchema.safeParse(fresh).success).toBe(true)
  })
})

describe('store actions call the engine', () => {
  it('tick advances the clock only while visible', () => {
    const { local, store } = setup()
    const game = store()
    game.getState().tick(60_000, false)
    expect(game.getState().clock.minute).toBe(480)
    expect(local!.getItem(STORE_KEY)).toBeNull()
    for (let i = 0; i < 12; i++) game.getState().tick(5000, true)
    expect(game.getState().clock.minute).toBe(490)
  })

  it('tick runs twice as fast at 2x', () => {
    const { store } = setup()
    const game = store()
    game.getState().setSpeed(2)
    for (let i = 0; i < 12; i++) game.getState().tick(5000, true)
    expect(game.getState().clock.minute).toBe(500)
  })

  it('rejects an unsupported speed', () => {
    const { store } = setup()
    const game = store()
    expect(() => game.getState().setSpeed(3)).toThrow(RangeError)
    expect(game.getState().speed).toBe(1)
  })

  it('performAction applies an ok result and leaves state alone on an error', () => {
    const { store } = setup()
    const game = store()
    const ok = game.getState().performAction('bodega-breakfast')
    expect(ok.ok).toBe(true)
    expect(game.getState().player.cash).toBe(START_CASH - BODEGA)
    const before = game.getState()
    const unknown = game.getState().performAction('teleport')
    expect(unknown).toEqual({ ok: false, error: { code: 'UNKNOWN_ACTION', actionId: 'teleport' } })
    expect(game.getState()).toBe(before)
  })

  it('reports insufficient funds without spending', () => {
    const local = new MemoryStorage()
    local.setItem(STORE_KEY, JSON.stringify({ state: saveOf(5), version: STORE_VERSION }))
    const game = setup(local).store()
    const result = game.getState().performAction('bodega-breakfast')
    expect(result).toEqual({
      ok: false,
      error: { code: 'INSUFFICIENT_FUNDS', required: BODEGA, available: 5 },
    })
    expect(game.getState().player.cash).toBe(5)
    expect(game.getState().clock.minute).toBe(480)
  })
})

describe('storage unavailable', () => {
  it('keeps working in memory when localStorage throws, and says so once at info', () => {
    const { records, store } = setup(new ThrowingStorage())
    const game = store()
    game.getState().performAction('bodega-breakfast')
    game.getState().performAction('bodega-breakfast')
    expect(game.getState().player.cash).toBe(START_CASH - 2 * BODEGA)
    expect(records.filter((r) => r.level === 'info')).toHaveLength(1)
    expect(records.filter((r) => r.level === 'warn' || r.level === 'error')).toEqual([])
  })

  it('keeps working when accessing localStorage itself throws', () => {
    const records: LogRecord[] = []
    const logger = createLogger({ sink: (record) => records.push(record) })
    const storage = createSafeJsonStorage<PersistedState>(() => {
      throw new DOMException('denied', 'SecurityError')
    }, logger)
    const game = createGameStore(storage, logger)
    game.getState().performAction('bodega-breakfast')
    expect(game.getState().player.cash).toBe(START_CASH - BODEGA)
    const { clock, player, speed, events, goals, grants, prestige, actions } = game.getState()
    expect(storage.getItem(STORE_KEY)).toEqual({
      state: { clock, player, speed, events, goals, grants, prestige, actions },
      version: STORE_VERSION,
    })
  })

  it('falls back to memory on the server, where there is no localStorage', () => {
    const { store } = setup(undefined)
    const game = store()
    game.getState().performAction('bodega-breakfast')
    expect(game.getState().player.cash).toBe(START_CASH - BODEGA)
  })

  it('switches to memory mid-session when a write starts failing', () => {
    const local = new MemoryStorage()
    const { records, store } = setup(local)
    const game = store()
    game.getState().performAction('bodega-breakfast')
    local.setItem = () => {
      throw new DOMException('full', 'QuotaExceededError')
    }
    game.getState().performAction('bodega-breakfast')
    expect(game.getState().player.cash).toBe(START_CASH - 2 * BODEGA)
    expect(records.filter((r) => r.level === 'info')).toHaveLength(1)
    expect(records.filter((r) => r.level === 'warn' || r.level === 'error')).toEqual([])
  })
})

describe('S03 save edge cases through the persist middleware', () => {
  it('a v1 save with extra keys starts fresh and is replaced with a valid current save', () => {
    const local = new MemoryStorage()
    local.setItem(
      STORE_KEY,
      JSON.stringify({ state: { player: { cash: 999 }, extra: 1 }, version: 1 }),
    )
    const game = setup(local).store()
    expect(game.getState().player).toEqual(fresh.player)
    expect(saved(local)).toEqual({ state: fresh, version: STORE_VERSION })
  })

  it('a v1 save round-trips to the current version and back through a reload with cash intact', () => {
    const local = new MemoryStorage()
    local.setItem(STORE_KEY, JSON.stringify({ state: { player: { cash: 321 } }, version: 1 }))
    setup(local).store()
    const reloaded = setup(local).store()
    expect(reloaded.getState().player.cash).toBe(321)
    const envelope = saved(local) as { state: unknown; version: number }
    expect(envelope.version).toBe(STORE_VERSION)
    expect(PersistedStateSchema.safeParse(envelope.state).success).toBe(true)
  })

  it.each([
    ['a negative remainder', { minute: 500, remainderMs: -1 }],
    ['a remainder of a whole game minute', { minute: 500, remainderMs: 6000 }],
  ])(
    'repairs %s in a current-version save: the remainder resets, the minute is kept',
    (_label, clock) => {
      // Orchestrator ruling (S03 F3): repair an invalid field instead of discarding the save.
      const local = new MemoryStorage()
      local.setItem(
        STORE_KEY,
        JSON.stringify({
          state: { ...fresh, clock, player: { ...fresh.player, cash: 777 } },
          version: STORE_VERSION,
        }),
      )
      const game = setup(local).store()
      expect(game.getState().clock).toEqual({ minute: 500, remainderMs: 0 })
      expect(game.getState().player.cash).toBe(777)
    },
  )

  it('a newer-version save is neither loaded nor overwritten while the tab stays hidden', () => {
    const local = new MemoryStorage()
    const newer = JSON.stringify({ state: saveOf(5000), version: STORE_VERSION + 1 })
    local.setItem(STORE_KEY, newer)
    const game = setup(local).store()
    expect(game.getState().player.cash).toBe(fresh.player.cash)
    // Hidden ticks do not change state, so nothing is written.
    game.getState().tick(60_000, false)
    game.getState().tick(0, true)
    expect(local.getItem(STORE_KEY)).toBe(newer)
  })

  it('insufficient funds leaves the whole persisted state deep-equal and writes nothing', () => {
    const local = new MemoryStorage()
    const raw = JSON.stringify({ state: saveOf(5), version: STORE_VERSION })
    local.setItem(STORE_KEY, raw)
    const game = setup(local).store()
    const before = structuredClone({
      clock: game.getState().clock,
      player: game.getState().player,
      speed: game.getState().speed,
    })
    const writesBefore = local.getItem(STORE_KEY)
    expect(game.getState().performAction('bodega-breakfast').ok).toBe(false)
    const { clock, player, speed } = game.getState()
    expect({ clock, player, speed }).toEqual(before)
    expect(local.getItem(STORE_KEY)).toBe(writesBefore)
  })
})

describe('saving is guarded', () => {
  it('a newer-build save stays byte-identical through ticks and actions until discarded', () => {
    const local = new MemoryStorage()
    const newer = JSON.stringify({ state: saveOf(5000), version: STORE_VERSION + 1 })
    local.setItem(STORE_KEY, newer)
    const game = setup(local).store()
    expect(game.getState().newerSavePresent).toBe(true)
    game.getState().tick(1000, true)
    for (let i = 0; i < 20; i++) game.getState().tick(5000, true)
    expect(game.getState().performAction('bodega-breakfast').ok).toBe(true)
    game.getState().setSpeed(2)
    expect(game.getState().clock.minute).toBeGreaterThan(480)
    expect(local.getItem(STORE_KEY)).toBe(newer)
  })

  it('writes resume after discardNewerSaveAndStartFresh', () => {
    const local = new MemoryStorage()
    local.setItem(STORE_KEY, JSON.stringify({ state: saveOf(5000), version: STORE_VERSION + 1 }))
    const game = setup(local).store()
    game.getState().performAction('bodega-breakfast')
    game.getState().discardNewerSaveAndStartFresh()
    expect(game.getState().newerSavePresent).toBe(false)
    expect(saved(local)).toEqual({ state: fresh, version: STORE_VERSION })
    game.getState().performAction('bodega-breakfast')
    expect((saved(local) as { state: PersistedState }).state.player.cash).toBe(START_CASH - BODEGA)
  })

  it('a normal load is not flagged as a newer save', () => {
    const { store } = setup()
    expect(store().getState().newerSavePresent).toBe(false)
  })

  it('a tick that only moves the sub-minute carry changes no state and does not write', () => {
    const local = new MemoryStorage()
    local.setItem(STORE_KEY, JSON.stringify({ state: fresh, version: STORE_VERSION }))
    const before = local.getItem(STORE_KEY)
    const game = setup(local).store()
    const clock = game.getState().clock
    game.getState().tick(1000, true)
    game.getState().tick(4000, true)
    expect(game.getState().clock).toBe(clock)
    expect(local.getItem(STORE_KEY)).toBe(before)
  })

  it('a tick that changes the minute writes', () => {
    const local = new MemoryStorage()
    local.setItem(STORE_KEY, JSON.stringify({ state: fresh, version: STORE_VERSION }))
    const game = setup(local).store()
    game.getState().tick(5000, true)
    game.getState().tick(1000, true)
    expect((saved(local) as { state: PersistedState }).state.clock).toEqual({
      minute: 481,
      remainderMs: 0,
    })
  })

  it('a speed change writes', () => {
    const { local, store } = setup()
    store().getState().setSpeed(2)
    expect((saved(local!) as { state: PersistedState }).state.speed).toBe(2)
  })
})

describe('jobs and rent in the store', () => {
  it('workShift credits the wage, moves the clock and persists the result', () => {
    const local = new MemoryStorage()
    const game = setup(local).store()
    const result = game.getState().workShift('barista')
    expect(result.ok && result.wage).toBe(56)
    expect(game.getState().player.cash).toBe(150 + 56)
    expect(game.getState().clock.minute).toBe(480 + 240)
    const after = saved(local) as { state: PersistedState }
    expect(after.state.player.cash).toBe(206)
  })

  it('workShift leaves state alone when the job is locked', () => {
    const game = setup().store()
    const before = game.getState()
    const result = game.getState().workShift('junior-dev')
    expect(result.ok === false && result.error.code).toBe('JOB_LOCKED')
    expect(game.getState()).toBe(before)
  })

  it('a v2 save keeps its progress and starts in the start home with nothing owed', () => {
    const local = new MemoryStorage()
    const v2 = {
      clock: { minute: 5000, remainderMs: 0 },
      player: { cash: 333, stats: { energy: 60, hunger: 50, mood: 40 } },
      speed: 1,
    }
    local.setItem(STORE_KEY, JSON.stringify({ state: v2, version: 2 }))
    const { player, clock } = setup(local).store().getState()
    expect(clock.minute).toBe(5000)
    expect(player).toEqual({
      ...v2.player,
      clout: initialCloutState,
      flex: initialFlexState,
      home: 'queens-room',
      rent: { owed: 0, missed: 0 },
      inventory: { wearables: [], gifts: [], outfit: {}, decor: [] },
      clubNights: {},
      visited: {},
      apartment: initialApartment,
      location: { kind: 'home' },
      transit: { rngState: 0 },
    })
    expect((saved(local) as { version: number }).version).toBe(STORE_VERSION)
  })

  it('a rent change alone is a meaningful change that is written', () => {
    const local = new MemoryStorage()
    const owing = { ...fresh, player: { ...fresh.player, cash: 0 } }
    local.setItem(STORE_KEY, JSON.stringify({ state: owing, version: STORE_VERSION }))
    const game = setup(local).store()
    // Fast-forward to just before the first rent day, then let it pass.
    game.setState({ clock: { minute: 7 * 24 * 60 - 1, remainderMs: 0 } })
    // One game minute of passive time, in two ticks (each tick is capped at maxTickRealMs).
    game.getState().tick(3000, true)
    game.getState().tick(3000, true)
    expect(game.getState().clock.minute).toBe(7 * 24 * 60)
    const after = saved(local) as { state: PersistedState }
    expect(after.state.player.rent).toEqual({ owed: 280, missed: 1 })
  })
})

describe('jobs and rent in the store: guards', () => {
  it('a locked job writes nothing to storage', () => {
    const local = new MemoryStorage()
    const raw = JSON.stringify({ state: saveOf(150), version: STORE_VERSION })
    local.setItem(STORE_KEY, raw)
    const game = setup(local).store()
    const written = local.getItem(STORE_KEY)
    expect(game.getState().workShift('junior-dev').ok).toBe(false)
    expect(local.getItem(STORE_KEY)).toBe(written)
  })

  it('a shift without enough energy leaves state deep-equal and writes nothing', () => {
    const local = new MemoryStorage()
    const tired = {
      ...fresh,
      player: { ...fresh.player, stats: { ...fresh.player.stats, energy: 24 } },
    }
    local.setItem(STORE_KEY, JSON.stringify({ state: tired, version: STORE_VERSION }))
    const game = setup(local).store()
    const before = structuredClone({ clock: game.getState().clock, player: game.getState().player })
    const written = local.getItem(STORE_KEY)
    const result = game.getState().workShift('delivery')
    expect(result.ok === false && result.error.code).toBe('INSUFFICIENT_ENERGY')
    expect({ clock: game.getState().clock, player: game.getState().player }).toEqual(before)
    expect(local.getItem(STORE_KEY)).toBe(written)
  })

  it('an unknown job id changes nothing', () => {
    const game = setup().store()
    const before = game.getState()
    const result = game.getState().workShift('__proto__')
    expect(result.ok === false && result.error.code).toBe('UNKNOWN_JOB')
    expect(game.getState()).toBe(before)
  })

  it('a newer-build save stays byte-identical through shifts and rent', () => {
    const local = new MemoryStorage()
    const newer = JSON.stringify({ state: saveOf(5000), version: STORE_VERSION + 1 })
    local.setItem(STORE_KEY, newer)
    const game = setup(local).store()
    // The newer save is not loaded (fresh $150), so a shift across the first rent boundary
    // both pays a wage and misses rent: two state changes, neither written.
    game.setState({ clock: { minute: 7 * 24 * 60 - 60, remainderMs: 0 } })
    const result = game.getState().workShift('barista')
    expect(result.ok && result.rent.map((event) => event.kind)).toEqual(['missed'])
    expect(local.getItem(STORE_KEY)).toBe(newer)
  })

  it.each([
    ['__proto__', 'queens-room'],
    ['constructor', 'queens-room'],
    ['toString', 'queens-room'],
    ['manhattan-loft', 'manhattan-loft'],
  ])('a v3 save with home %j loads in %s', (home, expected) => {
    const local = new MemoryStorage()
    const raw = `{"state":{"clock":{"minute":900,"remainderMs":0},"player":{"cash":321,"stats":{"energy":50,"hunger":50,"mood":50},"clout":0,"home":${JSON.stringify(home)},"rent":{"owed":0,"missed":0}},"speed":1},"version":3}`
    local.setItem(STORE_KEY, raw)
    const { player } = setup(local).store().getState()
    expect(player.home).toBe(expected)
    expect(player.cash).toBe(321)
    expect(Object.getPrototypeOf(player)).toBe(Object.prototype)
  })

  it('a v3 save with a string missed count keeps its progress and resets the count', () => {
    const local = new MemoryStorage()
    const tampered = {
      ...saveOf(321),
      player: { ...saveOf(321).player, rent: { owed: 280, missed: '2' } },
    }
    local.setItem(STORE_KEY, JSON.stringify({ state: tampered, version: STORE_VERSION }))
    const { player } = setup(local).store().getState()
    expect(player.cash).toBe(321)
    expect(player.rent).toEqual({ owed: 280, missed: 0 })
  })

  it.each([
    ['negative owed', { owed: -5, missed: 0 }],
    ['a missing rent object', undefined],
  ])('a v3 save with %s is unusable and starts fresh', (_label, rent) => {
    const local = new MemoryStorage()
    const tampered = { ...saveOf(321), player: { ...saveOf(321).player, rent } }
    local.setItem(STORE_KEY, JSON.stringify({ state: tampered, version: STORE_VERSION }))
    const { player } = setup(local).store().getState()
    expect(player).toEqual(fresh.player)
  })
})

describe('items in the store', () => {
  it('buy, wear, sell and gift go through the engine and persist', () => {
    const { local, store } = setup()
    const game = store()
    expect(game.getState().buyItem('cargo-pants').ok).toBe(true)
    expect(game.getState().equipItem('cargo-pants', 'bottom').ok).toBe(true)
    expect(game.getState().buyItem('bodega-flowers').ok).toBe(true)
    expect(game.getState().consumeGift('bodega-flowers', 'yourself').ok).toBe(true)
    const after = saved(local!) as { state: PersistedState }
    expect(after.state.player.cash).toBe(150 - 28 - 12)
    expect(after.state.player.inventory).toEqual({
      wearables: [{ itemId: 'cargo-pants', acquiredMinute: 480, worn: true }],
      gifts: [],
      outfit: { bottom: 'cargo-pants' },
      decor: [],
    })
    expect(game.getState().unequipSlot('bottom').ok).toBe(true)
    const sold = game.getState().sellItem('cargo-pants')
    expect(sold.ok && sold.amount).toBe(11)
    expect((saved(local!) as { state: PersistedState }).state.player.inventory.wearables).toEqual(
      [],
    )
    const reloaded = store().getState()
    expect(reloaded.player.cash).toBe(150 - 28 - 12 + 11)
  })

  it('a refused buy ($1 short) leaves state and storage untouched', () => {
    const local = new MemoryStorage()
    local.setItem(STORE_KEY, JSON.stringify({ state: saveOf(27), version: STORE_VERSION }))
    const game = setup(local).store()
    const before = game.getState()
    const written = local.getItem(STORE_KEY)
    const result = game.getState().buyItem('cargo-pants')
    expect(result.ok === false && result.error.code).toBe('INSUFFICIENT_FUNDS')
    expect(game.getState()).toBe(before)
    expect(local.getItem(STORE_KEY)).toBe(written)
  })

  it('a v3 save loads with an empty inventory and is rewritten as the current version', () => {
    const local = new MemoryStorage()
    const v3player: Record<string, unknown> = { ...saveOf(321).player, clout: 0 }
    delete v3player.inventory
    delete v3player.clubNights
    delete v3player.flex
    delete v3player.visited
    delete v3player.apartment
    delete v3player.location
    delete v3player.transit
    const v3: Record<string, unknown> = { ...fresh, player: v3player }
    delete v3.events
    delete v3.goals
    delete v3.grants
    delete v3.prestige
    delete v3.actions
    local.setItem(STORE_KEY, JSON.stringify({ state: v3, version: 3 }))
    const game = setup(local).store()
    expect(game.getState().player.cash).toBe(321)
    expect(game.getState().player.inventory).toEqual({
      wearables: [],
      gifts: [],
      outfit: {},
      decor: [],
    })
    game.getState().buyItem('subway-tote')
    expect((saved(local) as { version: number }).version).toBe(STORE_VERSION)
  })
})

describe('items in the store: guards', () => {
  /** A store loaded from a save holding a tee (worn) and one bunch of flowers. */
  function stocked() {
    const local = new MemoryStorage()
    const state: PersistedState = {
      ...fresh,
      player: {
        ...fresh.player,
        cash: 5,
        inventory: {
          wearables: [{ itemId: 'bodega-graphic-tee', acquiredMinute: 480, worn: true }],
          gifts: [{ itemId: 'bodega-flowers', count: 1 }],
          outfit: { top: 'bodega-graphic-tee' },
          decor: [],
        },
      },
    }
    local.setItem(STORE_KEY, JSON.stringify({ state, version: STORE_VERSION }))
    const game = setup(local).store()
    // The first write normalises the save; compare against what is stored after load.
    return { local, game, written: local.getItem(STORE_KEY) }
  }

  it.each([
    ['buy an unknown item', (g: ReturnType<typeof stocked>['game']) => g.getState().buyItem('x')],
    [
      'buy a second tee',
      (g: ReturnType<typeof stocked>['game']) => g.getState().buyItem('bodega-graphic-tee'),
    ],
    [
      'sell something not owned',
      (g: ReturnType<typeof stocked>['game']) => g.getState().sellItem('cargo-pants'),
    ],
    [
      'equip in the wrong slot',
      (g: ReturnType<typeof stocked>['game']) =>
        g.getState().equipItem('bodega-graphic-tee', 'face'),
    ],
    [
      'unequip an unknown slot',
      (g: ReturnType<typeof stocked>['game']) => g.getState().unequipSlot('__proto__'),
    ],
    [
      'gift a player',
      (g: ReturnType<typeof stocked>['game']) =>
        g.getState().consumeGift('bodega-flowers', { playerId: 'u-1' } as never),
    ],
    [
      'gift a wearable',
      (g: ReturnType<typeof stocked>['game']) =>
        g.getState().consumeGift('bodega-graphic-tee', 'yourself'),
    ],
  ])('a refused action (%s) changes no state and writes nothing', (_label, act) => {
    const { local, game, written } = stocked()
    const before = game.getState().player
    expect(act(game).ok).toBe(false)
    expect(game.getState().player).toBe(before)
    expect(local.getItem(STORE_KEY)).toBe(written)
  })

  it('unequipping an empty slot succeeds without a write', () => {
    const { local, game, written } = stocked()
    expect(game.getState().unequipSlot('shoes').ok).toBe(true)
    expect(local.getItem(STORE_KEY)).toBe(written)
  })

  it('selling the worn tee unequips it and persists the cash', () => {
    const { local, game } = stocked()
    const sold = game.getState().sellItem('bodega-graphic-tee')
    expect(sold.ok && sold.amount).toBe(7)
    const after = (saved(local) as { state: PersistedState }).state.player
    expect(after.cash).toBe(12)
    expect(after.inventory.outfit).toEqual({})
    expect(after.inventory.wearables).toEqual([])
  })

  it('a gift used on an NPC is consumed and persisted, with no stat change', () => {
    const { local, game } = stocked()
    const stats = game.getState().player.stats
    const npc = toNpcId('npc-promoter')
    if (npc === null) throw new Error('npc id')
    expect(game.getState().consumeGift('bodega-flowers', { npcId: npc }).ok).toBe(true)
    const after = (saved(local) as { state: PersistedState }).state.player
    expect(after.inventory.gifts).toEqual([])
    expect(after.stats).toEqual(stats)
  })

  it('a newer-build save stays byte-identical through buying, wearing, selling and gifting', () => {
    const local = new MemoryStorage()
    const newer = JSON.stringify({ state: saveOf(5000), version: STORE_VERSION + 1 })
    local.setItem(STORE_KEY, newer)
    const game = setup(local).store()
    expect(game.getState().buyItem('cargo-pants').ok).toBe(true)
    expect(game.getState().equipItem('cargo-pants', 'bottom').ok).toBe(true)
    expect(game.getState().buyItem('bodega-flowers').ok).toBe(true)
    expect(game.getState().consumeGift('bodega-flowers', 'yourself').ok).toBe(true)
    expect(game.getState().sellItem('cargo-pants').ok).toBe(true)
    expect(local.getItem(STORE_KEY)).toBe(newer)
  })
})

describe('events in the store', () => {
  const bodega: EventContext = {
    borough: 'queens',
    locationId: null,
    locationCategory: 'bodega',
    itemIds: [],
  }

  it('opens an event, resolves a choice through the engine and shows its outcome', () => {
    const { local, store } = setup()
    const game = store()
    expect(game.getState().openEvent('bodega-cat', bodega).ok).toBe(true)
    expect(game.getState().events.active).toBe('bodega-cat')
    expect((saved(local!) as { state: PersistedState }).state.events.active).toBe('bodega-cat')

    const result = game.getState().chooseEventOption('treat')
    expect(result.ok).toBe(true)
    const state = game.getState()
    expect(state.player.cash).toBe(148)
    expect(state.player.stats.mood).toBe(80)
    expect(state.clock.minute).toBe(485)
    expect(state.events.active).toBeNull()
    expect(state.eventOutcome).toMatchObject({ eventId: 'bodega-cat', choiceId: 'treat' })
    expect((saved(local!) as { state: PersistedState }).state.player.cash).toBe(148)

    game.getState().dismissEventOutcome()
    expect(game.getState().eventOutcome).toBeNull()
  })

  it('refuses an event at a memorial and leaves state alone', () => {
    const { store } = setup()
    const game = store()
    const before = game.getState()
    const memorial = { ...bodega, locationId: 'a-memorial', locationCategory: 'memorial' as const }
    expect(game.getState().openEvent('bodega-cat', memorial)).toEqual({
      ok: false,
      error: { code: 'EVENT_NOT_ELIGIBLE', eventId: 'bodega-cat' },
    })
    expect(game.getState()).toBe(before)
  })

  it('a failed choice changes nothing', () => {
    const { store } = setup()
    const game = store()
    game.getState().openEvent('bodega-cat', bodega)
    const before = game.getState()
    expect(game.getState().chooseEventOption('dance').ok).toBe(false)
    expect(game.getState()).toBe(before)
  })

  it('an open event survives a reload; the outcome screen does not', () => {
    const local = new MemoryStorage()
    const first = setup(local).store()
    first.getState().openEvent('bodega-cat', bodega)
    const reloaded = setup(local).store()
    expect(reloaded.getState().events.active).toBe('bodega-cat')
    reloaded.getState().chooseEventOption('scratch')
    expect(setup(local).store().getState().eventOutcome).toBeNull()
  })

  it('a roll saves the advanced generator, so a reload cannot re-roll', () => {
    const local = new MemoryStorage()
    const game = setup(local).store()
    const before = game.getState().events.rngState
    game.getState().rollForEvent(bodega)
    const after = game.getState().events.rngState
    expect(after).not.toBe(before)
    expect((saved(local) as { state: PersistedState }).state.events.rngState).toBe(after)
  })

  // BUG-1: rent that falls due while an event is open must still reach the rent notice.
  describe('rent during an event', () => {
    const DAY = minutesPerDay(engineConfig)

    /** A broke store a few minutes before the midnight that opens the next rent day. */
    function brokeBeforeRentDay(minutesBefore: number) {
      const game = setup().store()
      const { clock, player } = game.getState()
      const due = nextRentDueDay(clock.minute, engineConfig)
      game.setState({
        clock: { ...clock, minute: (due - 1) * DAY - minutesBefore },
        player: { ...player, cash: 0 },
      })
      return { game, due }
    }

    it('a choice whose time crosses a rent day records the rent event', () => {
      const { game, due } = brokeBeforeRentDay(1)
      expect(game.getState().openEvent('bodega-cat', bodega).ok).toBe(true)
      const result = game.getState().chooseEventOption('scratch')
      if (!result.ok) throw new Error(`refused: ${result.error.code}`)
      expect(result.rent.map((event) => event.kind)).toEqual(['missed'])
      expect(game.getState().lastRentEvent).toMatchObject({ kind: 'missed', day: due })
      expect(game.getState().lastRentEvent).toBe(result.rent.at(-1))
      expect(game.getState().player.rent.missed).toBe(1)
    })

    it('a choice that crosses no rent day keeps the earlier notice', () => {
      const { game } = brokeBeforeRentDay(1)
      game.getState().advanceMinutes(1)
      const earlier = game.getState().lastRentEvent
      expect(earlier).not.toBeNull()
      expect(game.getState().openEvent('bodega-cat', bodega).ok).toBe(true)
      const result = game.getState().chooseEventOption('scratch')
      expect(result.ok && result.rent).toEqual([])
      expect(game.getState().lastRentEvent).toBe(earlier)
    })

    it('the clock ticking past a rent day while an event is open records the rent event', () => {
      const { game, due } = brokeBeforeRentDay(1)
      expect(game.getState().openEvent('bodega-cat', bodega).ok).toBe(true)
      // Capped real-time ticks until the clock passes the midnight that opens the rent day.
      const midnight = (due - 1) * DAY
      for (let guard = 0; game.getState().clock.minute <= midnight && guard < 100; guard += 1) {
        game.getState().tick(engineConfig.time.maxTickRealMs, true)
      }
      expect(game.getState().clock.minute).toBeGreaterThan(midnight)
      expect(game.getState().events.active).toBe('bodega-cat')
      expect(game.getState().lastRentEvent).toMatchObject({ kind: 'missed', day: due })
    })
  })
})

describe('level-ups in the store', () => {
  it('a level-up from an action is kept for the toast until dismissed, and never saved', () => {
    const local = new MemoryStorage()
    const game = setup(local).store()
    const nearLocal = playerWithClout(game.getState().player, 99, engineConfig)
    game.setState({ player: nearLocal })
    expect(game.getState().lastLevelUp).toBeNull()
    const shift = game.getState().workShift('barista')
    expect(shift.ok && shift.levelUp).toMatchObject({ to: 'local', source: 'paycheck' })
    expect(game.getState().lastLevelUp).toMatchObject({ to: 'local' })
    const written = JSON.parse(local.getItem(STORE_KEY) ?? '{}') as { state: object }
    expect(written.state).not.toHaveProperty('lastLevelUp')
    // A later action with no level-up leaves the toast as it is.
    game.getState().performAction('nap')
    expect(game.getState().lastLevelUp).toMatchObject({ to: 'local' })
    game.getState().dismissLevelUp()
    expect(game.getState().lastLevelUp).toBeNull()
    expect(setup(local).store().getState().lastLevelUp).toBeNull()
  })
})

describe('the action count (S18c)', () => {
  it('counts each state-changing tap, not passive time or a refused action', () => {
    const game = setup().store()
    expect(game.getState().actions).toBe(0)
    game.getState().performAction('bodega-breakfast')
    expect(game.getState().actions).toBe(1)
    game.getState().tick(60_000, true)
    expect(game.getState().actions).toBe(1)
    game.getState().performAction('no-such-action')
    expect(game.getState().actions).toBe(1)
  })
})
