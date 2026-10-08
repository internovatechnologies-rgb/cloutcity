/**
 * Subway ribbons: every path of every line as one set of screen-space line segments (one draw
 * call), coloured per vertex from our own palette (never MTA colours). three only, no React.
 */
import { Color } from 'three'
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js'
import { decodePath, type DeltaPath } from '@/lib/geo/codec'

export interface SubwayLineInput {
  readonly id: string
  readonly label: string
  readonly paths: readonly DeltaPath[]
}

/**
 * Line id to colour: the palette is cycled over the line ids in sorted order, so the mapping is
 * deterministic and owes nothing to the MTA's trunk colours.
 */
export function lineColors(
  lines: readonly { readonly id: string }[],
  palette: readonly string[],
): Map<string, string> {
  if (palette.length === 0) throw new Error('subway: the line palette is empty')
  const ids = lines.map((line) => line.id).sort()
  return new Map(ids.map((id, index) => [id, palette[index % palette.length] ?? palette[0] ?? '']))
}

export interface SubwaySegments {
  /** (x0, y0, z0, x1, y1, z1) per segment, scene metres. */
  readonly positions: Float32Array
  /** (r0, g0, b0, r1, g1, b1) per segment, linear working colour space. */
  readonly colors: Float32Array
  readonly count: number
}

/** Flattens every line path into segments at height `y`. */
export function subwaySegments(
  lines: readonly SubwayLineInput[],
  colorById: ReadonlyMap<string, string>,
  y: number,
): SubwaySegments {
  const decoded = lines.map((line) => ({ id: line.id, paths: line.paths.map(decodePath) }))
  const count = decoded.reduce(
    (sum, line) => sum + line.paths.reduce((n, path) => n + Math.max(0, path.length - 1), 0),
    0,
  )
  const positions = new Float32Array(count * 6)
  const colors = new Float32Array(count * 6)
  const color = new Color()
  let offset = 0
  for (const line of decoded) {
    const hex = colorById.get(line.id)
    if (hex === undefined) throw new Error(`subway: no colour for line "${line.id}"`)
    color.set(hex)
    for (const path of line.paths) {
      for (let i = 1; i < path.length; i++) {
        const a = path[i - 1]
        const b = path[i]
        if (a === undefined || b === undefined) continue
        positions.set([a.x, y, -a.y, b.x, y, -b.y], offset)
        colors.set([color.r, color.g, color.b, color.r, color.g, color.b], offset)
        offset += 6
      }
    }
  }
  return { positions, colors, count }
}

export function buildSubwayGeometry(segments: SubwaySegments): LineSegmentsGeometry {
  const geometry = new LineSegmentsGeometry()
  geometry.setPositions(segments.positions)
  geometry.setColors(segments.colors)
  return geometry
}
