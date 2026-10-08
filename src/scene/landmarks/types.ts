/**
 * Types shared by the landmark model kit. The kit is three only: no React, no config loaders.
 * Its inputs (models, frames, palette, settings) are plain data the scene mount resolves on the
 * server and passes in.
 */
import type { BufferGeometry } from 'three'
import type { LandmarkRole } from '@/lib/data/schemas/landmarkModels'

/** Level of detail: L0 finest, L2 a silhouette of a few blocks. */
export type LodLevel = 0 | 1 | 2

/** Which mesh of a level a part ends up in. */
export type PartGroup = 'body' | 'windows'

/**
 * One piece of a model: non-indexed triangles with flat normals and no uvs, in model space
 * (x across the front, y up, the front facing -z), painted with one palette role.
 */
export interface Part {
  readonly geometry: BufferGeometry
  readonly role: LandmarkRole
  readonly group: PartGroup
  /** Whether the part casts an inverted-hull outline (thin cables and windows do not). */
  readonly outline: boolean
}

/** Hex colour (`#rrggbb`) per role, resolved from theme.json tokens by the server. */
export type LandmarkPalette = Readonly<Record<LandmarkRole, string>>

/** What an archetype needs to know about where it stands. */
export interface ArchetypeFrame {
  /** Scene y of the land top: buildings stand on it and bridge decks meet it at their ends. */
  readonly landTopY: number
  /** A bridge's length between its ends (0 for anything else). */
  readonly spanM: number
}
