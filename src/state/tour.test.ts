import { describe, expect, it } from 'vitest'
import { engineConfig } from '@/engine/config'
import { initialSave } from '@/engine/save'
import { createLogger, type LogRecord } from '@/lib/log'
import { TOUR_KEY as SEED_KEY, doneTourSeed } from '../../tests/e2e/fixtures/tour-seed'
import { createSafeJsonStorage } from './storage'
import {
  PersistedTourSchema,
  TOUR_KEY,
  TOUR_STEPS,
  TOUR_VERSION,
  createTourStore,
  isFreshStart,
  nextTourRecord,
  type PersistedTour,
  type TourEvent,
  type TourRecord,
  type TourStep,
  type TourUi,
} from './tour'

const TARGET = { placeId: 'late-lantern-deli', actionId: 'bodega-breakfast' }
const CLOSED: TourUi = { panelShown: false, openPlaceId: null }
const PANEL: TourUi = { panelShown: true, openPlaceId: null }
const DELI: TourUi = { panelShown: false, openPlaceId: TARGET.placeId }
const OTHER: TourUi = { panelShown: false, openPlaceId: 'steam-vent-coffee' }

const at = (step: TourStep): TourRecord => ({
  status: 'active',
  step,
  receipt: null,
})
const run = (record: TourRecord, ...events: TourEvent[]) =>
  events.reduce((current, event) => nextTourRecord(current, event, TARGET), record)
const purchase = (placeId = TARGET.placeId, actionId = TARGET.actionId): TourEvent => ({
  type: 'purchased',
  done: { placeId, actionId, cashBefore: 150, cashAfter: 140 },
})

describe('tour steps (S06)', () => {
  it('has at most six steps', () => {
    expect(TOUR_STEPS.length).toBeLessThanOrEqual(6)
  })

  it('walks the guided purchase: HUD, Places, the place, its action, the cash, done', () => {
    let record = at('hud')
    record = run(record, { type: 'next', ui: CLOSED })
    expect(record).toEqual(at('find'))
    record = run(record, { type: 'ui', ui: PANEL })
    expect(record).toEqual(at('pick'))
    record = run(record, { type: 'ui', ui: DELI })
    expect(record).toEqual(at('buy'))
    record = run(record, purchase())
    expect(record).toEqual({ status: 'active', step: 'cash', receipt: { before: 150, after: 140 } })
    record = run(record, { type: 'next', ui: DELI })
    expect(record).toEqual(at('done'))
    expect(run(record, { type: 'next', ui: CLOSED })).toEqual({ status: 'done' })
  })

  it('a tap on the place pin jumps straight to the purchase step', () => {
    for (const step of ['hud', 'find', 'pick'] as const) {
      expect(run(at(step), { type: 'ui', ui: DELI })).toEqual(at('buy'))
    }
  })

  it('Next from the HUD step lands on the step that fits the screen', () => {
    expect(run(at('hud'), { type: 'next', ui: PANEL })).toEqual(at('pick'))
    expect(run(at('hud'), { type: 'next', ui: DELI })).toEqual(at('buy'))
  })

  it('steps back when the player leaves the way: panel closed, another place, sheet closed', () => {
    expect(run(at('pick'), { type: 'ui', ui: CLOSED })).toEqual(at('find'))
    expect(run(at('pick'), { type: 'ui', ui: OTHER })).toEqual(at('find'))
    expect(run(at('buy'), { type: 'ui', ui: CLOSED })).toEqual(at('find'))
    expect(run(at('buy'), { type: 'ui', ui: PANEL })).toEqual(at('pick'))
  })

  it('never moves on a step that waits for Next, and keeps the same record when nothing changes', () => {
    const hud = at('hud')
    expect(run(hud, { type: 'ui', ui: PANEL })).toBe(hud)
    const cash = run(at('buy'), purchase())
    expect(run(cash, { type: 'ui', ui: CLOSED })).toBe(cash)
    const done = at('done')
    expect(run(done, { type: 'ui', ui: PANEL })).toBe(done)
    const find = at('find')
    expect(run(find, { type: 'ui', ui: CLOSED })).toBe(find)
  })

  it('only the target action at the target place counts as the purchase, and only on the way', () => {
    expect(run(at('buy'), purchase('steam-vent-coffee', 'coffee'))).toEqual(at('buy'))
    expect(run(at('buy'), purchase(TARGET.placeId, 'deli-coffee'))).toEqual(at('buy'))
    // Bought before reaching the step (a pin tap, then the action): still the guided purchase.
    expect(run(at('find'), purchase()).status).toBe('active')
    expect(run(at('find'), purchase())).toMatchObject({ step: 'cash' })
    // A second purchase on the cash step does not rewrite the receipt.
    const cash = run(at('buy'), purchase())
    expect(run(cash, purchase())).toBe(cash)
  })

  it('Next does nothing on the way steps', () => {
    for (const step of ['find', 'pick', 'buy'] as const) {
      expect(run(at(step), { type: 'next', ui: CLOSED })).toEqual(at(step))
    }
  })

  it('skips from any step and resumes there from Help, on the way step that fits the screen', () => {
    for (const step of ['hud', 'find', 'pick', 'buy'] as const) {
      const skipped = run(at(step), { type: 'skip' })
      expect(skipped).toEqual({ status: 'skipped', step })
      const resumed = run(skipped, { type: 'resume', ui: CLOSED })
      expect(resumed).toEqual(at(step === 'hud' ? 'hud' : 'find'))
    }
    expect(run({ status: 'skipped', step: 'pick' }, { type: 'resume', ui: PANEL })).toEqual(
      at('pick'),
    )
  })

  it('replays from the start after the purchase or when done; Help on an active tour keeps it', () => {
    expect(run({ status: 'skipped', step: 'cash' }, { type: 'resume', ui: CLOSED })).toEqual(
      at('hud'),
    )
    expect(run({ status: 'skipped', step: 'done' }, { type: 'resume', ui: CLOSED })).toEqual(
      at('hud'),
    )
    expect(run({ status: 'done' }, { type: 'resume', ui: CLOSED })).toEqual(at('hud'))
    const find = at('find')
    expect(run(find, { type: 'resume', ui: CLOSED })).toBe(find)
  })

  it('a skipped or finished tour ignores everything but Help', () => {
    for (const record of [{ status: 'skipped', step: 'find' }, { status: 'done' }] as const) {
      for (const event of [
        { type: 'next', ui: PANEL },
        { type: 'ui', ui: DELI },
        purchase(),
        { type: 'skip' },
      ] as const satisfies readonly TourEvent[]) {
        expect(run(record, event)).toBe(record)
      }
    }
  })
})

