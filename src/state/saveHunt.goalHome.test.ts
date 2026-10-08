/**
 * Slice-end bug hunt, H-2: a level goal reached partly on home clout, its reward claimed, then the
 * home clout lost before the next upload (a move to a cheaper home, decor taken down): honest, so
 * accepted. Also the icon-policy fuzz seed that first found it.
 */
import { expect, it } from 'vitest'
import { engineConfig as config } from '@/engine/config'
import { goalClout } from '@/engine/clout'
import { grant } from '@/engine/grants'
import { placeActions } from '@/engine/placeActions'
import { checkUpload } from '@/engine/plausibility'
import { initialSave, SAVE_VERSION, type SaveState } from '@/engine/save'
import { createLogger } from '@/lib/log'
import { ceilings, MemoryStorage, places } from '@/lib/testing/saveHunt'
import { createSafeJsonStorage } from './storage'
import { createGameStore, persistedOf, type PersistedState } from './store'

it('H-2 moving to a cheaper home after claiming a level goal is not rejected', () => {
  const quiet = createLogger({ level: 'error', sink: () => {} })
  const store = createGameStore(
    createSafeJsonStorage<PersistedState>(() => new MemoryStorage(), quiet),
    quiet,
  )
  const s = () => store.getState()
  const fresh = initialSave(config)
  // Accepted save: 72 flex clout, living in Brooklyn (home clout 10): goal clout 97.
  const prev: SaveState = {
    ...fresh,
    clock: { minute: 2 * 1440 + 14 * 60, remainderMs: 0 },
    player: {
      ...fresh.player,
      cash: 700,
      home: 'brooklyn-1br',
      location: { kind: 'place', placeId: 'queensboro-bridge' },
      clout: {
        ...fresh.player.clout,
        compacted: { entries: 18, bySource: { flex: 87 } },
        nextSeq: 19,
        firstPaycheckPaid: true,
      },
    },
    goals: { ...fresh.goals, achieved: { 'first-paycheck': 100 } },
    actions: 40,
  }
  // It was accepted (first upload).
  const first = checkUpload(
    null,
    prev,
    {
      realMinutesSinceAccept: 0,
      burstCreditMinutes: 0,
      accountAgeMinutes: 60,
      serverGrantKeys: [],
      entitledItemIds: [],
      firstUpload: true,
    },
    ceilings,
    config,
  )
  expect(first.outcome).not.toBe('reject')
  expect(s().adoptCloudSave(JSON.parse(JSON.stringify(first.save)), SAVE_VERSION)).toBe(true)
  expect(goalClout(s().player, config)).toBe(97)

  const bridge = places.find((p) => p.id === 'queensboro-bridge')!
  const view = placeActions(bridge, s(), config)
  const flex = view.kind === 'actions' ? view.actions.find((a) => a.kind === 'flex')! : undefined
  expect(s().performPlaceAction(bridge, flex!.id).ok).toBe(true)
  expect(s().goals.achieved['reach-local']).toBeDefined()
  expect(s().claimGoalReward('reach-local').ok).toBe(true)
  expect(s().moveHome('queens-room').ok).toBe(true) // downsizing: home clout 10 -> 0

  const verdict = checkUpload(
    first.save,
    JSON.parse(JSON.stringify(persistedOf(s()))),
    {
      realMinutesSinceAccept: 1,
      burstCreditMinutes: 5,
      accountAgeMinutes: 61,
      serverGrantKeys: [],
      entitledItemIds: [],
      firstUpload: false,
    },
    ceilings,
    config,
  )
  expect(verdict.outcome).not.toBe('reject')
})

it('H-2b taking decor down after claiming a level goal it helped reach is not rejected', () => {
  const quiet = createLogger({ level: 'error', sink: () => {} })
  const store = createGameStore(
    createSafeJsonStorage<PersistedState>(() => new MemoryStorage(), quiet),
    quiet,
  )
  const s = () => store.getState()
  const fresh = initialSave(config)
  // Accepted save: 92 flex clout in the start home (home clout 0).
  const prev: SaveState = {
    ...fresh,
    clock: { minute: 2 * 1440 + 14 * 60, remainderMs: 0 },
    player: {
      ...fresh.player,
      cash: 200,
      clout: {
        ...fresh.player.clout,
        compacted: { entries: 23, bySource: { flex: 92 } },
        nextSeq: 24,
        firstPaycheckPaid: true,
      },
    },
    goals: { ...fresh.goals, achieved: { 'first-paycheck': 100 } },
    actions: 40,
  }
  const first = checkUpload(
    null,
    prev,
    {
      realMinutesSinceAccept: 0,
      burstCreditMinutes: 0,
      accountAgeMinutes: 60,
      serverGrantKeys: [],
      entitledItemIds: [],
      firstUpload: true,
    },
    ceilings,
    config,
  )
  expect(first.outcome).not.toBe('reject')
  expect(s().adoptCloudSave(JSON.parse(JSON.stringify(first.save)), SAVE_VERSION)).toBe(true)
  expect(s().buyItem('thrift-flatweave-rug').ok).toBe(true)
  expect(s().placeDecor('thrift-flatweave-rug', 'floor-1').ok).toBe(true) // home clout 0 -> 8: goal clout 100
  expect(s().goals.achieved['reach-local']).toBeDefined()
  expect(s().claimGoalReward('reach-local').ok).toBe(true)
  expect(s().removeDecor('floor-1').ok).toBe(true) // back to storage
  const verdict = checkUpload(
    first.save,
    JSON.parse(JSON.stringify(persistedOf(s()))),
    {
      realMinutesSinceAccept: 1,
      burstCreditMinutes: 5,
      accountAgeMinutes: 61,
      serverGrantKeys: [],
      entitledItemIds: [],
      firstUpload: false,
    },
    ceilings,
    config,
  )
  expect(verdict.outcome).not.toBe('reject')
})

