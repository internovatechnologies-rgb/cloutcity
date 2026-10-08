import { describe, expect, it } from 'vitest'
import zonesJson from '@data/zones/zones.derived.json'
import { subway } from '@/lib/data/geo'
import { decodePath } from '@/lib/geo/codec'
import { distanceToPolyline } from '@/lib/geo/polygon'
import { distanceM, project, type LocalPoint } from '@/lib/geo/projection'
import { createRng } from '../rng'
import { crossesWater, isOnLand, longestWaterRunM } from './land'
import { measurePath } from './polyline'
import {
  isRushHour,
  planAllModes,
  planTrip,
  taxiFare,
  walkMinutes,
  type PlanContext,
  type PlanResult,
  type Route,
  type SubwayLeg,
} from './plan'
import { EIGHT_AM, NOON, PLACES, TEST_TRANSIT, testWorld, allLandWorld } from './test-fixtures'
import { createTransitWorld } from './world'

const world = testWorld()
const zones = zonesJson.zones
const network = world.network
const at = (minuteOfDay: number): PlanContext => ({
  config: TEST_TRANSIT,
  minuteOfDay,
  world,
})
const onLand = (minuteOfDay: number): PlanContext => ({
  config: TEST_TRANSIT,
  minuteOfDay,
  world: allLandWorld(),
})

function route(result: PlanResult): Route {
  if (!result.ok) throw new Error(`expected a route, got ${result.error.code}`)
  return result.route
}

const subwayLegs = (r: Route) => r.legs.filter((leg): leg is SubwayLeg => leg.mode === 'subway')
const stationXY = (id: string): LocalPoint => {
  const station = network.stations.find((s) => s.id === id)
  if (station === undefined) throw new Error(`no station ${id}`)
  return { x: station.x, y: station.y }
}

describe('distance', () => {
  it('Times Square to the Brooklyn Bridge matches the WGS84 geodesic within 0.5%', () => {
    // Vincenty inverse on WGS84 between the same two points: 5843.3 m.
    const geodesic = 5843.3
    const projected = distanceM(
      project({ lat: 40.758, lng: -73.9855 }),
      project({ lat: 40.7061, lng: -73.9969 }),
    )
    expect(Math.abs(projected - geodesic) / geodesic).toBeLessThan(0.005)
  })
})

describe('walk and taxi', () => {
  it('walks at the configured speed with the street detour', () => {
    // 1 km straight is 1.3 km of street at 4.8 km/h: 16.25 min.
    expect(walkMinutes(1000, TEST_TRANSIT)).toBeCloseTo(16.25, 6)
    const r = route(planTrip({ x: 0, y: 0 }, { x: 1000, y: 0 }, 'walk', onLand(NOON)))
    expect(r.durationMin).toBe(17)
    expect(r.fare).toBe(0)
    expect(r.walkedM).toBeCloseTo(1300, 6)
    expect(r.legs).toHaveLength(1)
    expect(r.legs[0]?.polyline).toEqual([
      { x: 0, y: 0 },
      { x: 1000, y: 0 },
    ])
  })

  it('charges the taxi flag drop plus per km driven, rounded up to whole dollars', () => {
    // 10 km straight is 13 km driven: $3 + 13 x $2 = $29.
    expect(taxiFare(10_000, TEST_TRANSIT)).toBe(29)
    expect(taxiFare(1, TEST_TRANSIT)).toBe(4)
    const r = route(planTrip({ x: 0, y: 0 }, { x: 10_000, y: 0 }, 'taxi', onLand(NOON)))
    // 5 min pickup + 13 km at 20 km/h (39 min).
    expect(r.durationMin).toBe(44)
    expect(r.fare).toBe(29)
    expect(r.walkedM).toBe(0)
  })

  it('refuses a trip to where the player already is, and non-finite points', () => {
    const here = { x: 10, y: 10 }
    expect(planTrip(here, { x: 20, y: 10 }, 'walk', at(NOON))).toEqual({
      ok: false,
      error: { code: 'ALREADY_THERE', distanceM: 10 },
    })
    expect(planTrip(here, { x: Number.NaN, y: 0 }, 'taxi', at(NOON))).toEqual({
      ok: false,
      error: { code: 'INVALID_POINT' },
    })
  })
})

