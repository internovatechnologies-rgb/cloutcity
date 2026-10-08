/** S08 part 2: travel copy renders every row, reason and arrival from data, plainly. */
import { describe, expect, it } from 'vitest'
import { createCopy } from '@/lib/copy'
import { baseCopy, slangPacks } from '@/lib/copy/all'
import type { TripError, TripOption } from '@/engine/transit/trip'
import {
  arrivalText,
  homeBlurb,
  spotName,
  tripBlockReason,
  tripOptionAccessibleName,
  tripOptionDetails,
  tripProgressText,
} from './travelCopy'

const packs = [
  ['base', createCopy(baseCopy, { id: 'none', strings: {} })],
  ['nyc', createCopy(baseCopy, slangPacks.nyc ?? { id: 'none', strings: {} })],
] as const

const route = (fare: number, transfers: number, rushHour: boolean) => ({
  mode: 'subway' as const,
  from: { x: 0, y: 0 },
  to: { x: 1, y: 1 },
  legs: [],
  durationMin: 24,
  fare,
  transfers,
  walkedM: 0,
  rushHour,
})

const BLOCKS: readonly (TripError | { readonly code: 'TRIP_IN_PROGRESS' })[] = [
  { code: 'WALK_CROSSES_WATER' },
  { code: 'NO_SUBWAY_ROUTE' },
  { code: 'TAXI_NO_CROSSING' },
  { code: 'INVALID_POINT' },
  { code: 'POINT_NOT_REACHABLE', end: 'to' },
  { code: 'ALREADY_THERE', distanceM: 3 },
  { code: 'ALREADY_HERE' },
  { code: 'TRIP_TOO_LONG', durationMin: 1500, maxMin: 1440 },
  { code: 'INSUFFICIENT_FUNDS', required: 14, available: 2 },
  { code: 'INSUFFICIENT_ENERGY', required: 1, available: 0 },
  { code: 'UNKNOWN_ACTION', actionId: 'x' },
  { code: 'INVALID_ACTION', issues: [] },
  { code: 'NO_ROUTE_DATA' },
  { code: 'TRIP_IN_PROGRESS' },
  {
    code: 'BOROUGH_LOCKED',
    access: { status: 'locked', required: 'scene-regular', current: 'nobody' },
  },
  { code: 'BOROUGH_LOCKED', access: { status: 'expanding-soon' } },
]

describe.each(packs)('travel copy (%s pack)', (_name, copy) => {
  it('every reason renders, with no transit operator named', () => {
    for (const block of BLOCKS) {
      const borough =
        block.code === 'BOROUGH_LOCKED' && block.access.status === 'expanding-soon'
          ? 'bronx'
          : 'manhattan'
      const text = tripBlockReason(block, { borough }, { copy })
      expect(text, block.code).not.toBe('')
      expect(text).not.toMatch(/\bMTA\b/)
    }
    // Home is never borough-locked, but a lock without a place still says something plain.
    expect(tripBlockReason(BLOCKS[14] as TripError, null, { copy })).not.toBe('')
  })

  it('a row says time, fare, changes and rush hour from the plan, and why it is blocked', () => {
    const option: TripOption = {
      mode: 'subway',
      route: route(3, 2, true),
      durationMin: 31,
      block: null,
    }
    const details = tripOptionDetails(option, { copy })
    expect(details).toContain('31 min')
    expect(details).toContain('$3')
    expect(details).toContain('2')
    const free = tripOptionDetails({ ...option, route: route(0, 0, false) }, { copy })
    expect(free).not.toContain('$')
    const blocked = tripOptionAccessibleName(
      { ...option, block: { code: 'INSUFFICIENT_FUNDS', required: 3, available: 1 } },
      { borough: 'queens' },
      { copy },
    )
    expect(blocked).toContain('$1')
    expect(tripOptionDetails({ ...option, route: null }, { copy })).toBe('')
  })

  it('the arrival names the place, the time, the fare, a delay and rent on the way', () => {
    const text = arrivalText(
      {
        destination: { kind: 'place', placeId: 'late-lantern-deli' },
        mode: 'subway',
        durationMin: 40,
        fare: 3,
        delayMin: 9,
        rent: [],
      },
      { copy },
    )
    expect(text).toContain(spotName({ kind: 'place', placeId: 'late-lantern-deli' }, { copy }))
    expect(text).toContain('40 min')
    expect(text).toContain('9 min')
    expect(text).not.toMatch(/\bMTA\b/)
    expect(spotName({ kind: 'home' }, { copy })).not.toBe('')
    expect(homeBlurb('queens-room', { copy })).not.toBe('')
    expect(tripProgressText({ kind: 'home' }, 'taxi', { copy }).title).not.toBe('')
  })
})
