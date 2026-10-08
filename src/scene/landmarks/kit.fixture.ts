/**
 * Test inputs for the landmark kit, from the real data files: models, derived frames, the
 * theme palette and the scene settings. Tests only (it imports the config loaders the kit
 * itself must never import).
 */
import framesJson from '@data/landmarks/frames.derived.json'
import modelsJson from '@data/landmarks/models.json'
import sceneJson from '@data/config/scene.json'
import { theme } from '@/lib/data/config'
import { LANDMARK_ROLES, type LandmarkModel } from '@/lib/data/schemas/landmarkModels'
import { LandmarkFramesFileSchema } from '@/lib/data/schemas/world'
import { LandmarksFileSchema } from '@/lib/data/schemas/content'
import landmarksJson from '@data/landmarks/landmarks.json'
import {
  LandmarkSceneConfigSchema,
  landmarkModelsFileSchemaFor,
} from '@/lib/data/schemas/landmarkModels'
import type { LandmarkBuildSettings } from './buildLandmark'
import type { LandmarkPalette } from './types'

/** S04a's land top (scene.json land.heightM 60 - baseM 30); passed in by the mount. */
export const LAND_TOP_Y = 30

const places = LandmarksFileSchema.parse(landmarksJson).landmarks
export const MODELS: readonly LandmarkModel[] =
  landmarkModelsFileSchemaFor(places).parse(modelsJson).models
export const FRAMES = LandmarkFramesFileSchema.parse(framesJson).landmarks
export const SCENE = LandmarkSceneConfigSchema.parse(sceneJson.landmarks)

export const PALETTE: LandmarkPalette = Object.fromEntries(
  LANDMARK_ROLES.map((role) => {
    const token = theme.scene.landmarks[role]
    const hex = theme.world[token] ?? theme.models[token]
    if (hex === undefined) throw new Error(`no colour for ${role}`)
    return [role, hex]
  }),
) as LandmarkPalette

export const SETTINGS: LandmarkBuildSettings = {
  landTopY: LAND_TOP_Y,
  heightScale: SCENE.heightScale,
  outlineWidthM: SCENE.outlineWidthM,
  outline: SCENE.outline,
  windows: SCENE.windows,
}

export function frameOf(id: string) {
  const frame = FRAMES.find((f) => f.id === id)
  if (frame === undefined) throw new Error(`no frame for ${id}`)
  return frame
}