describe('subway routing on the real lines', () => {
  it('Times Square to Flushing-Main St rides the 7', () => {
    const r = route(planTrip(PLACES.timesSquare, PLACES.flushingMainSt, 'subway', at(NOON)))
    const trains = subwayLegs(r)
    expect(trains).toHaveLength(1)
    expect(['7', '7x']).toContain(trains[0]?.lineId)
    expect(trains[0]?.toStationId).toBe('701')
    expect(r.transfers).toBe(0)
    expect(r.fare).toBe(3)
  })

  it('Coney Island to Times Square rides the N/Q/R/W or D/F', () => {
    const r = route(planTrip(PLACES.coneyIsland, PLACES.timesSquare, 'subway', at(NOON)))
    const trains = subwayLegs(r)
    expect(trains[0]?.fromStationId).toBe('d43')
    for (const leg of trains) expect(['n', 'q', 'r', 'w', 'd', 'f', 'fx']).toContain(leg.lineId)
  })

  it('walks from the origin to the first station and from the last station to the destination', () => {
    const r = route(planTrip(PLACES.timesSquare, PLACES.flushingMainSt, 'subway', at(NOON)))
    const first = r.legs[0]
    const last = r.legs[r.legs.length - 1]
    const trains = subwayLegs(r)
    expect(first?.mode).toBe('walk')
    expect(last?.mode).toBe('walk')
    expect(first?.from).toEqual(PLACES.timesSquare)
    expect(first?.to).toEqual(stationXY(trains[0]?.fromStationId ?? ''))
    expect(last?.from).toEqual(stationXY(trains[trains.length - 1]?.toStationId ?? ''))
    expect(last?.to).toEqual(PLACES.flushingMainSt)
  })

  it('counts transfers and charges one flat fare for the whole trip', () => {
    const r = route(planTrip(PLACES.coneyIsland, PLACES.flushingMainSt, 'subway', at(NOON)))
    const trains = subwayLegs(r)
    expect(trains.length).toBeGreaterThanOrEqual(2)
    expect(r.transfers).toBe(trains.length - 1)
    expect(r.fare).toBe(TEST_TRANSIT.subwayFare)
    // The first train waits the board wait; every later one the transfer penalty.
    expect(trains[0]?.waitMin).toBe(TEST_TRANSIT.subway.boardWaitMin)
    for (const leg of trains.slice(1))
      expect(leg.waitMin).toBe(TEST_TRANSIT.subway.transferPenaltyMin)
  })

  it('draws each subway leg along its line path between the two stations', () => {
    const r = route(planTrip(PLACES.coneyIsland, PLACES.flushingMainSt, 'subway', at(NOON)))
    for (const leg of subwayLegs(r)) {
      const line = network.lineLabels.get(leg.lineId)
      expect(line, leg.lineId).toBeDefined()
      const start = leg.polyline[0]
      const end = leg.polyline[leg.polyline.length - 1]
      if (start === undefined || end === undefined) throw new Error('empty polyline')
      expect(distanceM(start, leg.from)).toBeLessThan(TEST_TRANSIT.subway.stationSnapM)
      expect(distanceM(end, leg.to)).toBeLessThan(TEST_TRANSIT.subway.stationSnapM)
      expect(leg.polyline.length).toBeGreaterThan(2)
      // Along the track is never shorter than the straight line between the stations.
      expect(leg.distanceM).toBeGreaterThanOrEqual(distanceM(leg.from, leg.to) - 1)
      for (const stop of [leg.from, leg.to]) {
        expect(distanceToPolyline(stop, leg.polyline)).toBeLessThan(
          TEST_TRANSIT.subway.stationSnapM,
        )
      }
    }
  })

  it('adds up: the duration is the legs rounded up to whole minutes', () => {
    const r = route(planTrip(PLACES.coneyIsland, PLACES.timesSquare, 'subway', at(NOON)))
    const sum = r.legs.reduce((total, leg) => total + leg.minutes, 0)
    expect(r.durationMin).toBe(Math.ceil(sum))
  })

  it('has no subway between Staten Island and Manhattan (the railway does not connect)', () => {
    expect(planTrip(PLACES.stGeorge, PLACES.timesSquare, 'subway', at(NOON))).toEqual({
      ok: false,
      error: { code: 'NO_SUBWAY_ROUTE' },
    })
  })

  it('never walks across water to or from a station', () => {
    for (const [from, to] of [
      [PLACES.timesSquare, PLACES.flushingMainSt],
      [PLACES.coneyIsland, PLACES.flushingMainSt],
      [PLACES.brooklynBridgePark, PLACES.timesSquare],
    ] as const) {
      const r = route(planTrip(from, to, 'subway', at(NOON)))
      for (const leg of r.legs) {
        if (leg.mode === 'walk') expect(world.walkable(leg.from, leg.to)).toBe(true)
      }
    }
  })
})

