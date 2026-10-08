/** Slice-end bug hunt, H-2: the icon-policy fuzz seed that found it (long: 8700 steps). */
import { expect, it } from 'vitest'
import { run } from '@/lib/testing/saveHunt'
it('H-2 icon seed 2', () => {
  const every = [1, 3, 10, 40][2 % 4]!
  const report = run({
    seed: 2 * 7919,
    policy: 'icon',
    steps: 8700,
    uploadEvery: every,
    tapMs: [2000, 6000],
    speed: 2,
    stopOnReject: true,
  })
  const rej = report.failures.filter((f) => f.kind === 'upload-rejected')
  expect(rej).toEqual([])
}, 600_000)
