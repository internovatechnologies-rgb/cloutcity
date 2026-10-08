/**
 * Line letters: plain chips in our own style (a rounded square in the line's colour with its
 * letter in dark ink, never the MTA's bullets) laid flat on the ground at each line's terminal
 * stations. Every chip tile is a quad in one merged geometry (one draw call) that samples one
 * runtime atlas (labelAtlas.ts). three only, no React.
 */
import { BufferAttribute, BufferGeometry } from 'three'
import { decodePath, type DeltaPath } from '@/lib/geo/codec'
import { LAY_FLAT_X } from './coords'

export interface LabelLineInput {
  readonly id: string
  readonly label: string
  readonly paths: readonly DeltaPath[]
}

export interface LabelStationInput {
  readonly id: string
  readonly x: number
  readonly y: number
  readonly lines: readonly string[]
}

/** The chips at one terminal station: the station's position and its terminating lines. */
export interface TerminalChip {
  readonly stationId: string
  readonly x: number
  readonly y: number
  /** Sorted by label, then id, so "N W" reads the same on every build. */
  readonly lineIds: readonly string[]
}

function nearestStation(
  point: { readonly x: number; readonly y: number },
  candidates: readonly LabelStationInput[],
): LabelStationInput | undefined {
  let best: LabelStationInput | undefined
  let bestDistance = Infinity
  for (const station of candidates) {
    const distance = Math.hypot(station.x - point.x, station.y - point.y)
    if (distance < bestDistance) {
      best = station
      bestDistance = distance
    }
  }
  return best
}

/**
 * Each line's path endpoints, snapped to the nearest station serving that line and grouped by
 * station (lines ending at the same station share one chip row, e.g. N and W at Astoria).
 */
export function terminalChips(
  lines: readonly LabelLineInput[],
  stations: readonly LabelStationInput[],
): TerminalChip[] {
  const labelById = new Map(lines.map((line) => [line.id, line.label]))
  const linesAtStation = new Map<string, Set<string>>()
  for (const line of lines) {
    const serving = stations.filter((station) => station.lines.includes(line.id))
    for (const path of line.paths) {
      const points = decodePath(path)
      for (const end of [points[0], points[points.length - 1]]) {
        if (end === undefined) continue
        const station = nearestStation(end, serving.length > 0 ? serving : stations)
        if (station === undefined) continue
        const set = linesAtStation.get(station.id) ?? new Set<string>()
        set.add(line.id)
        linesAtStation.set(station.id, set)
      }
    }
  }
  const byId = new Map(stations.map((station) => [station.id, station]))
  return [...linesAtStation.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .flatMap(([stationId, ids]) => {
      const station = byId.get(stationId)
      if (station === undefined) return []
      const lineIds = [...ids].sort((a, b) => {
        const la = labelById.get(a) ?? ''
        const lb = labelById.get(b) ?? ''
        if (la !== lb) return la < lb ? -1 : 1
        return a < b ? -1 : a > b ? 1 : 0
      })
      return [{ stationId, x: station.x, y: station.y, lineIds }]
    })
}

/** A square-ish grid of atlas cells, one per line. */
export interface AtlasLayout {
  readonly cols: number
  readonly rows: number
}

export function atlasLayout(cellCount: number): AtlasLayout {
  const cols = Math.max(1, Math.ceil(Math.sqrt(cellCount)))
  return { cols, rows: Math.max(1, Math.ceil(cellCount / cols)) }
}

/** Texture coordinates of one cell; cell 0 is the top-left of the atlas canvas. */
export function cellUv(
  index: number,
  layout: AtlasLayout,
): { u0: number; v0: number; u1: number; v1: number } {
  const col = index % layout.cols
  const row = Math.floor(index / layout.cols)
  // Canvas textures are flipped on upload (flipY), so canvas row 0 is at the top: v = 1.
  return {
    u0: col / layout.cols,
    u1: (col + 1) / layout.cols,
    v0: 1 - (row + 1) / layout.rows,
    v1: 1 - row / layout.rows,
  }
}

export interface ChipSizes {
  readonly chipSizeM: number
  readonly chipGapM: number
  /** Chips sit this far north of their station. */
  readonly offsetM: number
}

/**
 * Every chip tile as a ground-aligned quad (two triangles, facing up, reading north-up) at
 * height `y`. A station's tiles sit side by side, centred east-west on it.
 */
export function buildLabelGeometry(
  chips: readonly TerminalChip[],
  cellIndex: ReadonlyMap<string, number>,
  layout: AtlasLayout,
  sizes: ChipSizes,
  y: number,
): BufferGeometry {
  const tiles = chips.reduce((sum, chip) => sum + chip.lineIds.length, 0)
  const positions = new Float32Array(tiles * 4 * 3)
  const uvs = new Float32Array(tiles * 4 * 2)
  const index = tiles * 4 > 0xffff ? new Uint32Array(tiles * 6) : new Uint16Array(tiles * 6)
  const size = sizes.chipSizeM
  let tile = 0
  for (const chip of chips) {
    const rowWidth = chip.lineIds.length * size + (chip.lineIds.length - 1) * sizes.chipGapM
    const south = chip.y + sizes.offsetM - size / 2
    chip.lineIds.forEach((lineId, i) => {
      const cell = cellIndex.get(lineId)
      if (cell === undefined) throw new Error(`labels: no atlas cell for line "${lineId}"`)
      const west = chip.x - rowWidth / 2 + i * (size + sizes.chipGapM)
      const uv = cellUv(cell, layout)
      // Counter-clockwise in the XY plane (SW, SE, NE, NW) so the quad faces up once laid flat.
      positions.set(
        [
          west,
          south,
          0,
          west + size,
          south,
          0,
          west + size,
          south + size,
          0,
          west,
          south + size,
          0,
        ],
        tile * 12,
      )
      uvs.set([uv.u0, uv.v0, uv.u1, uv.v0, uv.u1, uv.v1, uv.u0, uv.v1], tile * 8)
      const v = tile * 4
      index.set([v, v + 1, v + 2, v, v + 2, v + 3], tile * 6)
      tile++
    })
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(positions, 3))
  geometry.setAttribute('uv', new BufferAttribute(uvs, 2))
  geometry.setIndex(new BufferAttribute(index, 1))
  geometry.rotateX(LAY_FLAT_X)
  geometry.translate(0, y, 0)
  return geometry
}