describe('choosing a mode', () => {
  it('walks a few blocks (Times Square to Bryant Park)', () => {
    expect(planAllModes(PLACES.timesSquare, PLACES.bryantPark, at(NOON)).fastest).toBe('walk')
  })

  it('takes the subway across boroughs (Times Square to Flushing)', () => {
    const options = planAllModes(PLACES.timesSquare, PLACES.flushingMainSt, at(NOON))
    expect(options.fastest).toBe('subway')
    expect(options.walk).toEqual({ ok: false, error: { code: 'WALK_CROSSES_WATER' } })
    const subway = route(options.subway)
    const taxi = route(options.taxi)
    expect(subway.durationMin).toBeLessThan(taxi.durationMin)
    expect(taxi.fare).toBeGreaterThan(subway.fare)
  })

  it('takes a taxi where no subway links the ends (St George to Times Square)', () => {
    const options = planAllModes(PLACES.stGeorge, PLACES.timesSquare, at(NOON))
    expect(options.subway.ok).toBe(false)
    expect(options.fastest).toBe('taxi')
  })
})

describe('rush hour', () => {
  it('runs 7-10am and 4-7pm by the personal clock', () => {
    expect(isRushHour(6 * 60 + 59, TEST_TRANSIT)).toBe(false)
    expect(isRushHour(7 * 60, TEST_TRANSIT)).toBe(true)
    expect(isRushHour(EIGHT_AM, TEST_TRANSIT)).toBe(true)
    expect(isRushHour(10 * 60, TEST_TRANSIT)).toBe(false)
    expect(isRushHour(NOON, TEST_TRANSIT)).toBe(false)
    expect(isRushHour(16 * 60, TEST_TRANSIT)).toBe(true)
    expect(isRushHour(19 * 60, TEST_TRANSIT)).toBe(false)
  })

  it('slows the subway at 8:00 compared with 12:00, and only the subway', () => {
    const rush = route(planTrip(PLACES.coneyIsland, PLACES.timesSquare, 'subway', at(EIGHT_AM)))
    const noon = route(planTrip(PLACES.coneyIsland, PLACES.timesSquare, 'subway', at(NOON)))
    expect(rush.rushHour).toBe(true)
    expect(noon.rushHour).toBe(false)
    const ride = (r: Route) => subwayLegs(r).reduce((sum, leg) => sum + leg.rideMin, 0)
    expect(ride(rush)).toBeCloseTo(ride(noon) * TEST_TRANSIT.rushHour.subwayDurationMultiplier, 6)
    expect(rush.durationMin).toBeGreaterThan(noon.durationMin)

    const walkRush = route(planTrip(PLACES.timesSquare, PLACES.unionSquare, 'walk', at(EIGHT_AM)))
    const walkNoon = route(planTrip(PLACES.timesSquare, PLACES.unionSquare, 'walk', at(NOON)))
    expect(walkRush.durationMin).toBe(walkNoon.durationMin)
    expect(walkRush.rushHour).toBe(false)
  })

  it('slows the taxi at 8:00 compared with 12:00, driving time only', () => {
    const rush = route(planTrip(PLACES.coneyIsland, PLACES.timesSquare, 'taxi', at(EIGHT_AM)))
    const noon = route(planTrip(PLACES.coneyIsland, PLACES.timesSquare, 'taxi', at(NOON)))
    expect(rush.rushHour).toBe(true)
    expect(noon.rushHour).toBe(false)
    const drive = (r: Route) => (r.legs[0]?.minutes ?? 0) - TEST_TRANSIT.taxi.pickupMin
    expect(drive(rush)).toBeCloseTo(drive(noon) * TEST_TRANSIT.rushHour.taxiDurationMultiplier, 6)
    expect(rush.fare).toBe(noon.fare)
  })
})

