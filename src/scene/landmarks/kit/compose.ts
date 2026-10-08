/**
 * Parts → one body geometry and one windows geometry, each painted per vertex from the parts'
 * palette roles, so a whole level draws with one shared material per mesh.
 */
import { Box3, BufferGeometry, Color, Float32BufferAttribute } from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import type { LandmarkRole } from '@/lib/data/schemas/landmarkModels'
import type { LandmarkPalette, Part, PartGroup } from '../types'

export interface Composed {
  readonly body: BufferGeometry
  readonly windows?: BufferGeometry
  readonly triangles: number
  readonly bounds: Box3
}

/**
 * A role's colour in three's working colour space (linear sRGB): Color converts the palette's
 * sRGB hex because colour management is on, so vertex colours match material colours.
 */
export function roleColor(palette: LandmarkPalette, role: LandmarkRole): Color {
  return new Color(palette[role])
}

function painted(part: Part, palette: LandmarkPalette): BufferGeometry {
  const { r, g, b } = roleColor(palette, part.role)
  const count = part.geometry.getAttribute('position').count
  const colors = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) colors.set([r, g, b], i * 3)
  part.geometry.setAttribute('color', new Float32BufferAttribute(colors, 3))
  return part.geometry
}

function mergeGroup(
  parts: readonly Part[],
  group: PartGroup,
  palette: LandmarkPalette,
): BufferGeometry | undefined {
  const members = parts.filter((part) => part.group === group)
  if (members.length === 0) return undefined
  const merged = mergeGeometries(members.map((part) => painted(part, palette)))
  if (merged === null) throw new Error(`compose: cannot merge the ${group} parts`)
  for (const part of members) part.geometry.dispose()
  return merged
}

export const triangleCount = (geometry: BufferGeometry | undefined): number =>
  geometry === undefined
    ? 0
    : (geometry.index?.count ?? geometry.getAttribute('position').count) / 3

/** Merges parts by group. The parts' own geometries are disposed. */
export function compose(parts: readonly Part[], palette: LandmarkPalette): Composed {
  const body = mergeGroup(parts, 'body', palette)
  if (body === undefined) throw new Error('compose: a model needs at least one body part')
  const windows = mergeGroup(parts, 'windows', palette)
  body.computeBoundingBox()
  const bounds = (body.boundingBox ?? new Box3()).clone()
  return {
    body,
    ...(windows === undefined ? {} : { windows }),
    triangles: triangleCount(body) + triangleCount(windows),
    bounds,
  }
}
