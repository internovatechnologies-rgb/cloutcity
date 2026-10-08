/** S15 in the store: goals sync after actions, claims persist, the Icon moment and prestige. */
import { describe, expect, it } from 'vitest'
import { playerLevel } from '@/engine/clout'
import { engineConfig } from '@/engine/config'
import type { EventContext } from '@/engine/events'
import { goalClout, goalsView } from '@/engine/goals'
import { createRng } from '@/engine/rng'
import { playerWithClout } from '@/engine/test-support'
import { createLogger, type LogRecord } from '@/lib/log'
import { findPlace } from '@/lib/world/places'
import { createSafeJsonStorage } from './storage'
import {
  STORE_KEY,
  STORE_VERSION,
  createGameStore,
  initialPersistedState,
  type PersistedState,
} from './store'
import type { Place } from '@/engine/places'
import type { GameStore } from './store'

/** The store's state after the player walks into `place` (DEC-22: its actions need them there). */
function standingAt(game: GameStore, place: Place) {
  const { player } = game.getState()
  const { location } = player
  if (location.kind !== 'place' || location.placeId !== place.id) {
    game.setState({ player: { ...player, location: { kind: 'place', placeId: place.id } } })
  }
  return game.getState()
}

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
  const storage = createSafeJsonStorage<PersistedState>(() => local, logger)
  return { local, records, store: () => createGameStore(storage, logger) }
}

const saved = (local: Storage) =>
  JSON.parse(local.getItem(STORE_KEY) ?? 'null') as { state: PersistedState; version: number }

/** A save holding `clout` earned clout, written as the current version. */
function seed(local: Storage, clout: number, patch: Partial<PersistedState> = {}) {
  const fresh = initialPersistedState()
  const state = { ...fresh, player: playerWithClout(fresh.player, clout, engineConfig), ...patch }
  local.setItem(STORE_KEY, JSON.stringify({ state, version: STORE_VERSION }))
}

const ballpark = (() => {
  const found = findPlace('queens-ballpark')
  if (found === undefined) throw new Error('no queens-ballpark')
  return found
})()

describe('goals sync after state-changing actions', () => {
  it('a shift reaches the first paycheck goal; the Goals count follows', () => {
    const game = setup().store()
    expect(game.getState().goals.achieved).toEqual({})
    expect(game.getState().workShift('barista').ok).toBe(true)
    expect(Object.keys(game.getState().goals.achieved)).toEqual(['first-paycheck'])
  })

  it('a landmark visit reaches the first landmark visit goal', () => {
    const game = setup().store()
    const result = standingAt(game, ballpark).performPlaceAction(ballpark, 'visit')
    if (!result.ok) throw new Error(result.error.code)
    expect(game.getState().player.visited).toEqual({
      'queens-ballpark': game.getState().clock.minute,
    })
    expect(game.getState().goals.achieved['first-landmark-visit']).toBe(
      game.getState().clock.minute,
    )
  })

  it('passive time alone never syncs goals', () => {
    const local = new MemoryStorage()
    seed(local, 150)
    const game = setup(local).store()
    game.getState().tick(60_000, true)
    game.getState().advanceMinutes(30)
    expect(game.getState().goals.achieved).toEqual({})
    game.getState().performAction('bodega-breakfast')
    expect(Object.keys(game.getState().goals.achieved)).toEqual(['reach-local'])
  })
})

describe('claiming a reward', () => {
  it('pays the capped preview once, and the claim persists across a reload', () => {
    const local = new MemoryStorage()
    const game = setup(local).store()
    game.getState().workShift('barista')
    const cash = game.getState().player.cash
    const result = game.getState().claimGoalReward('first-paycheck')
    if (!result.ok) throw new Error(result.error.code)
    expect(result.replayed).toBe(false)
    expect(game.getState().player.cash).toBe(cash + result.record.applied.cash)
    expect(result.record.issuedAtMs).toBeGreaterThan(0)
    expect(saved(local).state.grants.log).toEqual([result.record])

    const reloaded = setup(local).store()
    expect(reloaded.getState().grants.log).toEqual([result.record])
    const again = reloaded.getState().claimGoalReward('first-paycheck')
    expect(again.ok && again.replayed).toBe(true)
    expect(reloaded.getState().player.cash).toBe(cash + result.record.applied.cash)
  })

  it('refuses an unreached or unknown goal and changes nothing', () => {
    const game = setup().store()
    const before = game.getState()
    expect(game.getState().claimGoalReward('reach-local')).toEqual({
      ok: false,
      error: { code: 'INELIGIBLE', reason: 'not-achieved' },
    })
    expect(game.getState().claimGoalReward('made-up')).toEqual({
      ok: false,
      error: { code: 'INELIGIBLE', reason: 'unknown-goal' },
    })
    expect(game.getState()).toBe(before)
  })
})