describe('no walking or driving across open water', () => {
  it('refuses to walk from Times Square to Flushing (the East River is in the way)', () => {
    expect(planTrip(PLACES.timesSquare, PLACES.flushingMainSt, 'walk', at(NOON))).toEqual({
      ok: false,
      error: { code: 'WALK_CROSSES_WATER' },
    })
  })

  it('still walks within one borough (Times Square to Union Square)', () => {
    const r = route(planTrip(PLACES.timesSquare, PLACES.unionSquare, 'walk', at(NOON)))
    expect(r.legs).toHaveLength(1)
    expect(r.durationMin).toBeGreaterThan(0)
  })

  it('drives a taxi straight when the road stays on land', () => {
    const r = route(planTrip(PLACES.timesSquare, PLACES.unionSquare, 'taxi', at(NOON)))
    const leg = r.legs[0]
    if (leg?.mode !== 'taxi') throw new Error('no taxi leg')
    expect(leg.crossingIds).toEqual([])
    expect(leg.polyline).toEqual([PLACES.timesSquare, PLACES.unionSquare])
  })

  function taxiLeg(from: LocalPoint, to: LocalPoint) {
    const r = route(planTrip(from, to, 'taxi', at(NOON)))
    const leg = r.legs[0]
    if (leg?.mode !== 'taxi') throw new Error('no taxi leg')
    return { r, leg }
  }

  /** Every stretch that is not a crossing span stays on land. */
  function expectDryStretches(leg: {
    polyline: readonly LocalPoint[]
    crossingIds: readonly string[]
  }) {
    const ends = new Set(
      TEST_TRANSIT.crossings
        .flatMap((c) => [project(c.a), project(c.b)])
        .map((p) => `${p.x},${p.y}`),
    )
    for (let i = 1; i < leg.polyline.length; i++) {
      const a = leg.polyline[i - 1]
      const b = leg.polyline[i]
      if (a === undefined || b === undefined) continue
      const isSpan = ends.has(`${a.x},${a.y}`) && ends.has(`${b.x},${b.y}`)
      if (!isSpan) {
        expect(crossesWater(a, b, world.land, TEST_TRANSIT.taxi.maxWaterM), `stretch ${i}`).toBe(
          false,
        )
      }
    }
  }

  it('takes a taxi from Times Square to Brooklyn Bridge Park over a bridge or through a tunnel', () => {
    const { r, leg } = taxiLeg(PLACES.timesSquare, PLACES.brooklynBridgePark)
    expect(leg.crossingIds).toHaveLength(1)
    expect([
      'brooklyn-bridge',
      'manhattan-bridge',
      'williamsburg-bridge',
      'hugh-l-carey-tunnel',
    ]).toContain(leg.crossingIds[0])
    expect(leg.polyline).toHaveLength(4)
    expect(leg.distanceM).toBeGreaterThan(distanceM(PLACES.timesSquare, PLACES.brooklynBridgePark))
    expect(r.fare).toBe(taxiFare(leg.distanceM, TEST_TRANSIT))
    expectDryStretches(leg)
    // And back the same way.
    expect(taxiLeg(PLACES.brooklynBridgePark, PLACES.timesSquare).leg.crossingIds).toEqual(
      leg.crossingIds,
    )
  })

  it('takes a taxi from Coney Island to St George over the Verrazzano-Narrows', () => {
    const { leg } = taxiLeg(PLACES.coneyIsland, PLACES.stGeorge)
    expect(leg.crossingIds).toEqual(['verrazzano-narrows-bridge'])
    expectDryStretches(leg)
  })

  it('chains crossings when one is not enough (St George to Times Square)', () => {
    const { leg } = taxiLeg(PLACES.stGeorge, PLACES.timesSquare)
    expect(leg.crossingIds[0]).toBe('verrazzano-narrows-bridge')
    expect(leg.crossingIds.length).toBeGreaterThanOrEqual(2)
    expectDryStretches(leg)
  })

  it('refuses a taxi across water when no crossing links the ends', () => {
    const noCrossings = { ...TEST_TRANSIT, crossings: [] }
    const bare = createTransitWorld(world.network, world.land, noCrossings)
    expect(
      planTrip(PLACES.timesSquare, PLACES.flushingMainSt, 'taxi', {
        config: noCrossings,
        minuteOfDay: NOON,
        world: bare,
      }),
    ).toEqual({ ok: false, error: { code: 'TAXI_NO_CROSSING' } })
  })

  it('every road waypoint is on land', () => {
    expect(TEST_TRANSIT.roadWaypoints.length).toBeGreaterThan(0)
    for (const waypoint of TEST_TRANSIT.roadWaypoints) {
      expect(isOnLand(project(waypoint.at), world.land), waypoint.id).toBe(true)
    }
  })

  it('every configured crossing has both ends on land and spans water', () => {
    for (const crossing of TEST_TRANSIT.crossings) {
      const a = project(crossing.a)
      const b = project(crossing.b)
      expect(isOnLand(a, world.land), `${crossing.id} a`).toBe(true)
      expect(isOnLand(b, world.land), `${crossing.id} b`).toBe(true)
      expect(longestWaterRunM(a, b, world.land), crossing.id).toBeGreaterThan(0)
    }
  })
})

