/**
 * Slice-end bug hunt, H-1R: a lean player from Local on (junior dev unlocked: shifts and sleep
 * only, a few with meals or coffee), uploading every 5, 12 or 40 s, is never refused: the per-tap
 * bound is derived from config (the best wage the reached level unlocks).
 */
import { expect, it } from 'vitest'
import { engineConfig as config } from '@/engine/config'
import { checkUpload, type CashClout } from '@/engine/plausibility'
import { initialSave, SAVE_VERSION, type SaveState } from '@/engine/save'
import { ceilings, MemoryStorage } from '@/lib/testing/saveHunt'
import { createSafeJsonStorage } from './storage'
import { createGameStore, persistedOf, type PersistedState } from './store'
import { createLogger } from '@/lib/log'

const cases = [
  ['junior-dev', 'shift', 12],
  ['junior-dev', 'shift', 5],
  ['junior-dev', 'shift', 40],
  ['retail', 'shift', 12],
  ['barista', 'shift', 5],
  ['junior-dev', 'eat', 12],
  ['junior-dev', 'eat-coffee', 12],
] as const

it.each(cases)('lean %s (%s) every %ss from Local is never refused', (job, kind, sec) => {
  const quiet = createLogger({ level: 'error', sink: () => {} })
  const store = createGameStore(
    createSafeJsonStorage<PersistedState>(() => new MemoryStorage(), quiet),
    quiet,
  )
  const s = () => store.getState()
  const fresh = initialSave(config)
  // Start at Local on flex clout (junior dev unlocked), honestly earned before the first upload.
  const start: SaveState = {
    ...fresh,
    clock: { minute: 20 * 1440 + 8 * 60, remainderMs: 0 },
    player: {
      ...fresh.player,
      cash: 300,
      clout: {
        ...fresh.player.clout,
        compacted: { entries: 30, bySource: { flex: 110 } },
        nextSeq: 31,
        peakLevel: 1,
        firstPaycheckPaid: true,
      },
    },
    actions: 300,
  }
  let first = true
  let prev: SaveState | null = null
  let pace: CashClout | null = null
  let credit = 0
  let since = 0
  let age = 120 * 60_000
  const up = () => {
    const save = JSON.parse(JSON.stringify(persistedOf(s())))
    const v = checkUpload(
      prev,
      save,
      {
        realMinutesSinceAccept: since / 60_000,
        burstCreditMinutes: credit,
        paceCredit: pace,
        accountAgeMinutes: age / 60_000,
        serverGrantKeys: [],
        entitledItemIds: [],
        firstUpload: first,
      },
      ceilings,
      config,
    )
    if (v.outcome === 'reject')
      return `tap ${save.actions} real ${Math.round(age / 60000)}m day ${Math.floor(save.clock.minute / 1440) + 1}: ${v.findings.join(',')} ${JSON.stringify(pace)}`
    first = false
    prev = v.save
    pace = v.paceCredit
    credit = v.burstCreditMinutes ?? 0
    since = 0
    s().applyRepairs(v.repairs)
    return null
  }
  expect(s().adoptCloudSave(start, SAVE_VERSION)).toBe(true)
  expect(up()).toBeNull()
  const rejections: string[] = []
  for (let i = 0; i < 600; i += 1) {
    const st = s().player.stats
    if (kind !== 'shift' && st.hunger < 40 && s().performAction('home-meal').ok) {
      /* ate */
    } else if (
      kind === 'eat-coffee' &&
      st.energy < 30 &&
      s().player.cash > 100 &&
      s().performAction('deli-coffee').ok
    ) {
      /* coffee */
    } else if (!s().workShift(job).ok) s().performAction('sleep')
    for (let t = 0; t < sec; t += 1) s().tick(1000, true)
    since += sec * 1000
    age += sec * 1000
    const r = up()
    if (r) rejections.push(r)
  }
  expect(rejections).toEqual([])
})
