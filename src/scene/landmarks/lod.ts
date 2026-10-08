/**
 * Level-of-detail distances of one landmark for one tier (S07a): scene.json `landmarks.lod`
 * (levels nearest first, then the cull distance), times the tier's lodDistanceScale (S04b),
 * times `bridgeDistanceMultiplier` for bridges, which are long and seen from far away.
 */
import type { QualityTier } from '@/lib/data/schemas/config'
import type { SceneConfig } from '@/lib/data/schemas/scene'

export interface LandmarkLod {
  /** Where each built level starts, nearest first (the first is 0). */
  readonly distances: readonly number[]
  /** Beyond this the landmark is not drawn at all. */
  readonly cullM: number
}

export function landmarkLod(
  config: SceneConfig['landmarks'],
  tier: QualityTier,
  lodDistanceScale: number,
  isBridge: boolean,
): LandmarkLod {
  const factor = lodDistanceScale * (isBridge ? config.bridgeDistanceMultiplier : 1)
  const tierLod = config.lod[tier]
  return {
    distances: tierLod.distancesM.map((distance) => distance * factor),
    cullM: tierLod.cullM * factor,
  }
}