describe('reaching every part of the city by taxi', () => {
  const taxiTo = (from: LocalPoint, to: LocalPoint) => planTrip(from, to, 'taxi', at(NOON))
  const crossingsOf = (r: Route) =>
    r.legs.flatMap((leg) => (leg.mode === 'taxi' ? leg.crossingIds : []))

  it('drives to Times Square from every subway station and every zone centroid', () => {
    const starts = [
      ...network.stations.map((s) => [`station ${s.id}`, { x: s.x, y: s.y }] as const),
      ...zones.map((z) => [`zone ${z.id}`, z.centroid] as const),
    ]
    const failures = starts.flatMap(([id, point]) => {
      const result = taxiTo(point, PLACES.timesSquare)
      return result.ok || distanceM(point, PLACES.timesSquare) < TEST_TRANSIT.minTripM
        ? []
        : [`${id}: ${result.error.code}`]
    })
    expect(failures).toEqual([])
    // About 570 taxi plans: allow for a loaded machine.
  }, 120_000)

  it('reaches Roosevelt Island over its bridge from Queens and City Island over its bridge', () => {
    const rooseveltIsland = project({ lat: 40.759, lng: -73.953 })
    const astoria = project({ lat: 40.7644, lng: -73.9235 })
    expect(crossingsOf(route(taxiTo(astoria, rooseveltIsland)))).toEqual([
      'roosevelt-island-bridge',
    ])
    const cityIsland = project({ lat: 40.8475, lng: -73.7865 })
    const pelhamBay = project({ lat: 40.852, lng: -73.828 })
    expect(crossingsOf(route(taxiTo(pelhamBay, cityIsland)))).toEqual(['city-island-bridge'])
  })

  it('drives Broad Channel to Howard Beach over the north Cross Bay span, without a detour', () => {
    const broadChannel = project({ lat: 40.6083, lng: -73.816 })
    const howardBeach = project({ lat: 40.66, lng: -73.83 })
    const r = route(taxiTo(broadChannel, howardBeach))
    expect(crossingsOf(r)).toEqual(['cross-bay-bridge-north'])
    expect(r.legs[0]?.distanceM).toBeLessThanOrEqual(2 * distanceM(broadChannel, howardBeach))
  })

  it('chains both Cross Bay spans across Broad Channel to reach the Rockaways', () => {
    const howardBeach = project({ lat: 40.66, lng: -73.83 })
    const rockawayBeach = project({ lat: 40.5875, lng: -73.813 })
    expect(crossingsOf(route(taxiTo(howardBeach, rockawayBeach)))).toEqual([
      'cross-bay-bridge-north',
      'cross-bay-bridge-south',
    ])
  })
})

