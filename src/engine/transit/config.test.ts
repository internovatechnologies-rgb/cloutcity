import { describe, expect, it } from 'vitest'
import { balance } from '@/lib/data/config'
import { TransitConfigSchema } from '@/lib/data/schemas/config'
import { transitConfig } from './config'
import { TEST_TRANSIT } from './test-fixtures'

describe('transit config', () => {
  it('is the validated balance.json transit block plus the subway fare anchor', () => {
    expect(TransitConfigSchema.parse(balance.transit)).toEqual(balance.transit)
    expect(transitConfig).toEqual({ ...balance.transit, subwayFare: balance.costs.subwayFare })
    expect(transitConfig.subwayFare).toBe(3)
  })

  it('keeps rush hour at 7-10am and 4-7pm (acceptance criterion)', () => {
    expect(transitConfig.rushHour.windows).toEqual([
      { startMin: 7 * 60, endMin: 10 * 60 },
      { startMin: 16 * 60, endMin: 19 * 60 },
    ])
  })

  it('test fixtures match the shape the schema accepts', () => {
    const { subwayFare, ...fixture } = TEST_TRANSIT
    expect(subwayFare).toBe(3)
    expect(TransitConfigSchema.safeParse(fixture).success).toBe(true)
  })

  it('rejects an inverted rush-hour window and an out-of-range probability', () => {
    const bad = (patch: object) => TransitConfigSchema.safeParse({ ...balance.transit, ...patch })
    expect(
      bad({ rushHour: { ...balance.transit.rushHour, windows: [{ startMin: 600, endMin: 420 }] } })
        .success,
    ).toBe(false)
    expect(bad({ delay: { ...balance.transit.delay, probability: 1.5 } }).success).toBe(false)
  })
})