describe('the Icon moment and prestige', () => {
  function atIconEdge() {
    const local = new MemoryStorage()
    seed(local, 4999)
    const game = setup(local).store()
    const flexed = standingAt(game, ballpark).performPlaceAction(ballpark, 'flex')
    if (!flexed.ok) throw new Error(flexed.error.code)
    return { local, game }
  }

  it('reaching Icon starts the moment and shows no level-up toast for it', () => {
    const { game } = atIconEdge()
    const { goals, lastLevelUp } = game.getState()
    expect(goals.achieved['reach-icon']).toBe(game.getState().clock.minute)
    expect(goals.icon).toEqual({ reachedAt: game.getState().clock.minute, acknowledged: false })
    expect(lastLevelUp).toBeNull()
  })

  it('Keep playing acknowledges it for good (persisted)', () => {
    const { local, game } = atIconEdge()
    game.getState().acknowledgeIconMoment()
    expect(game.getState().goals.icon.acknowledged).toBe(true)
    expect(setup(local).store().getState().goals.icon.acknowledged).toBe(true)
  })

  it('prestige starts the next run at Nobody with the badge, and persists', () => {
    const { local, game } = atIconEdge()
    const result = game.getState().startPrestige()
    if (!result.ok) throw new Error(result.error.code)
    const state = game.getState()
    expect(state.goals.run).toBe(2)
    expect(state.goals.icon.reachedAt).toBeNull()
    expect(state.player.cash).toBe(engineConfig.startCash)
    expect(state.prestige.badges).toEqual(['prestige-1'])
    expect(state.lastLevelUp).toBeNull()
    const reloaded = setup(local).store().getState()
    expect(reloaded.prestige).toEqual(state.prestige)
    expect(reloaded.goals.run).toBe(2)
  })

  it('prestige is refused before Icon', () => {
    const game = setup().store()
    expect(game.getState().startPrestige()).toEqual({ ok: false, error: { code: 'NOT_YET' } })
  })

  it('discarding a newer save starts the goals, grants and prestige fresh too', () => {
    const { game } = atIconEdge()
    game.getState().startPrestige()
    game.getState().discardNewerSaveAndStartFresh()
    const { goals, grants, prestige } = game.getState()
    const fresh = initialPersistedState()
    expect({ goals, grants, prestige }).toEqual({
      goals: fresh.goals,
      grants: fresh.grants,
      prestige: fresh.prestige,
    })
  })
})

