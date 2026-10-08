/**
 * Edge cases and whole-network sweeps for S08 transit (bug-hunter): routing invariants on the
 * real lines, reachability of every place the game uses, the water test on degenerate
 * segments, money and clock boundaries, and the animation timeline on odd input.
 */
import { describe, expect, it } from 'vitest'
import landmarksJson from '@data/landmarks/landmarks.json'
import venuesJson from '@data/venues/venues.json'
import zonesJson from '@data/zones/zones.derived.json'
import { land, subway } from '@/lib/data/geo'
import { encodeRing } from '@/lib/geo/codec'
import { distanceM, project, type LocalPoint } from '@/lib/geo/projection'
import { engineConfig, type EngineConfig } from '../config'
import { initialSnapshot, type GameSnapshot } from '../game'
import { createRng, type Rng } from '../rng'
import { transitConfig, type TransitConfig } from './config'
import { buildLandMask, longestWaterRunM } from './land'
import {
  isRushHour,
  planAllModes,
  planTrip,
  type PlanContext,
  type PlanResult,
  type Route,
  type SubwayLeg,
  type TravelMode,
} from './plan'
import { locateOnPath, measurePath } from './polyline'
import { NOON, PLACES, TEST_TRANSIT, allLandWorld, testWorld } from './test-fixtures'
import { createTimeline } from './timeline'
import { rollSubwayDelay, travel, type TravelRequest, type TravelResult } from './travel'
import { buildTransitWorld } from './world'

const world = testWorld()
const network = world.network
const at = (minuteOfDay: number, config: TransitConfig = TEST_TRANSIT): PlanContext => ({
  config,
  minuteOfDay,
  world,
})

function route(result: PlanResult): Route {
  if (!result.ok) throw new Error(`expected a route, got ${result.error.code}`)
  return result.route
}

const trains = (r: Route) => r.legs.filter((leg): leg is SubwayLeg => leg.mode === 'subway')

/** A point 20 m north-east of a station, so trips start off the platform itself. */
function nearStation(id: string): LocalPoint {
  const station = network.stations.find((s) => s.id === id)
  if (station === undefined) throw new Error(`no station ${id}`)
  return { x: station.x + 20, y: station.y + 20 }
}

/** Seeded random pairs of stations, ends at least 1 km apart. */
function stationPairs(count: number, seed: number): [LocalPoint, LocalPoint][] {
  const rng = createRng(seed)
  const pick = () => network.stations[Math.floor(rng.next() * network.stations.length)]
  const pairs: [LocalPoint, LocalPoint][] = []
  while (pairs.length < count) {
    const a = pick()
    const b = pick()
    if (a === undefined || b === undefined || distanceM(a, b) < 1000) continue
    pairs.push([
      { x: a.x + 15, y: a.y - 15 },
      { x: b.x - 15, y: b.y + 15 },
    ])
  }
  return pairs
}

/** Every structural promise a subway route makes, checked on one route. */
function expectWellFormedSubway(r: Route) {
  const legs = r.legs
  expect(legs[0]?.mode).toBe('walk')
  expect(legs[legs.length - 1]?.mode).toBe('walk')
  expect(legs[0]?.from).toEqual(r.from)
  expect(legs[legs.length - 1]?.to).toEqual(r.to)
  for (let i = 1; i < legs.length; i++) {
    // Legs chain end to end: no teleport between them.
    expect(legs[i]?.from, `leg ${i} starts where leg ${i - 1} ends`).toEqual(legs[i - 1]?.to)
  }
  const rides = trains(r)
  expect(rides.length).toBeGreaterThan(0)
  expect(r.transfers).toBe(rides.length - 1)
  for (let i = 0; i < rides.length; i++) {
    const leg = rides[i]
    if (leg === undefined) continue
    const start = leg.polyline[0]
    const end = leg.polyline[leg.polyline.length - 1]
    if (start === undefined || end === undefined) throw new Error('empty polyline')
    // Oriented from the boarding station to the alighting station, on any branch.
    expect(distanceM(start, leg.from), `${leg.lineId} start`).toBeLessThan(15)
    expect(distanceM(end, leg.to), `${leg.lineId} end`).toBeLessThan(15)
    // The drawn path is the ride itself: a reversed piece, or a jump between two stops' pieces
    // of track (the avatar teleporting off the ribbon), makes it longer than the ride.
    expect(
      measurePath(leg.polyline).lengthM - leg.distanceM,
      `${leg.lineId} ${leg.fromStationId}>${leg.toStationId} drawn path vs ride`,
    ).toBeLessThan(15)
    // Never "change" to the same line (a walking transfer between two of its stations).
    if (i > 0) expect(leg.lineId, 'consecutive trains share a line').not.toBe(rides[i - 1]?.lineId)
  }
  for (const leg of legs) {
    if (leg.mode === 'walk') expect(world.walkable(leg.from, leg.to)).toBe(true)
  }
  const sum = legs.reduce((total, leg) => total + leg.minutes, 0)
  expect(r.durationMin).toBe(Math.ceil(Math.round(sum * 1e6) / 1e6))
}

