import { describe, expect, it } from 'vitest'
import { subway } from '@/lib/data/geo'
import { buildTransitNetwork, searchSubway, type TransitNetwork } from './network'
import { walkMinutes } from './plan'
import { PLACES, TEST_TRANSIT, testWorld } from './test-fixtures'

const costs = {
  walkMin: (metres: number) => walkMinutes(metres, TEST_TRANSIT),
  rideMin: (metres: number) => metres / 500,
  boardWaitMin: 4,
  transferPenaltyMin: 4,
}

describe('transit network from data/geo', () => {
  const network = testWorld().network

  it('places every station on a path of each line it lists', () => {
    expect(network.orphans).toEqual([])
    expect(network.stations).toHaveLength(subway.stations.length)
  })

  it('gives every station at least one ride to a neighbouring stop', () => {
    network.stations.forEach((station, s) => {
      const rides = (network.statesAt[s] ?? []).flatMap((state) => network.rides[state] ?? [])
      expect(rides.length, station.id).toBeGreaterThan(0)
    })
  })

  it('links nearby platforms of one complex by a walking transfer', () => {
    const index = (id: string) => network.stations.findIndex((station) => station.id === id)
    // Times Sq-42 St: the 1/2/3 platforms (127) and the N/Q/R/W platforms (r16).
    const walks = network.walks[index('127')] ?? []
    expect(walks.map((walk) => network.stations[walk.to]?.id)).toContain('r16')
  })

  it('keeps line labels as plain text ids', () => {
    expect(network.lineLabels.get('7')).toBe('7')
    expect(network.lineLabels.get('si')).toBe('SIR')
  })

  it('builds quickly enough to do on demand (496 stations)', () => {
    const start = performance.now()
    const built = buildTransitNetwork(subway, TEST_TRANSIT.subway)
    const elapsed = performance.now() - start
    expect(built.rideEdgeCount).toBeGreaterThan(1000)
    expect(elapsed).toBeLessThan(500)
  })

  it('routes in a few milliseconds', () => {
    const start = performance.now()
    for (let i = 0; i < 20; i++) {
      searchSubway(PLACES.coneyIsland, PLACES.flushingMainSt, network, TEST_TRANSIT.subway, costs)
    }
    expect((performance.now() - start) / 20).toBeLessThan(25)
  })

  it('is deterministic: two builds give identical routes', () => {
    const other: TransitNetwork = buildTransitNetwork(subway, TEST_TRANSIT.subway)
    const a = searchSubway(
      PLACES.coneyIsland,
      PLACES.flushingMainSt,
      network,
      TEST_TRANSIT.subway,
      costs,
    )
    const b = searchSubway(
      PLACES.coneyIsland,
      PLACES.flushingMainSt,
      other,
      TEST_TRANSIT.subway,
      costs,
    )
    expect(a).toBeDefined()
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('finds no route between networks that do not connect (Staten Island)', () => {
    expect(
      searchSubway(PLACES.stGeorge, PLACES.timesSquare, network, TEST_TRANSIT.subway, costs),
    ).toBeUndefined()
  })
})
