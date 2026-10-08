/**
 * One landmark model, built for one quality tier: a list of LOD levels, each at most three
 * meshes (body, windows, outline) drawn with the shared landmark materials. Pure and
 * deterministic: the same inputs give the same geometry, vertex for vertex.
 *
 * Geometry is in scene orientation around the anchor: rotated by -headingDeg about y (so the
 * model's front, -z, points along the heading, clockwise from north) with absolute heights
 * (buildings stand on the land top, bridge piers on the water plane at y = 0). The caller
 * places each level at the anchor (x, 0, -y).
 */
import type { BufferGeometry } from 'three'
import type { QualityTier } from '@/lib/data/schemas/config'
import type { LandmarkFrame, LandmarkModel } from '@/lib/data/schemas/landmarkModels'
import { modelBase } from '@/lib/landmarks/metrics'
import { ARCHETYPE_BUILDERS } from './archetypes'
import { compose, triangleCount } from './kit/compose'
import { buildOutline } from './kit/outline'
import type { ArchetypeFrame, LandmarkPalette, LodLevel, Part } from './types'

/** Levels per tier, finest first: the low tier never builds L0. */
export const TIER_LEVELS: Readonly<Record<QualityTier, readonly LodLevel[]>> = {
  low: [1, 2],
  mid: [0, 1, 2],
  high: [0, 1, 2],
}

export type LandmarkMaterialKey = 'body' | 'windows' | 'outline'

/** scene.json `landmarks` plus the land top, as the mount resolves them. */
export interface LandmarkBuildSettings {
  /** Scene y of the land top (S04a: land heightM - baseM). */
  readonly landTopY: number
  readonly heightScale: number
  readonly outlineWidthM: number
  readonly outline: Readonly<Record<QualityTier, boolean>>
  readonly windows: Readonly<Record<QualityTier, boolean>>
}

export interface LandmarkLevelMeshes {
  readonly level: LodLevel
  readonly body: BufferGeometry
  readonly windows?: BufferGeometry
  readonly outline?: BufferGeometry
}

export interface BuiltLandmark {
  readonly id: string
  /** Finest first. */
  readonly levels: readonly LandmarkLevelMeshes[]
  /** Triangles per level (every mesh of the level), finest first. */
  readonly triangles: readonly number[]
  readonly materialsUsed: readonly LandmarkMaterialKey[]
  /** Reserved for later landmark effects; memorials (S07b) keep it empty. */
  readonly effects: readonly []
}

function archetypeParts(model: LandmarkModel, level: LodLevel, frame: ArchetypeFrame): Part[] {
  switch (model.archetype) {
    case 'civicHall':
      return ARCHETYPE_BUILDERS.civicHall(model.params, level, frame)
    case 'stationConcourse':
      return ARCHETYPE_BUILDERS.stationConcourse(model.params, level, frame)
    case 'setbackSpire':
      return ARCHETYPE_BUILDERS.setbackSpire(model.params, level, frame)
    case 'terminalHall':
      return ARCHETYPE_BUILDERS.terminalHall(model.params, level, frame)
    case 'wedgeTower':
      return ARCHETYPE_BUILDERS.wedgeTower(model.params, level, frame)
    case 'suspensionBridge':
      return ARCHETYPE_BUILDERS.suspensionBridge(model.params, level, frame)
    case 'cantileverBridge':
      return ARCHETYPE_BUILDERS.cantileverBridge(model.params, level, frame)
  }
}

/** Stretches heights about the model's base; a no-op at the default scale of 1. */
function scaleHeights(parts: readonly Part[], baseY: number, heightScale: number): void {
  if (heightScale === 1) return
  for (const { geometry } of parts) {
    geometry.translate(0, -baseY, 0).scale(1, heightScale, 1).translate(0, baseY, 0)
    geometry.computeVertexNormals()
  }
}

export function buildLandmark(
  model: LandmarkModel,
  frame: LandmarkFrame,
  tier: QualityTier,
  palette: LandmarkPalette,
  settings: LandmarkBuildSettings,
): BuiltLandmark {
  if (frame.id !== model.id) throw new Error(`buildLandmark: frame ${frame.id} for ${model.id}`)
  const isBridge = modelBase(model) === 'water'
  if (isBridge && frame.spanM === undefined) {
    throw new Error(`buildLandmark: bridge ${model.id} has no span`)
  }
  const archetypeFrame: ArchetypeFrame = {
    landTopY: settings.landTopY,
    spanM: frame.spanM ?? 0,
  }
  const rotation = (-frame.headingDeg * Math.PI) / 180
  const baseY = isBridge ? 0 : settings.landTopY

  const levels = TIER_LEVELS[tier].map((level): LandmarkLevelMeshes => {
    const finest = level === 0
    const withWindows = finest && settings.windows[tier]
    const parts = archetypeParts(model, level, archetypeFrame).filter(
      (part) => withWindows || part.group !== 'windows',
    )
    scaleHeights(parts, baseY, settings.heightScale)
    const outline =
      finest && settings.outline[tier] ? buildOutline(parts, settings.outlineWidthM) : undefined
    const { body, windows } = compose(parts, palette)
    for (const geometry of [body, windows, outline]) geometry?.rotateY(rotation)
    return {
      level,
      body,
      ...(windows === undefined ? {} : { windows }),
      ...(outline === undefined ? {} : { outline }),
    }
  })

  const materialsUsed: LandmarkMaterialKey[] = ['body']
  if (levels.some((level) => level.windows !== undefined)) materialsUsed.push('windows')
  if (levels.some((level) => level.outline !== undefined)) materialsUsed.push('outline')
  return {
    id: model.id,
    levels,
    triangles: levels.map(
      (level) =>
        triangleCount(level.body) + triangleCount(level.windows) + triangleCount(level.outline),
    ),
    materialsUsed,
    effects: [],
  }
}

/** Frees every geometry of a built landmark. */
export function disposeLandmark(built: BuiltLandmark): void {
  for (const level of built.levels) {
    level.body.dispose()
    level.windows?.dispose()
    level.outline?.dispose()
  }
}
