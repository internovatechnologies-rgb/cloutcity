/**
 * Everything trip planning needs from /data/geo, built once: the subway graph, the land mask
 * (no walking or driving across open water) and the taxi crossings.
 *
 * The caller passes the derived subway and land files in. The browser should fetch them as
 * static assets; never import the JSON (or src/lib/data/geo.ts) into shell code.
 */
import type { LocalPoint } from '@/lib/geo/projection'
import type { TransitConfig } from './config'
import { buildLandMask, crossesWater, type LandData, type LandMask } from './land'
import {
  buildTransitNetwork,
  type SubwayData,
  type TransitNetwork,
  type WalkableTest,
} from './network'
import { prepareCrossings, type PreparedCrossings } from './taxi'

export interface TransitWorld {
  readonly network: TransitNetwork
  readonly land: LandMask
  readonly crossings: PreparedCrossings
  /** True when the straight walk a→b stays on land (within `walk.maxWaterM`). */
  readonly walkable: WalkableTest
}

export function walkableOn(land: LandMask, config: TransitConfig): WalkableTest {
  return (a: LocalPoint, b: LocalPoint) => !crossesWater(a, b, land, config.walk.maxWaterM)
}

/** Assembles a world from already-built parts (tests use a synthetic land mask). */
export function createTransitWorld(
  network: TransitNetwork,
  land: LandMask,
  config: TransitConfig,
): TransitWorld {
  return {
    network,
    land,
    crossings: prepareCrossings(
      config.crossings,
      config.roadWaypoints,
      land,
      config.taxi.maxWaterM,
    ),
    walkable: walkableOn(land, config),
  }
}

export function buildTransitWorld(
  data: { readonly subway: SubwayData; readonly land: LandData },
  config: TransitConfig,
): TransitWorld {
  const land = buildLandMask(data.land)
  const network = buildTransitNetwork(data.subway, config.subway, walkableOn(land, config))
  return createTransitWorld(network, land, config)
}