describe('subway routing on branched lines', () => {
  it.each([
    ['A: Lefferts Blvd to Far Rockaway', 'a65', 'h11', 'a'],
    ['A: Far Rockaway to Lefferts Blvd', 'h11', 'a65', 'a'],
    ['A: Inwood to Far Rockaway', 'a02', 'h11', 'a'],
    ['A/S: Rockaway Park to Far Rockaway', 'h15', 'h11', undefined],
    ['5: Eastchester-Dyre Av to Nereid Av', '501', '204', '5'],
    ['5: Eastchester-Dyre Av to Flatbush Av', '501', '247', undefined],
    ['R: Bay Ridge-95 St to Forest Hills', 'r45', 'g08', undefined],
  ] as const)('%s rides correctly oriented sub-paths', (_name, fromId, toId, onlyLine) => {
    const r = route(planTrip(nearStation(fromId), nearStation(toId), 'subway', at(NOON)))
    expectWellFormedSubway(r)
    const rides = trains(r)
    expect(rides[0]?.fromStationId).toBe(fromId)
    expect(rides[rides.length - 1]?.toStationId).toBe(toId)
    if (onlyLine !== undefined) expect(rides.map((leg) => leg.lineId)).toEqual([onlyLine])
  })

  it('keeps every invariant on 150 seeded random station pairs', () => {
    let routed = 0
    for (const [from, to] of stationPairs(150, 8)) {
      const result = planTrip(from, to, 'subway', at(NOON))
      if (!result.ok) {
        // Only Staten Island is cut off from the rest of the network.
        expect(result.error.code).toBe('NO_SUBWAY_ROUTE')
        continue
      }
      routed++
      expectWellFormedSubway(result.route)
    }
    expect(routed).toBeGreaterThan(120)
  })

  it('refuses a subway trip whose two ends share their nearest station', () => {
    const times = nearStation('127')
    const result = planTrip(times, { x: times.x - 70, y: times.y }, 'subway', at(NOON))
    expect(result).toEqual({ ok: false, error: { code: 'NO_SUBWAY_ROUTE' } })
  })

  it('reaches Times Square by subway from every station off Staten Island', () => {
    const failures: string[] = []
    for (const station of subway.stations) {
      if (station.borough === 'staten-island') continue
      const from = { x: station.x + 15, y: station.y + 15 }
      if (distanceM(from, PLACES.timesSquare) < 1000) continue
      const result = planTrip(from, PLACES.timesSquare, 'subway', at(NOON))
      if (!result.ok) failures.push(`${station.id} ${result.error.code}`)
    }
    expect(failures).toEqual([])
  })
})

