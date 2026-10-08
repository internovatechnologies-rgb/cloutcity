/**
 * Slice-end bug hunt, H-1: an honest barista who skips meals (a shift when energy allows, else
 * sleep), one tap every 12 s, uploading after each tap, is never refused for honest pace.
 */
import { expect, it } from 'vitest'
import { engineConfig as config } from '@/engine/config'
import { checkUpload, type CashClout } from '@/engine/plausibility'
import type { SaveState } from '@/engine/save'
import { ceilings, MemoryStorage } from '@/lib/testing/saveHunt'
import { createSafeJsonStorage } from './storage'
import { createGameStore, persistedOf, type PersistedState } from './store'
import { createLogger } from '@/lib/log'

it.each(['barista', 'delivery'] as const)(
  'H-1 an honest %s who skips meals is never refused',
  (job) => {
    const quiet = createLogger({ level: 'error', sink: () => {} })
    const store = createGameStore(
      createSafeJsonStorage<PersistedState>(() => new MemoryStorage(), quiet),
      quiet,
    )
    const s = () => store.getState()
    let prev: SaveState | null = null
    let pace: CashClout | null = null
    let credit = 0
    let since = 0
    let age = 0
    let first = true
    const rejections: string[] = []
    for (let i = 0; i < 400; i += 1) {
      if (!s().workShift(job).ok) s().performAction('sleep')
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
        rejections.push(
          `tap ${save.actions} (real ${Math.round(age / 60_000)} min, day ${Math.floor(save.clock.minute / 1440) + 1}): ${v.findings.join(',')} credit ${JSON.stringify(pace)}`,
        )
        continue
      }
      first = false
      prev = v.save
      pace = v.paceCredit
      credit = v.burstCreditMinutes ?? 0
      since = 0
    }
    expect(rejections).toEqual([])
  },
)