it('H-2c decor bought, placed, claimed against and sold within one upload window is not rejected', () => {
  const quiet = createLogger({ level: 'error', sink: () => {} })
  const store = createGameStore(
    createSafeJsonStorage<PersistedState>(() => new MemoryStorage(), quiet),
    quiet,
  )
  const s = () => store.getState()
  const fresh = initialSave(config)
  // Accepted save: 92 flex clout in the start home (home clout 0), no decor at all.
  const prev: SaveState = {
    ...fresh,
    clock: { minute: 2 * 1440 + 14 * 60, remainderMs: 0 },
    player: {
      ...fresh.player,
      cash: 200,
      clout: {
        ...fresh.player.clout,
        compacted: { entries: 23, bySource: { flex: 92 } },
        nextSeq: 24,
        firstPaycheckPaid: true,
      },
    },
    goals: { ...fresh.goals, achieved: { 'first-paycheck': 100 } },
    actions: 40,
  }
  const first = checkUpload(
    null,
    prev,
    {
      realMinutesSinceAccept: 0,
      burstCreditMinutes: 0,
      accountAgeMinutes: 60,
      serverGrantKeys: [],
      entitledItemIds: [],
      firstUpload: true,
    },
    ceilings,
    config,
  )
  expect(first.outcome).not.toBe('reject')
  expect(s().adoptCloudSave(JSON.parse(JSON.stringify(first.save)), SAVE_VERSION)).toBe(true)
  // All within one window: buy, place (home clout 0 -> 8, goal clout 100), claim, sell.
  expect(s().buyItem('thrift-flatweave-rug').ok).toBe(true)
  expect(s().placeDecor('thrift-flatweave-rug', 'floor-1').ok).toBe(true)
  expect(s().goals.achieved['reach-local']).toBeDefined()
  expect(s().claimGoalReward('reach-local').ok).toBe(true)
  expect(s().sellItem('thrift-flatweave-rug').ok).toBe(true)
  // No trace of the rug is left in the save the server sees.
  expect(s().player.inventory.decor).toEqual(first.save?.player.inventory.decor)
  const verdict = checkUpload(
    first.save,
    JSON.parse(JSON.stringify(persistedOf(s()))),
    {
      realMinutesSinceAccept: 1,
      burstCreditMinutes: 5,
      accountAgeMinutes: 61,
      serverGrantKeys: [],
      entitledItemIds: [],
      firstUpload: false,
    },
    ceilings,
    config,
  )
  expect(verdict.outcome).not.toBe('reject')
  expect(verdict.findings).not.toContain('goal-without-fact')
})

// SEC-18 (accepted LOW): items bought, placed and sold inside one window leave no trace, so the
// goal check allows up to `home.maxClout` of home clout the window may have held. The slack is
// bounded by that cap: a forged reach-local with goal clout below `threshold - home.maxClout`
// is still refused.
const localThreshold = config.clout.levels.find((level) => level.id === 'local')!.minClout
const slackFloor = localThreshold - config.home.maxClout
it.each([0, Math.floor(slackFloor / 2), slackFloor - 1])(
  'SEC-18 a forged reach-local with %s goal clout (below threshold minus home.maxClout) is refused',
  (flex) => {
    const fresh = initialSave(config)
    const prev: SaveState = {
      ...fresh,
      clock: { minute: 2 * 1440 + 14 * 60, remainderMs: 0 },
      player: {
        ...fresh.player,
        cash: 100,
        clout: {
          ...fresh.player.clout,
          compacted: { entries: 10, bySource: { flex } },
          nextSeq: 11,
          firstPaycheckPaid: true,
        },
      },
      goals: { ...fresh.goals, achieved: { 'first-paycheck': 100 } },
      actions: 40,
    }
    const ctx = {
      realMinutesSinceAccept: 0,
      burstCreditMinutes: 0,
      accountAgeMinutes: 600,
      serverGrantKeys: [],
      entitledItemIds: [],
      firstUpload: true,
    }
    const accepted = checkUpload(null, prev, ctx, ceilings, config)
    expect(accepted.outcome).toBe('accept')
    const base = accepted.save!
    const forged0: SaveState = {
      ...base,
      clock: { ...base.clock, minute: base.clock.minute + 5 },
      actions: 42,
      player: { ...base.player, clout: { ...base.player.clout, peakLevel: 1 } },
      goals: {
        ...base.goals,
        achieved: { ...base.goals.achieved, 'reach-local': base.clock.minute + 5 },
      },
    }
    const reward = config.goals.find((goal) => goal.id === 'reach-local')!.reward
    const claimed = grant(
      forged0,
      { kind: 'goal_reward', goalId: 'reach-local', reward },
      1,
      config,
    )
    if (!claimed.ok) throw new Error(claimed.error.code)
    const verdict = checkUpload(
      base,
      JSON.parse(JSON.stringify({ ...claimed.save, actions: 43 })),
      {
        ...ctx,
        realMinutesSinceAccept: 1,
        burstCreditMinutes: 5,
        accountAgeMinutes: 601,
        firstUpload: false,
        paceCredit: accepted.paceCredit,
      },
      ceilings,
      config,
    )
    expect(verdict.outcome).toBe('reject')
    expect(verdict.grantsToInsert).toEqual([])
  },
)