describe('reaching every place by taxi (bridges and tunnels in config)', () => {
  const taxiTo = (from: LocalPoint, to: LocalPoint) => planTrip(from, to, 'taxi', at(NOON))
  const crossingIds = (r: Route) =>
    r.legs.flatMap((leg) => (leg.mode === 'taxi' ? leg.crossingIds : []))

  // An inherently heavy sweep (~60 taxi plans across water, 5–10 ms each), not load masking.
  it('drives to Times Square from every tenth station, the Rockaways and Roosevelt Island', () => {
    const sample = subway.stations.filter(
      (station, i) => i % 10 === 0 || station.id.startsWith('h') || station.id === 'b06',
    )
    const failures = sample.flatMap((station) => {
      const result = taxiTo({ x: station.x, y: station.y }, PLACES.timesSquare)
      return result.ok ? [] : [`${station.id} ${station.name}: ${result.error.code}`]
    })
    expect(failures).toEqual([])
  }, 30_000)

  // Inherently heavy like the sweep above: one taxi plan per zone (71, ~0.75 s unloaded), so the
  // default 5 s limit trips when the machine is busy. The limit is not hiding a slow planner.
  it('drives to Times Square from every zone centroid', () => {
    const failures = zonesJson.zones.flatMap((zone) => {
      const result = taxiTo(zone.centroid, PLACES.timesSquare)
      return result.ok ? [] : [`${zone.id} ${zone.name}: ${result.error.code}`]
    })
    expect(failures).toEqual([])
  }, 30_000)

  it('drives along the Rockaway peninsula (Far Rockaway to Rockaway Park)', () => {
    const r = route(taxiTo(nearStation('h11'), nearStation('h15')))
    expect(r.legs[0]?.distanceM).toBeLessThan(2 * distanceM(r.from, r.to))
  })

  it('drives from the Rockaways to the Bronx over at least three crossings', () => {
    const rockawayPark = project({ lat: 40.5805, lng: -73.835 })
    const pelhamBay = project({ lat: 40.852, lng: -73.828 })
    const r = route(taxiTo(rockawayPark, pelhamBay))
    expect(crossingIds(r).length).toBeGreaterThanOrEqual(3)
  })

  it('drives Broad Channel to Howard Beach over the Cross Bay bridge without a long detour', () => {
    const broadChannel = project({ lat: 40.6083, lng: -73.816 })
    const howardBeach = project({ lat: 40.66, lng: -73.83 })
    const r = route(taxiTo(broadChannel, howardBeach))
    expect(crossingIds(r)).toEqual(['cross-bay-bridge-north'])
    expect(r.legs[0]?.distanceM).toBeLessThan(2 * distanceM(broadChannel, howardBeach))
  })

  it('handles Marble Hill (Manhattan on the Bronx mainland) and Randalls Island', () => {
    const marbleHill = project({ lat: 40.8762, lng: -73.9105 })
    const kingsbridge = project({ lat: 40.8785, lng: -73.9045 })
    const inwood = project({ lat: 40.869, lng: -73.916 })
    // Marble Hill walks to the Bronx, but not across the Harlem River to Inwood.
    expect(planTrip(marbleHill, kingsbridge, 'walk', at(NOON)).ok).toBe(true)
    expect(planTrip(marbleHill, inwood, 'walk', at(NOON))).toEqual({
      ok: false,
      error: { code: 'WALK_CROSSES_WATER' },
    })
    expect(crossingIds(route(taxiTo(marbleHill, inwood)))).toEqual(['broadway-bridge'])
    expectWellFormedSubway(route(planTrip(marbleHill, inwood, 'subway', at(NOON))))

    const randalls = project({ lat: 40.793, lng: -73.923 })
    const harlem = project({ lat: 40.805, lng: -73.94 })
    expect(planTrip(randalls, harlem, 'walk', at(NOON)).ok).toBe(false)
    expect(crossingIds(route(taxiTo(randalls, harlem)))).toEqual(['rfk-bridge-manhattan'])
  })

  it('reaches every landmark and venue by some mode from Times Square', () => {
    const places = [
      // Travel goes to a place's route point (S07 contract: approach ?? location).
      ...landmarksJson.landmarks.map(
        (l) =>
          [
            `landmark ${l.id}`,
            project('approach' in l && l.approach ? l.approach : l.location),
          ] as const,
      ),
      ...venuesJson.venues.map((v) => [`venue ${v.id}`, project(v.location)] as const),
    ]
    const unreachable = places.flatMap(([id, point]) =>
      planAllModes(PLACES.timesSquare, point, at(NOON)).fastest === undefined ? [id] : [],
    )
    expect(unreachable).toEqual([])
  })

  // Orchestrator ruling (S08 fix cycle 1): an end further than transit.snapToLandM from shore is
  // POINT_NOT_REACHABLE for every mode (it was a mode-specific refusal before the ruling).
  it('refuses every mode for a point out in the Hudson (documented behaviour)', () => {
    const hudson = project({ lat: 40.76, lng: -74.015 })
    const options = planAllModes(hudson, PLACES.timesSquare, at(NOON))
    const unreachable = { ok: false, error: { code: 'POINT_NOT_REACHABLE', end: 'from' } }
    expect(options.walk).toEqual(unreachable)
    expect(options.subway).toEqual(unreachable)
    expect(options.taxi).toEqual(unreachable)
    expect(options.fastest).toBeUndefined()
  })
})

