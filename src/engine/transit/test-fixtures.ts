/**
 * Shared fixtures for the transit tests only (never import from product code: it loads the
 * classic-zod geo loader). Fixed numbers so the tests do not move when balance.json is tuned.
 */
import { land, subway } from '@/lib/data/geo'
import { encodeRing } from '@/lib/geo/codec'
import { project, type LocalPoint } from '@/lib/geo/projection'
import { transitConfig, type TransitConfig } from './config'
import { buildLandMask } from './land'
import { buildTransitWorld, createTransitWorld, type TransitWorld } from './world'

export const TEST_TRANSIT: TransitConfig = {
  minTripM: 25,
  snapToLandM: 300,
  walk: { speedKmh: 4.8, detourFactor: 1.3, energyPerKm: 2, maxWaterM: 50 },
  taxi: {
    speedKmh: 20,
    detourFactor: 1.3,
    pickupMin: 5,
    baseFare: 3,
    perKm: 2,
    maxWaterM: 50,
    estimateDetourFactor: 3,
  },
  /** The real bridge, tunnel and waypoint lists: tests check routes through them. */
  crossings: transitConfig.crossings,
  roadWaypoints: transitConfig.roadWaypoints,
  subway: {
    speedKmh: 32,
    dwellMinPerStop: 0.5,
    boardWaitMin: 4,
    transferPenaltyMin: 4,
    transferWalkMaxM: 300,
    accessCandidates: 3,
    accessMaxM: 1500,
    stationSnapM: 10,
    pathJoinM: 5,
  },
  rushHour: {
    windows: [
      { startMin: 420, endMin: 600 },
      { startMin: 960, endMin: 1140 },
    ],
    subwayDurationMultiplier: 1.3,
    subwayMoodDrain: 4,
    taxiDurationMultiplier: 1.25,
  },
  delay: { probability: 0, rushProbability: 0, minutes: { min: 5, max: 20 }, moodDrain: 3 },
  animation: { maxMs: 3000, msPerGameMinute: 60 },
  subwayFare: 3,
}

let cached: TransitWorld | undefined

/** The real world from data/geo (subway and land), built once per test file. */
export function testWorld(): TransitWorld {
  cached ??= buildTransitWorld({ subway, land }, TEST_TRANSIT)
  return cached
}

/** A world where everything is land (a 200 km square), for arithmetic tests on made-up points. */
export function allLandWorld(): TransitWorld {
  const square = [
    { x: -100_000, y: -100_000 },
    { x: 100_000, y: -100_000 },
    { x: 100_000, y: 100_000 },
    { x: -100_000, y: 100_000 },
  ]
  const mask = buildLandMask({ boroughs: [{ id: 'all', polygons: [[encodeRing(square)]] }] })
  return createTransitWorld(testWorld().network, mask, TEST_TRANSIT)
}

/** Real places (WGS84), projected to local metres. */
export const PLACES = {
  timesSquare: project({ lat: 40.7553, lng: -73.9869 }),
  bryantPark: project({ lat: 40.7536, lng: -73.9832 }),
  brooklynBridge: project({ lat: 40.7061, lng: -73.9969 }),
  brooklynBridgePark: project({ lat: 40.7003, lng: -73.9967 }),
  unionSquare: project({ lat: 40.7359, lng: -73.9911 }),
  flushingMainSt: project({ lat: 40.7596, lng: -73.8303 }),
  coneyIsland: project({ lat: 40.5774, lng: -73.9811 }),
  stGeorge: project({ lat: 40.6437, lng: -74.0736 }),
} as const satisfies Record<string, LocalPoint>

/** Midday and 8:00 on the personal clock, as minutes of the day. */
export const NOON = 12 * 60
export const EIGHT_AM = 8 * 60
