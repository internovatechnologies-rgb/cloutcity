/**
 * The static stylised map (S04c) served by GET /geo/fallback: simplified borough outlines,
 * parks, a dot per place and the borough names, in the scene palette, as one small SVG. Shown
 * behind the Places panel when the 3D map is unavailable (no WebGL, a failed load, a lost
 * context), so the city stays recognisable while the panel does the work. Server-only: it reads
 * the full geo layers at build time.
 */
import { decodeRing, type DeltaPolygon } from '@/lib/geo/codec'
import { interiorPoint, polygonArea, type Polygon } from '@/lib/geo/polygon'
import type { LocalPoint } from '@/lib/geo/projection'
import { douglasPeucker } from '@/lib/geo/simplify'
import type { SceneConfig } from '@/lib/data/schemas/scene'
import type { LocalBounds } from '@/scene/camera/limits'
import type { BoroughId } from '@/scene/geo/schema'
import type { ScenePalette } from '@/scene/types'
import type { PlacesLayer } from './placesLayer'

export interface FallbackMapInput {
  readonly land: readonly { readonly id: BoroughId; readonly polygons: readonly DeltaPolygon[] }[]
  readonly parks: readonly {
    readonly kind: 'park' | 'cemetery'
    readonly borough: BoroughId
    readonly polygons: readonly DeltaPolygon[]
  }[]
  readonly places: PlacesLayer
  readonly bounds: LocalBounds
  readonly palette: ScenePalette
  readonly config: Pick<SceneConfig, 'fallback' | 'dimmed'>
  /** Display names by borough, and the "expanding soon" line under dimmed boroughs. */
  readonly names: Readonly<Record<BoroughId, string>>
  readonly expandingSoon: string
}

/** Mixes two #rrggbb colours: `t` = 0 is `from`, 1 is `to`. */
export function mixHex(from: string, to: string, t: number): string {
  const channel = (hex: string, at: number) => Number.parseInt(hex.slice(at, at + 2), 16)
  return `#${[1, 3, 5]
    .map((at) =>
      Math.round(channel(from, at) + (channel(to, at) - channel(from, at)) * t)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`
}

function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)
}

/** Local metres to SVG user units (y flipped: north is up), rounded to whole units. */
function toUnits(bounds: LocalBounds, metresPerUnit: number) {
  return (point: LocalPoint): LocalPoint => ({
    x: Math.round((point.x - bounds.minX) / metresPerUnit),
    y: Math.round((bounds.maxY - point.y) / metresPerUnit),
  })
}

/**
 * One SVG path for many polygons: each ring simplified, in relative moves (short numbers gzip
 * well). Polygons under `minAreaM2` and rings that collapse below a triangle are dropped.
 */
function pathData(
  polygons: readonly Polygon[],
  minAreaM2: number,
  toleranceM: number,
  unit: (point: LocalPoint) => LocalPoint,
): string {
  const parts: string[] = []
  for (const polygon of polygons) {
    if (polygonArea(polygon) < minAreaM2) continue
    for (const ring of polygon) {
      const points = douglasPeucker(ring, toleranceM).map(unit)
      const deduped = points.filter(
        (point, i) => i === 0 || point.x !== points[i - 1]?.x || point.y !== points[i - 1]?.y,
      )
      if (deduped.length < 3) continue
      const [first, ...rest] = deduped
      if (first === undefined) continue
      let previous = first
      const moves = rest.map((point) => {
        const move = `${point.x - previous.x} ${point.y - previous.y}`
        previous = point
        return move
      })
      parts.push(`M${first.x} ${first.y}l${moves.join(' ')}z`)
    }
  }
  return parts.join('')
}

/** Same colours as the 3D pins (src/scene/pins/buildPins.ts pinColor). */
function pinFill(pin: PlacesLayer['pins'][number], palette: ScenePalette): string {
  if (pin.style === 'normal') return palette.pins[pin.kind]
  return pin.style === 'teaser' ? palette.pins.teaser : palette.pins.muted
}

const decodePolygon = (polygon: DeltaPolygon): Polygon => polygon.map(decodeRing)

/** The fallback map as an SVG document. Deterministic: the same data gives the same bytes. */
export function buildFallbackSvg(input: FallbackMapInput): string {
  const { bounds, palette, config, places } = input
  const { fallback } = config
  const unit = toUnits(bounds, fallback.metresPerUnit)
  const width = Math.round((bounds.maxX - bounds.minX) / fallback.metresPerUnit)
  const height = Math.round((bounds.maxY - bounds.minY) / fallback.metresPerUnit)
  const dimmed = new Set(
    places.boroughs.filter((borough) => borough.render === 'dimmed').map((b) => b.id),
  )
  const dim = (hex: string) => mixHex(hex, palette.haze, config.dimmed.towardBackground)
  const shape = (polygons: readonly Polygon[], minArea: number) =>
    pathData(polygons, minArea, fallback.toleranceM, unit)

  const body: string[] = [`<rect width="${width}" height="${height}" fill="${palette.water}"/>`]
  for (const borough of input.land) {
    const fill = dimmed.has(borough.id) ? dim(palette.land[borough.id]) : palette.land[borough.id]
    const d = shape(borough.polygons.map(decodePolygon), fallback.minLandAreaM2)
    body.push(`<path fill="${fill}" d="${d}"/>`)
  }
  // Parks on "expanding soon" land are dimmed with it, like in the 3D map.
  for (const isDimmed of [false, true]) {
    for (const kind of ['park', 'cemetery'] as const) {
      const polygons = input.parks
        .filter((park) => park.kind === kind && dimmed.has(park.borough) === isDimmed)
        .flatMap((park) => park.polygons.map(decodePolygon))
      const d = shape(polygons, fallback.minParkAreaM2)
      const fill = isDimmed ? dim(palette[kind]) : palette[kind]
      if (d !== '') body.push(`<path fill="${fill}" d="${d}"/>`)
    }
  }

  const radius = Math.max(1, Math.round(fallback.dotRadiusM / fallback.metresPerUnit))
  for (const pin of places.pins) {
    const at = unit(pin)
    const fill = pinFill(pin, palette)
    body.push(`<circle cx="${at.x}" cy="${at.y}" r="${radius}" fill="${fill}"/>`)
  }

  const size = Math.round(fallback.labelSizeM / fallback.metresPerUnit)
  for (const borough of input.land) {
    const largest = borough.polygons
      .map(decodePolygon)
      .reduce<Polygon | undefined>(
        (best, polygon) =>
          best === undefined || polygonArea(polygon) > polygonArea(best) ? polygon : best,
        undefined,
      )
    if (largest === undefined) continue
    const at = unit(interiorPoint(largest))
    const isDimmed = dimmed.has(borough.id)
    const opacity = isDimmed ? fallback.dimmedLabelOpacity : fallback.labelOpacity
    const lines = [input.names[borough.id], ...(isDimmed ? [input.expandingSoon] : [])]
    const tspans = lines
      .map(
        (line, i) =>
          `<tspan x="${at.x}" dy="${i === 0 ? 0 : Math.round(size * 1.2)}"${i > 0 ? ` font-size="${Math.round(size * 0.7)}"` : ''}>${escapeXml(line)}</tspan>`,
      )
      .join('')
    body.push(
      `<text x="${at.x}" y="${at.y}" font-size="${size}" fill-opacity="${opacity}">${tspans}</text>`,
    )
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">`,
    `<g font-family="ui-sans-serif, system-ui, sans-serif" font-weight="800" text-anchor="middle" fill="${palette.station}">`,
    ...body,
    '</g></svg>',
  ].join('')
}