describe('water test on degenerate segments', () => {
  const square = buildLandMask({
    boroughs: [
      {
        id: 'sq',
        polygons: [
          [
            encodeRing([
              { x: 0, y: 0 },
              { x: 100, y: 0 },
              { x: 100, y: 100 },
              { x: 0, y: 100 },
            ]),
          ],
        ],
      },
    ],
  })

  it('treats a walk exactly along the shore the same on every side of the island', () => {
    const edges = [
      longestWaterRunM({ x: 0, y: 0 }, { x: 100, y: 0 }, square),
      longestWaterRunM({ x: 100, y: 0 }, { x: 100, y: 100 }, square),
      longestWaterRunM({ x: 100, y: 100 }, { x: 0, y: 100 }, square),
      longestWaterRunM({ x: 0, y: 100 }, { x: 0, y: 0 }, square),
    ]
    // The shore line is the land's edge: no stretch of it is open water.
    expect(edges).toEqual([0, 0, 0, 0])
  })

  it('measures a segment that starts in water and one entirely in water', () => {
    expect(longestWaterRunM({ x: -60, y: 50 }, { x: 50, y: 50 }, square)).toBeCloseTo(60, 6)
    expect(longestWaterRunM({ x: -60, y: 50 }, { x: -10, y: 50 }, square)).toBeCloseTo(50, 6)
    expect(longestWaterRunM({ x: 10, y: 10 }, { x: 10, y: 10 }, square)).toBe(0)
  })
})

/** Fixed stats so these tests do not move when balance.json is tuned. */
const engine: EngineConfig = {
  ...engineConfig,
  startCash: 150,
  stats: {
    max: 100,
    start: { energy: 100, hunger: 80, mood: 70 },
    decayPerGameHour: { energy: 3, hunger: 5, mood: 2 },
    atZero: {
      energy: { extraDecayPerGameHour: { mood: 3 }, durationMultiplier: 1.5 },
      hunger: { extraDecayPerGameHour: { energy: 3, mood: 4 }, durationMultiplier: 1 },
      mood: { extraDecayPerGameHour: {}, durationMultiplier: 1.25 },
    },
  },
}

function snapshotAt(minuteOfDay: number, cash = 150): GameSnapshot {
  const base = initialSnapshot(engine)
  return {
    clock: { minute: 24 * 60 + minuteOfDay, remainderMs: 0 },
    player: { ...base.player, cash },
  }
}

function counting(seed: number): { rng: Rng; draws: () => number } {
  const inner = createRng(seed)
  let draws = 0
  return {
    rng: {
      next: () => {
        draws++
        return inner.next()
      },
      get state() {
        return inner.state
      },
    },
    draws: () => draws,
  }
}

const delays: TransitConfig = {
  ...TEST_TRANSIT,
  delay: { probability: 0.5, rushProbability: 0.9, minutes: { min: 5, max: 20 }, moodDrain: 3 },
}