describe('claims racing events, and random interleavings (ECON-1)', () => {
  const bodega: EventContext = {
    borough: 'queens',
    locationId: null,
    locationCategory: 'bodega',
    itemIds: [],
  }

  it('a claim while an event is open is refused and changes nothing; it pays once it closes', () => {
    const game = setup().store()
    expect(game.getState().workShift('barista').ok).toBe(true)
    expect(game.getState().openEvent('bodega-cat', bodega).ok).toBe(true)
    const before = game.getState()
    expect(game.getState().claimGoalReward('first-paycheck')).toEqual({
      ok: false,
      error: { code: 'INELIGIBLE', reason: 'event-open' },
    })
    expect(game.getState()).toBe(before)
    expect(game.getState().chooseEventOption('treat').ok).toBe(true)
    const cash = game.getState().player.cash
    const paid = game.getState().claimGoalReward('first-paycheck')
    if (!paid.ok) throw new Error(paid.error.code)
    expect(game.getState().player.cash).toBe(cash + paid.record.applied.cash)
    // A repeat claim racing another event opening replays: nothing more is paid.
    game.setState({ events: { ...game.getState().events, active: 'bodega-cat' } })
    const again = game.getState().claimGoalReward('first-paycheck')
    expect(again.ok && again.replayed).toBe(true)
    expect(game.getState().player.cash).toBe(cash + paid.record.applied.cash)
  })

  it('400 random actions and claims: a claim never moves goals, goal clout or the level; it pays its preview', () => {
    const local = new MemoryStorage()
    seed(local, 60)
    const game = setup(local).store()
    const rng = createRng(0x15c)
    const goalIds = engineConfig.goals.map((goal) => goal.id)
    let claims = 0
    for (let i = 0; i < 400; i++) {
      const roll = rng.next()
      const state = game.getState()
      if (roll < 0.25) {
        state.workShift('barista')
      } else if (roll < 0.4) {
        state.performAction('bodega-breakfast')
      } else if (roll < 0.5) {
        standingAt(game, ballpark).performPlaceAction(ballpark, rng.next() < 0.5 ? 'visit' : 'flex')
      } else if (roll < 0.55) {
        if (state.events.active === null) state.openEvent('bodega-cat', bodega)
        else state.chooseEventOption('treat')
      } else if (roll < 0.6) {
        state.advanceMinutes(Math.floor(rng.next() * 600))
      } else {
        const goalId = goalIds[Math.floor(rng.next() * goalIds.length)] ?? ''
        const view = goalsView(state, engineConfig).find((entry) => entry.id === goalId)
        const before = {
          goals: state.goals,
          goalClout: goalClout(state.player, engineConfig),
          level: playerLevel(state.player, engineConfig).id,
          cash: state.player.cash,
        }
        const result = state.claimGoalReward(goalId)
        const after = game.getState()
        expect(after.goals).toBe(before.goals)
        expect(goalClout(after.player, engineConfig)).toBe(before.goalClout)
        expect(playerLevel(after.player, engineConfig).id).toBe(before.level)
        if (result.ok && !result.replayed) {
          claims += 1
          expect(view?.claimable).toBe(true)
          expect(result.record.applied).toEqual(view?.reward.preview)
          expect(after.player.cash).toBe(before.cash + result.record.applied.cash)
        } else {
          expect(view?.claimable ?? false).toBe(false)
          expect(after.player.cash).toBe(before.cash)
        }
      }
    }
    expect(claims).toBeGreaterThanOrEqual(2)
  })
})

describe('Icon is earned, in the store (S15 fix cycle 1)', () => {
  it('granted clout past the Icon threshold shows Famous with no toast and no moment; earning the rest brings both', () => {
    const local = new MemoryStorage()
    const fresh = initialPersistedState()
    const earned = playerWithClout(fresh.player, 4890, engineConfig)
    const clout = {
      ...earned.clout,
      ledger: [
        {
          seq: 1,
          at: fresh.clock.minute,
          amount: 110,
          currency: 'cash' as const,
          source: 'grant' as const,
          ref: { grantKey: 'goal:reach-famous:r1' },
        },
      ],
      nextSeq: 2,
    }
    seed(local, 0, { player: { ...earned, clout } })
    const game = setup(local).store()
    game.getState().performAction('bodega-breakfast')
    expect(playerLevel(game.getState().player, engineConfig).id).toBe('famous')
    expect(game.getState().goals.icon.reachedAt).toBeNull()
    expect(game.getState().lastLevelUp).toBeNull()

    // 110 more earned clout: the Icon level and the Icon moment arrive together; the moment
    // replaces the Icon toast.
    for (let i = 0; i < 30 && goalClout(game.getState().player, engineConfig) < 5000; i++) {
      const place = findPlace(['queens-ballpark', 'flushing-meadows', 'astoria-park'][i % 3] ?? '')
      if (place === undefined) throw new Error('no place')
      game.getState().advanceMinutes(24 * 60)
      const { player } = game.getState()
      game.setState({ player: { ...player, stats: { energy: 100, hunger: 80, mood: 80 } } })
      const flexed = standingAt(game, place).performPlaceAction(place, 'flex')
      if (!flexed.ok) throw new Error(JSON.stringify(flexed.error))
    }
    expect(goalClout(game.getState().player, engineConfig)).toBeGreaterThanOrEqual(5000)
    expect(playerLevel(game.getState().player, engineConfig).id).toBe('icon')
    expect(game.getState().goals.icon.reachedAt).not.toBeNull()
    expect(game.getState().lastLevelUp).toBeNull()
  })
})