describe('trip ends off land', () => {
  const midspan = project({ lat: 40.7061, lng: -73.9969 })

  it('moves an end on a bridge midspan to the nearest shore within snapToLandM', () => {
    const r = route(planTrip(midspan, PLACES.timesSquare, 'taxi', at(NOON)))
    expect(isOnLand(r.from, world.land)).toBe(true)
    expect(distanceM(r.from, midspan)).toBeLessThanOrEqual(TEST_TRANSIT.snapToLandM + 5)
    expect(r.legs[0]?.from).toEqual(r.from)
    const subway = route(planTrip(PLACES.timesSquare, midspan, 'subway', at(NOON)))
    expect(isOnLand(subway.to, world.land)).toBe(true)
    for (const leg of subway.legs) {
      if (leg.mode === 'walk') expect(world.walkable(leg.from, leg.to)).toBe(true)
    }
  })

  it('refuses an end further out in the water than snapToLandM', () => {
    const hudson = project({ lat: 40.76, lng: -74.015 })
    for (const mode of ['walk', 'subway', 'taxi'] as const) {
      expect(planTrip(hudson, PLACES.timesSquare, mode, at(NOON))).toEqual({
        ok: false,
        error: { code: 'POINT_NOT_REACHABLE', end: 'from' },
      })
      expect(planTrip(PLACES.timesSquare, hudson, mode, at(NOON))).toEqual({
        ok: false,
        error: { code: 'POINT_NOT_REACHABLE', end: 'to' },
      })
    }
  })

  it('leaves ends on land where they are', () => {
    const r = route(planTrip(PLACES.timesSquare, PLACES.unionSquare, 'walk', at(NOON)))
    expect(r.from).toEqual(PLACES.timesSquare)
    expect(r.to).toEqual(PLACES.unionSquare)
  })
})

describe('drawn subway paths', () => {
  it('stay on the line and match the ride distance on 200 seeded random station pairs', () => {
    const rng = createRng(55)
    const paths = new Map(
      subway.lines.map((line) => [line.id, line.paths.map((p) => decodePath(p))] as const),
    )
    let checked = 0
    for (let i = 0; i < 200; i++) {
      const a = network.stations[Math.floor(rng.next() * network.stations.length)]
      const b = network.stations[Math.floor(rng.next() * network.stations.length)]
      if (a === undefined || b === undefined || distanceM(a, b) < 1000) continue
      const result = planTrip(a, b, 'subway', at(NOON))
      if (!result.ok) continue
      for (const leg of subwayLegs(result.route)) {
        checked++
        const drawn = measurePath(leg.polyline).lengthM
        expect(Math.abs(drawn - leg.distanceM), leg.lineId).toBeLessThanOrEqual(0.01 * drawn + 1)
        const linePaths = paths.get(leg.lineId) ?? []
        for (const vertex of leg.polyline) {
          const off = Math.min(...linePaths.map((p) => distanceToPolyline(vertex, p)))
          expect(off, `${leg.lineId} vertex off the track`).toBeLessThanOrEqual(
            TEST_TRANSIT.subway.stationSnapM,
          )
        }
      }
    }
    expect(checked).toBeGreaterThan(150)
  })
})