describe('determinism and random draws', () => {
  const trips: TravelRequest[] = [
    { from: PLACES.coneyIsland, to: PLACES.timesSquare, mode: 'subway' },
    { from: PLACES.timesSquare, to: PLACES.unionSquare, mode: 'walk' },
    { from: PLACES.timesSquare, to: PLACES.flushingMainSt, mode: 'walk' }, // refused: water
    { from: PLACES.unionSquare, to: PLACES.flushingMainSt, mode: 'taxi' },
    { from: PLACES.stGeorge, to: PLACES.timesSquare, mode: 'subway' }, // refused: no route
    { from: PLACES.flushingMainSt, to: PLACES.coneyIsland, mode: 'subway' },
  ]

  function chain(seed: number) {
    const { rng, draws } = counting(seed)
    let snapshot = snapshotAt(7 * 60 + 30)
    const log: { result: TravelResult; draws: number }[] = []
    for (const trip of trips) {
      const before = draws()
      const result = travel(snapshot, trip, { world, rng }, engine, delays)
      log.push({ result, draws: draws() - before })
      if (result.ok) snapshot = result.snapshot
    }
    return log
  }

  it('replays a chain of mixed trips exactly from the same seed', () => {
    expect(chain(99)).toEqual(chain(99))
  })

  it('draws only for subway trips that go: one roll, plus one for the length when delayed', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      chain(seed).forEach(({ result, draws }, index) => {
        const trip = trips[index]
        if (!result.ok || trip?.mode !== 'subway') {
          expect(draws, `trip ${index}`).toBe(0)
          return
        }
        expect(draws).toBe(result.events.length === 0 ? 1 : 2)
      })
    }
  })

  it('refuses with exactly $1 short before any draw, and goes with exact fare cash', () => {
    const subwayTrip = trips[0]
    if (subwayTrip === undefined) throw new Error('no trip')
    const short = counting(1)
    expect(
      travel(snapshotAt(NOON, 2), subwayTrip, { world, rng: short.rng }, engine, delays),
    ).toEqual({ ok: false, error: { code: 'INSUFFICIENT_FUNDS', required: 3, available: 2 } })
    expect(short.draws()).toBe(0)

    const exact = travel(
      snapshotAt(NOON, 3),
      subwayTrip,
      { world, rng: { next: () => 0.99, state: 0 } },
      engine,
      delays,
    )
    if (!exact.ok) throw new Error(exact.error.code)
    expect(exact.snapshot.player.cash).toBe(0)
  })

  it('gives identical plans from two independently built worlds', () => {
    const other = buildTransitWorld({ subway, land }, TEST_TRANSIT)
    for (const [from, to] of stationPairs(25, 3)) {
      const a = planAllModes(from, to, at(NOON))
      const b = planAllModes(from, to, { config: TEST_TRANSIT, minuteOfDay: NOON, world: other })
      expect(b).toEqual(a)
    }
  })
})

describe('rush hour and delays with the shipped balance', () => {
  it.each([
    [6 * 60 + 59, false],
    [7 * 60, true],
    [9 * 60 + 59, true],
    [10 * 60, false],
    [15 * 60 + 59, false],
    [16 * 60, true],
    [18 * 60 + 59, true],
    [19 * 60, false],
  ])('minute %i of the day is rush hour: %s', (minute, rush) => {
    expect(isRushHour(minute, transitConfig)).toBe(rush)
    const r = route(planTrip(PLACES.coneyIsland, PLACES.timesSquare, 'subway', at(minute)))
    expect(r.rushHour).toBe(rush)
  })

  it('delays about the configured share of subway trips, in and out of rush hour', () => {
    const noon = route(planTrip(PLACES.coneyIsland, PLACES.timesSquare, 'subway', at(NOON)))
    const rush = route(planTrip(PLACES.coneyIsland, PLACES.timesSquare, 'subway', at(8 * 60)))
    const share = (r: Route) => {
      let hits = 0
      const n = 4000
      for (let seed = 0; seed < n; seed++) {
        if (rollSubwayDelay(r, createRng(seed), transitConfig).event) hits++
      }
      return hits / n
    }
    expect(Math.abs(share(noon) - transitConfig.delay.probability)).toBeLessThan(0.015)
    expect(Math.abs(share(rush) - transitConfig.delay.rushProbability)).toBeLessThan(0.02)
  })

  it('adds the delay to the first wait only, inside the configured range', () => {
    const r = route(planTrip(PLACES.coneyIsland, PLACES.flushingMainSt, 'subway', at(NOON)))
    expect(trains(r).length).toBeGreaterThanOrEqual(2)
    for (let seed = 0; seed < 200; seed++) {
      const { route: delayed, event } = rollSubwayDelay(r, createRng(seed), delays)
      if (event === undefined) {
        expect(delayed).toBe(r)
        continue
      }
      expect(event.extraMin).toBeGreaterThanOrEqual(delays.delay.minutes.min)
      expect(event.extraMin).toBeLessThanOrEqual(delays.delay.minutes.max)
      const firstTrain = r.legs.findIndex((leg) => leg.mode === 'subway')
      delayed.legs.forEach((leg, index) => {
        const original = r.legs[index]
        if (index !== firstTrain) {
          expect(leg).toBe(original)
          return
        }
        if (leg.mode !== 'subway' || original?.mode !== 'subway') throw new Error('not a train')
        expect(leg.waitMin).toBe(original.waitMin + event.extraMin)
        expect(leg.rideMin).toBe(original.rideMin)
      })
      expect(delayed.durationMin).toBe(r.durationMin + event.extraMin)
    }
  })
})

