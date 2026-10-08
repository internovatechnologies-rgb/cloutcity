/**
 * Slice-end bug hunt, verify of S-1: honest windows that buy, place, claim and sell decor, or
 * move up, claim and move back with the move log at its cap, leave no net home trace. The goal
 * check's home slack (SEC-18) must keep accepting them.
 */
import { expect, it } from 'vitest'
import { engineConfig as config } from '@/engine/config'
import { checkUpload } from '@/engine/plausibility'
import { initialSave, SAVE_VERSION, type SaveState } from '@/engine/save'
import { createLogger } from '@/lib/log'
import { ceilings, MemoryStorage } from '@/lib/testing/saveHunt'
import { createSafeJsonStorage } from './storage'
import { createGameStore, persistedOf, type PersistedState } from './store'

it.each([false, true])(
  'H-2c buy rug, place, reach Local, claim, sell rug (then a shift: %s) is not rejected',
  (shift) => {
    const quiet = createLogger({ level: 'error', sink: () => {} })
    const store = createGameStore(
      createSafeJsonStorage<PersistedState>(() => new MemoryStorage(), quiet),
      quiet,
    )
    const s = () => store.getState()
    const fresh = initialSave(config)
    const prev: SaveState = {
      ...fresh,
      clock: { minute: 2 * 1440 + 9 * 60, remainderMs: 0 },
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
    expect(s().placeDecor('thrift-flatweave-rug', 'floor-1').ok).toBe(true)
    expect(s().goals.achieved['reach-local']).toBeDefined()
    expect(s().claimGoalReward('reach-local').ok).toBe(true)
    expect(s().sellItem('thrift-flatweave-rug').ok).toBe(true)
    if (shift) expect(s().workShift('barista').ok).toBe(true)
    const v = checkUpload(
      first.save,
      JSON.parse(JSON.stringify(persistedOf(s()))),
      {
        realMinutesSinceAccept: 1,
        burstCreditMinutes: 5,
        accountAgeMinutes: 61,
        serverGrantKeys: [],
        entitledItemIds: [],
        firstUpload: false,
        paceCredit: first.paceCredit,
      },
      ceilings,
      config,
    )
    expect(v.outcome).not.toBe('reject')
  },
)

it.each([0, 1, 3])(
  'H-2d move up, reach Scene Regular, claim, move back with the move log at its cap (then %s shifts) is not rejected',
  (shifts) => {
    const quiet = createLogger({ level: 'error', sink: () => {} })
    const store = createGameStore(
      createSafeJsonStorage<PersistedState>(() => new MemoryStorage(), quiet),
      quiet,
    )
    const s = () => store.getState()
    const fresh = initialSave(config)
    const moveLog = Array.from({ length: config.home.moveLogMax }, (_, i) => ({
      from: i % 2 === 0 ? 'queens-room' : 'brooklyn-1br',
      to: i % 2 === 0 ? 'brooklyn-1br' : 'queens-room',
      at: 100 + i,
      cost: 0,
    })) as SaveState['player']['apartment']['moveLog']
    const prev: SaveState = {
      ...fresh,
      clock: { minute: 2 * 1440 + 9 * 60, remainderMs: 0 },
      player: {
        ...fresh.player,
        cash: 2000,
        apartment: { placed: {}, moveLog },
        clout: {
          ...fresh.player.clout,
          compacted: { entries: 23, bySource: { flex: 291 } },
          nextSeq: 24,
          peakLevel: 1,
          firstPaycheckPaid: true,
        },
      },
      goals: { ...fresh.goals, achieved: { 'first-paycheck': 100, 'reach-local': 200 } },
      grants: { log: [], nextSeq: 1 },
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
    expect(s().adoptCloudSave(JSON.parse(JSON.stringify(first.save)), SAVE_VERSION)).toBe(true)
    expect(s().moveHome('brooklyn-1br').ok).toBe(true)
    expect(s().goals.achieved['reach-scene-regular']).toBeDefined()
    expect(s().claimGoalReward('reach-scene-regular').ok).toBe(true)
    expect(s().moveHome('queens-room').ok).toBe(true)
    for (let i = 0; i < shifts; i += 1)
      if (!s().workShift('junior-dev').ok) s().performAction('sleep')
    const v = checkUpload(
      first.save,
      JSON.parse(JSON.stringify(persistedOf(s()))),
      {
        realMinutesSinceAccept: 1,
        burstCreditMinutes: 5,
        accountAgeMinutes: 61,
        serverGrantKeys: [],
        entitledItemIds: [],
        firstUpload: false,
        paceCredit: first.paceCredit,
      },
      ceilings,
      config,
    )
    expect(v.outcome).not.toBe('reject')
  },
)
