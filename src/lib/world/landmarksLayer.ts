/**
 * The `landmarks` layer of GET /geo/base (S07a): every modelled landmark's model parameters
 * (data/landmarks/models.json) and its placement (data/landmarks/frames.derived.json, from
 * LION), plus whether it stands on "expanding soon" land and is drawn as a dimmed teaser. Built
 * on the server at build time from validated data, so the 3D chunk needs no data loader and no
 * classic zod. The models carry no names or text (LEGAL-1): name chips take their text from
 * the server's copy (src/scene/CityScene.tsx).
 */
import framesJson from '@data/landmarks/frames.derived.json'
import modelsJson from '@data/landmarks/models.json'
import { scene } from '@/lib/data/config'
import { landmarks } from '@/lib/data/content'
import { parseDataFile } from '@/lib/data/parse'
import type { Borough, Landmark } from '@/lib/data/schemas/content'
import {
  landmarkModelsFileSchemaFor,
  type LandmarkFrame,
  type LandmarkModel,
} from '@/lib/data/schemas/landmarkModels'
import { LandmarkFramesFileSchema } from '@/lib/data/schemas/world'
import { modelBase } from '@/lib/landmarks/metrics'
import { boroughRenderState } from './places'

export interface LandmarkLayerEntry {
  readonly id: string
  readonly borough: Borough
  /** The landmark's category (landmarks.json): which ones may glow at night (S04f contract). */
  readonly category: Landmark['category']
  /** `teaser`: on "expanding soon" land, drawn with the dimmed material and no windows. */
  readonly style: 'normal' | 'teaser'
  readonly model: LandmarkModel
  readonly frame: LandmarkFrame
}

export interface LandmarksLayer {
  /** Sorted by id, like the frames. */
  readonly models: readonly LandmarkLayerEntry[]
}

const models = parseDataFile(
  'landmarks/models.json',
  landmarkModelsFileSchemaFor(landmarks),
  modelsJson,
).models
const frames = parseDataFile(
  'landmarks/frames.derived.json',
  LandmarkFramesFileSchema,
  framesJson,
).landmarks

export function buildLandmarksLayer(): LandmarksLayer {
  const frameOf = new Map(frames.map((frame) => [frame.id, frame]))
  const entries = models.map((model): LandmarkLayerEntry => {
    const frame = frameOf.get(model.id)
    if (frame === undefined) throw new Error(`landmarks layer: no frame for ${model.id}`)
    const place = landmarks.find((landmark) => landmark.id === model.id)
    if (place === undefined) throw new Error(`landmarks layer: no landmark ${model.id}`)
    const dimmed = boroughRenderState(place.borough).state === 'dimmed'
    return {
      id: model.id,
      borough: place.borough,
      category: place.category,
      style: dimmed ? 'teaser' : 'normal',
      model,
      frame,
    }
  })
  return { models: entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) }
}

/** The layer GET /geo/base serves (built once per server process). */
export const landmarksLayer: LandmarksLayer = buildLandmarksLayer()

/**
 * How far above the land top a modelled landmark's pin floats so it clears the model: the
 * model's top (frames `pinLiftM`, at the scene's height scale) above its base, less the land
 * top for bridges, whose piers stand on the water plane (y = 0). Whole metres, rounded up.
 */
export function landmarkPinLifts(
  layer: LandmarksLayer = landmarksLayer,
  config: Pick<typeof scene, 'land' | 'landmarks'> = scene,
): ReadonlyMap<string, number> {
  const landTop = config.land.heightM - config.land.baseM
  return new Map(
    layer.models.map((entry) => {
      const top = entry.frame.pinLiftM * config.landmarks.heightScale
      const base = modelBase(entry.model) === 'water' ? 0 : landTop
      return [entry.id, Math.max(0, Math.ceil(base + top - landTop))]
    }),
  )
}