describe('clock and duration limits', () => {
  it('slows a trip when a stat is at zero, and the timeline spreads the longer time over the legs', () => {
    const tired: GameSnapshot = {
      ...snapshotAt(NOON),
      player: { ...snapshotAt(NOON).player, cash: 150, stats: { energy: 0, hunger: 0, mood: 0 } },
    }
    const trip: TravelRequest = { from: PLACES.coneyIsland, to: PLACES.timesSquare, mode: 'subway' }
    const planned = route(planTrip(trip.from, trip.to, 'subway', at(NOON)))
    const result = travel(
      tired,
      trip,
      { world, rng: { next: () => 0.99, state: 0 } },
      engine,
      TEST_TRANSIT,
    )
    if (!result.ok) throw new Error(result.error.code)
    // All three at zero: 1.5 x 1 x 1.25, rounded up.
    expect(result.durationMin).toBe(Math.ceil(planned.durationMin * 1.5 * 1.25))
    expect(result.snapshot.clock.minute - tired.clock.minute).toBe(result.durationMin)
    expect(result.route.legs).toEqual(planned.legs)
    const timeline = createTimeline(result.route, {
      reducedMotion: false,
      animation: TEST_TRANSIT.animation,
    })
    expect(timeline.frameAt(timeline.durationMs - 1).gameMinutes).toBeLessThanOrEqual(
      result.durationMin,
    )
    expect(timeline.frameAt(timeline.durationMs).gameMinutes).toBe(result.durationMin)
  })

  it('plans a walk longer than a day but refuses to take it (TRIP_TOO_LONG), changing nothing', () => {
    const far: TravelRequest = { from: { x: 0, y: 0 }, to: { x: 90_000, y: 0 }, mode: 'walk' }
    const planned = route(
      planTrip(far.from, far.to, 'walk', {
        config: TEST_TRANSIT,
        minuteOfDay: NOON,
        world: allLandWorld(),
      }),
    )
    expect(planned.durationMin).toBeGreaterThan(engine.actions.maxDurationMin)
    const result = travel(
      snapshotAt(NOON),
      far,
      { world: allLandWorld(), rng: { next: () => 0, state: 0 } },
      engine,
      TEST_TRANSIT,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    // Orchestrator ruling (S08 fix cycle 1): a specific error instead of the generic INVALID_ACTION.
    expect(result.error.code).toBe('TRIP_TOO_LONG')
  })
})

describe('timeline on odd routes', () => {
  const animation = TEST_TRANSIT.animation
  const motion = { reducedMotion: false, animation }
  const origin = { x: 0, y: 0 }
  const zeroRoute: Route = {
    mode: 'walk',
    from: origin,
    to: { x: 30, y: 0 },
    legs: [
      {
        mode: 'walk',
        from: origin,
        to: { x: 30, y: 0 },
        distanceM: 30,
        minutes: 0,
        polyline: [origin, { x: 30, y: 0 }],
      },
    ],
    durationMin: 0,
    fare: 0,
    transfers: 0,
    walkedM: 39,
    rushHour: false,
  }

  it('cuts to the arrival for a zero-minute trip', () => {
    const timeline = createTimeline(zeroRoute, motion)
    expect(timeline.durationMs).toBe(0)
    expect(timeline.frameAt(0)).toMatchObject({ point: zeroRoute.to, done: true, gameMinutes: 0 })
  })

  it('gives a zero-minute leg an empty span and never shows it mid-trip', () => {
    const r = route(planTrip(PLACES.coneyIsland, PLACES.timesSquare, 'subway', at(NOON)))
    const first = r.legs[0]
    if (first === undefined) throw new Error('no leg')
    const withZero: Route = { ...r, legs: [{ ...first, minutes: 0 }, ...r.legs.slice(1)] }
    const timeline = createTimeline(withZero, motion)
    expect(timeline.legs[0]).toEqual({ startMs: 0, endMs: 0 })
    expect(timeline.frameAt(0).legIndex).toBe(1)
  })

  it('answers a NaN time with the arrival', () => {
    const r = route(planTrip(PLACES.coneyIsland, PLACES.timesSquare, 'subway', at(NOON)))
    expect(createTimeline(r, motion).frameAt(Number.NaN)).toMatchObject({ done: true, point: r.to })
  })

  it('rejects a route whose duration is not a number instead of producing a NaN animation', () => {
    const r = route(planTrip(PLACES.coneyIsland, PLACES.timesSquare, 'subway', at(NOON)))
    let durationMs: number | undefined
    try {
      durationMs = createTimeline({ ...r, durationMin: Number.NaN }, motion).durationMs
    } catch {
      return // rejecting by throwing is fine
    }
    expect(Number.isFinite(durationMs)).toBe(true)
  })

  it('stays within the cap and moves forward along each leg on 30 random trips', () => {
    const modes: TravelMode[] = ['walk', 'subway', 'taxi']
    stationPairs(30, 21).forEach(([from, to], i) => {
      const result = planTrip(from, to, modes[i % 3] ?? 'subway', at(NOON))
      if (!result.ok) return
      const r = result.route
      const timeline = createTimeline(r, motion)
      expect(timeline.durationMs).toBeLessThanOrEqual(animation.maxMs)
      let last = { legIndex: -1, arcM: 0, gameMinutes: 0 }
      for (let t = 0; t <= timeline.durationMs; t += 20) {
        const frame = timeline.frameAt(t)
        expect(frame.gameMinutes).toBeGreaterThanOrEqual(last.gameMinutes)
        expect(frame.legIndex).toBeGreaterThanOrEqual(last.legIndex)
        const leg = r.legs[frame.legIndex]
        if (leg === undefined || frame.done) break
        const { arcM } = locateOnPath(frame.point, measurePath(leg.polyline))
        if (frame.legIndex === last.legIndex) expect(arcM).toBeGreaterThanOrEqual(last.arcM - 1)
        last = { legIndex: frame.legIndex, arcM, gameMinutes: frame.gameMinutes }
      }
      expect(createTimeline(r, { ...motion, reducedMotion: true }).durationMs).toBe(0)
    })
  })
})

describe('no MTA branding', () => {
  it('labels lines with plain short text and carries no colours', () => {
    for (const [id, label] of network.lineLabels) {
      expect(label, id).toMatch(/^[0-9A-Z]{1,3}$/)
    }
    expect(JSON.stringify(subway)).not.toMatch(/colou?r|#[0-9a-f]{6}\b/i)
  })

  it('puts no station names in a route (only ids)', () => {
    const r = route(planTrip(PLACES.coneyIsland, PLACES.flushingMainSt, 'subway', at(NOON)))
    const names = new Set(subway.stations.map((s) => s.name))
    const text = JSON.stringify(r)
    for (const name of names) expect(text.includes(`"${name}"`), name).toBe(false)
  })
})

describe('performance on this machine', () => {
  it('builds the whole world (network, land mask, crossings) in well under a second', () => {
    const start = performance.now()
    buildTransitWorld({ subway, land }, transitConfig)
    expect(performance.now() - start).toBeLessThan(500)
  })

  it('plans all three modes for a trip in under 25 ms on average', () => {
    const pairs = stationPairs(100, 77)
    const start = performance.now()
    for (const [from, to] of pairs) planAllModes(from, to, at(NOON))
    expect((performance.now() - start) / pairs.length).toBeLessThan(25)
  })
})
