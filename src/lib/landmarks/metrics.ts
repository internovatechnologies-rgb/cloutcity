/**
 * Measurements of a landmark model taken from its parameters alone, shared by the geo build
 * (pin lift and exclusion rectangle in data/landmarks/frames.derived.json) and the model kit
 * (src/scene/landmarks), so the two can never disagree about how tall or wide a model is.
 *
 * Model space: x across the front (right), z along the heading (the front faces -z), y up.
 * Every non-bridge model is centred on its anchor; a bridge runs along z between its ends.
 *
 * Imports types only, so Node can load it from scripts/ with its built-in type stripping.
 */
import type { LandmarkModel } from '../data/schemas/landmarkModels.ts'

/** What a model stands on: the land top, or (bridge piers) the water plane. */
export function modelBase(model: LandmarkModel): 'land' | 'water' {
  return model.archetype === 'suspensionBridge' || model.archetype === 'cantileverBridge'
    ? 'water'
    : 'land'
}

/** Height of the model's top above its base, before the scene's height scale. */
export function modelTopM(model: LandmarkModel): number {
  switch (model.archetype) {
    case 'civicHall': {
      const p = model.params
      return Math.max(
        p.heightM + (p.cupola === undefined ? 0 : p.cupola.drumHeightM + p.cupola.domeHeightM),
        // The pediment crowns the portico.
        p.portico.heightM + (p.pediment?.heightM ?? 0),
        p.wings?.heightM ?? 0,
      )
    }
    case 'stationConcourse': {
      const p = model.params
      return Math.max(p.hall?.heightM ?? 0, p.canopy.heightM, p.pavilions.heightM)
    }
    case 'setbackSpire': {
      const p = model.params
      return p.tiers.reduce((sum, tier) => sum + tier.heightM, 0) + p.spire.heightM
    }
    case 'terminalHall':
      return Math.max(model.params.heightM + model.params.roof.heightM, model.params.wings.heightM)
    case 'wedgeTower':
      return model.params.heightM
    case 'suspensionBridge':
      return model.params.towers.heightM
    case 'cantileverBridge':
      return model.params.piers.heightM
  }
}

/**
 * Half extents of the model's footprint, symmetric about its anchor: `halfLengthM` along the
 * heading (z), `halfWidthM` across it (x). A bridge's length is its span (from the frame).
 */
export function modelHalfExtents(
  model: LandmarkModel,
  spanM = 0,
): { halfLengthM: number; halfWidthM: number } {
  switch (model.archetype) {
    case 'civicHall': {
      const p = model.params
      return {
        halfLengthM: Math.max(p.depthM / 2 + p.portico.depthM, (p.wings?.depthM ?? 0) / 2),
        halfWidthM: p.widthM / 2 + (p.wings?.widthM ?? 0),
      }
    }
    case 'stationConcourse': {
      const layout = stationLayout(model.params)
      return { halfLengthM: layout.totalDepthM / 2, halfWidthM: layout.totalWidthM / 2 }
    }
    case 'setbackSpire':
      return { halfLengthM: model.params.depthM / 2, halfWidthM: model.params.widthM / 2 }
    case 'terminalHall': {
      const p = model.params
      return {
        halfLengthM: Math.max(p.depthM, p.wings.depthM) / 2,
        halfWidthM: p.widthM / 2 + p.wings.widthM,
      }
    }
    case 'wedgeTower': {
      const p = model.params
      return {
        halfLengthM: p.lengthM / 2 + p.podiumOutsetM,
        halfWidthM: p.baseWidthM / 2 + p.podiumOutsetM,
      }
    }
    case 'suspensionBridge':
      return { halfLengthM: spanM / 2, halfWidthM: model.params.towers.widthM / 2 }
    case 'cantileverBridge':
      return { halfLengthM: spanM / 2, halfWidthM: model.params.piers.widthM / 2 }
  }
}

type StationParams = Extract<LandmarkModel, { archetype: 'stationConcourse' }>['params']

/**
 * A station's plan: the front row (pavilions with the canopy between them) along -z, the
 * optional hall behind it, the whole centred on the anchor.
 */
export function stationLayout(p: StationParams): {
  totalWidthM: number
  totalDepthM: number
  /** z of the front row's centre line. */
  rowZ: number
  /** z of the hall's centre (when there is one). */
  hallZ: number
  /** x of each pavilion's centre. */
  pavilionXs: number[]
} {
  const rowDepthM = Math.max(p.canopy.widthM, p.pavilions.depthM)
  const hallDepthM = p.hall?.depthM ?? 0
  const totalDepthM = rowDepthM + hallDepthM
  const rowWidthM = (p.pavilions.count - 1) * p.pavilions.spacingM + p.pavilions.widthM
  const totalWidthM = Math.max(rowWidthM, p.canopy.lengthM, p.hall?.widthM ?? 0)
  const first = (-(p.pavilions.count - 1) * p.pavilions.spacingM) / 2
  return {
    totalWidthM,
    totalDepthM,
    rowZ: -totalDepthM / 2 + rowDepthM / 2,
    hallZ: totalDepthM / 2 - hallDepthM / 2,
    pavilionXs: Array.from(
      { length: p.pavilions.count },
      (_, i) => first + i * p.pavilions.spacingM,
    ),
  }
}