describe('isFreshStart', () => {
  const tour = { freshStartMaxGameMinutes: 1440 }
  const fresh = initialSave(engineConfig)

  it('is true for a new game', () => {
    expect(isFreshStart(fresh, engineConfig, tour)).toBe(true)
  })

  it('stays true through the first game day of idling', () => {
    const clock = { ...fresh.clock, minute: fresh.clock.minute + 1440 }
    expect(isFreshStart({ ...fresh, clock }, engineConfig, tour)).toBe(true)
    const later = { ...fresh.clock, minute: fresh.clock.minute + 1441 }
    expect(isFreshStart({ ...fresh, clock: later }, engineConfig, tour)).toBe(false)
  })

  it('is false once anything was spent, earned, bought, visited or prestiged', () => {
    const { player } = fresh
    const played = [
      { ...fresh, player: { ...player, cash: player.cash - 10 } },
      {
        ...fresh,
        player: { ...player, clout: { ...player.clout, compacted: { entries: 1, bySource: {} } } },
      },
      {
        ...fresh,
        // Only the count matters here, not what the gift is.
        player: { ...player, inventory: { ...player.inventory, gifts: [{} as never] } },
      },
      { ...fresh, player: { ...player, visited: { 'brooklyn-bridge': 600 } } },
      { ...fresh, prestige: { ...fresh.prestige, count: 1 } },
    ]
    for (const save of played) {
      expect(isFreshStart(save as typeof fresh, engineConfig, tour)).toBe(false)
    }
  })
})

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

function setup(local: Storage = new MemoryStorage()) {
  const records: LogRecord[] = []
  const logger = createLogger({ level: 'debug', sink: (record) => records.push(record) })
  const storage = createSafeJsonStorage<PersistedTour>(() => local, logger)
  return { local, records, store: () => createTourStore(storage, logger) }
}

const stored = (local: Storage) => JSON.parse(local.getItem(TOUR_KEY) ?? 'null') as unknown

describe('tour store', () => {
  it('starts undecided; a fresh game starts the tour, a veteran is marked done unseen', () => {
    const fresh = setup()
    const store = fresh.store()
    expect(store.getState().record).toBeNull()
    store.getState().begin(true)
    expect(store.getState().record).toEqual(at('hud'))
    expect(stored(fresh.local)).toEqual({ state: { record: at('hud') }, version: TOUR_VERSION })

    const veteran = setup().store()
    veteran.getState().begin(false)
    expect(veteran.getState().record).toEqual({ status: 'done' })
  })

  it('decides only once per device: a reload keeps the step, a new game never restarts it', () => {
    const { local, store } = setup()
    const first = store()
    first.getState().begin(true)
    first.getState().dispatch({ type: 'next', ui: CLOSED }, TARGET)
    const second = setup(local).store()
    expect(second.getState().record).toEqual(at('find'))
    second.getState().begin(true)
    expect(second.getState().record).toEqual(at('find'))
    second.getState().dispatch({ type: 'skip' }, TARGET)
    const third = setup(local).store()
    third.getState().begin(true)
    expect(third.getState().record).toEqual({ status: 'skipped', step: 'find' })
  })

  it('Help before the first tour was decided plays it from the start', () => {
    const store = setup().store()
    store.getState().dispatch({ type: 'next', ui: CLOSED }, TARGET)
    expect(store.getState().record).toBeNull()
    store.getState().dispatch({ type: 'resume', ui: CLOSED }, TARGET)
    expect(store.getState().record).toEqual(at('hud'))
  })

  it('ignores stored progress that fails validation, and logs at info', () => {
    const local = new MemoryStorage()
    local.setItem(
      TOUR_KEY,
      JSON.stringify({ state: { record: { status: 'active', step: 'nap' } }, version: 1 }),
    )
    const { store, records } = setup(local)
    expect(store().getState().record).toBeNull()
    expect(records.map((record) => record.level)).not.toContain('warn')
    expect(records.some((record) => record.msg.includes('tour progress'))).toBe(true)
  })

  it('never overwrites progress saved by a newer build', () => {
    const local = new MemoryStorage()
    const newer = JSON.stringify({ state: { record: { status: 'done' } }, version: 2 })
    local.setItem(TOUR_KEY, newer)
    const store = setup(local).store()
    expect(store.getState().record).toEqual({ status: 'done' })
    store.getState().dispatch({ type: 'resume', ui: CLOSED }, TARGET)
    expect(store.getState().record).toEqual(at('hud'))
    expect(local.getItem(TOUR_KEY)).toBe(newer)
  })

  it('the e2e "done" seed is a valid stored tour under the same key', () => {
    expect(SEED_KEY).toBe(TOUR_KEY)
    const seed = doneTourSeed()
    expect(seed.version).toBe(TOUR_VERSION)
    expect(PersistedTourSchema.safeParse(seed.state).success).toBe(true)
  })
})
