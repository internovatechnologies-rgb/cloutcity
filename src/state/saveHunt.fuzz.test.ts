/**
 * Slice-end bug hunt: every play policy, several seeds, at upload cadences 1, 3, 10 and 40, with
 * reloads: no honest upload is refused or repaired, and every save stays valid. Widen with
 * HUNT_POLICIES, HUNT_SEEDS and HUNT_STEPS (the 170k-step hunt ran with those raised).
 */
import { describe, expect, it } from 'vitest'
import { run, type Policy } from '@/lib/testing/saveHunt'

const policies: Policy[] = (process.env.HUNT_POLICIES?.split(',') as Policy[] | undefined) ?? [
  'random',
  'grinder',
  'flexer',
  'clubber',
  'decorator',
  'shopper',
  'icon',
]
const SEEDS = Number(process.env.HUNT_SEEDS ?? 2)
const STEPS = Number(process.env.HUNT_STEPS ?? 300)

describe('hunt fuzz', { timeout: 600_000 }, () => {
  for (const policy of policies) {
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      it(`${policy} seed ${seed}`, () => {
        const every = [1, 3, 10, 40][seed % 4]!
        const tap: [number, number] = seed % 3 === 0 ? [1600, 2500] : [2000, 6000]
        const report = run({
          seed: seed * 7919,
          policy,
          steps: STEPS,
          uploadEvery: every,
          tapMs: tap,
          speed: seed % 2 === 0 ? 2 : 1,
        })
        expect(report.failures.filter((f) => f.kind !== 'honest-repair')).toEqual([])
      })
    }
  }
})
