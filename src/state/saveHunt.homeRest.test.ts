/**
 * B1: an honest player who rests through the home actions (the Home card's Sleep, Nap and Cook
 * at home, `performHomeAction`) instead of the catalog shortcut the bots use, one tap every
 * 12 s, uploading after each tap, is never refused by save plausibility (S18c), and the loop
 * really recovers energy: every sleep lands the player back above a shift's energy cost.
 */
import { expect, it } from 'vitest'
import { engineConfig as config } from '@/engine/config'
import { checkUpload, type CashClout } from '@/engine/plausibility'
import type { SaveState } from '@/engine/save'
import { createLogger } from '@/lib/log'
import { ceilings, MemoryStorage } from '@/lib/testing/saveHunt'
import { createSafeJsonStorage } from './storage'
import { createGameStore, persistedOf, type PersistedState } from './store'

it('an honest shift / cook / sleep loop through the home actions is never refused', () => {
  const quiet = createLogger({ level: 'error', sink: () => {} })
  const store = createGameStore(
    createSafeJsonStorage<PersistedState>(() => new MemoryStorage(), quiet),
    quiet,
  )
  const s = () => store.getState()
  const shiftEnergy = config.jobs.energyCostPerShift.barista
  let prev: SaveState | null = null
  let pace: CashClout | null = null
  let credit = 0
  let since = 0
  let age = 0
  let first = true
  let sleeps = 0
  const rejections: string[] = []
  for (let i = 0; i < 300; i += 1) {
    const hungry = s().player.stats.hunger < 30
    const ate = hungry && s().performHomeAction('home-meal').ok
    if (!ate && !s().workShift('barista').ok) {
      const slept = s().performHomeAction('sleep')
      expect(slept.ok).toBe(true)
      sleeps += 1
      expect(s().player.stats.energy).toBeGreaterThanOrEqual(shiftEnergy)
    }
    for (let t = 0; t < 12; t += 1) s().tick(1000, true)
    since += 12_000
    age += 12_000
    const save = persistedOf(s())
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
    if (v.outcome === 'reject') {
      rejections.push(`tap ${save.actions}: ${v.findings.join(',')}`)
      continue
    }
    first = false
    prev = v.save
    pace = v.paceCredit
    credit = v.burstCreditMinutes ?? 0
    since = 0
  }
  expect(sleeps).toBeGreaterThan(10)
  expect(rejections).toEqual([])
})
