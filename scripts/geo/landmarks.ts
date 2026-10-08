/**
 * Landmark frames from NYC DCP LION street centerlines: where each modelled landmark stands,
 * which way it faces, and (bridges) where its two ends meet the shore. Pure: parsed inputs in,
 * frame objects out, rounded so the output is byte-stable.
 *
 * - Bridges: the length-weighted principal axis (PCA) of the bridge's main-roadway segments.
 *   Its ends are the extreme segment vertices projected onto the axis; the anchor is their
 *   midpoint; the heading points from the end in the first borough the bridge spans to the
 *   other.
 * - Everything else: the bearing (0-180°) of the nearest segment of the fronting street, turned
 *   by the model's faceDeg; the anchor is the landmark's own location.
 */
import { z } from 'zod'
import type { GeoConfig } from '../../src/lib/data/schemas/config.ts'
import type { LandmarkFrame, LandmarkModel } from '../../src/lib/data/schemas/landmarkModels.ts'
import { modelBase, modelHalfExtents, modelTopM } from '../../src/lib/landmarks/metrics.ts'
import { areaAt, type PreparedArea } from '../../src/lib/geo/lookup.ts'
import { distanceToSegment } from '../../src/lib/geo/polygon.ts'
import { project, type LatLng, type LocalPoint } from '../../src/lib/geo/projection.ts'
import { lionSourceId, type LionSourceId, type LionStreet } from '../../src/lib/geo/sources.ts'

/** The landmarks.json fields the frames need. */
export interface FramePlace {
  readonly id: string
  readonly category: string
  readonly location: LatLng
  readonly spans?: readonly string[]
}

export interface LandmarkFrameInputs {
  /** Parsed LION GeoJSON per source id. */
  readonly lion: ReadonlyMap<LionSourceId, unknown>
  readonly models: readonly LandmarkModel[]
  readonly places: readonly FramePlace[]
}

const Position = z.tuple([z.number(), z.number()]).rest(z.number())
const LionCollectionSchema = z.object({
  type: z.literal('FeatureCollection'),
  // ArcGIS flags a response cut at maxRecordCount; a partial street would skew every frame.
  exceededTransferLimit: z.literal(false).optional(),
  properties: z.object({ exceededTransferLimit: z.literal(false).optional() }).optional(),
  features: z
    .array(
      z.object({
        type: z.literal('Feature'),
        geometry: z.discriminatedUnion('type', [
          z.object({ type: z.literal('LineString'), coordinates: z.array(Position).min(2) }),
          z.object({
            type: z.literal('MultiLineString'),
            coordinates: z.array(z.array(Position).min(2)).min(1),
          }),
        ]),
        properties: z.object({
          Street: z.string(),
          SegmentTyp: z.string(),
          RW_TYPE: z.string(),
        }),
      }),
    )
    .min(1, 'no features: the street is missing from LION'),
})

interface Segment {
  readonly a: LocalPoint
  readonly b: LocalPoint
  readonly segmentType: string
  readonly roadwayType: string
}

function lionSegments(street: LionStreet, json: unknown): Segment[] {
  const parsed = LionCollectionSchema.safeParse(json)
  if (!parsed.success) {
    throw new Error(`Invalid LION ${street}:\n${z.prettifyError(parsed.error)}`)
  }
  const segments: Segment[] = []
  for (const feature of parsed.data.features) {
    const { Street, SegmentTyp, RW_TYPE } = feature.properties
    if (Street !== street) throw new Error(`LION ${street}: unexpected street "${Street}"`)
    const lines =
      feature.geometry.type === 'LineString'
        ? [feature.geometry.coordinates]
        : feature.geometry.coordinates
    for (const line of lines) {
      const points = line.map(([lng, lat]) => project({ lat, lng }))
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1]
        const b = points[i]
        if (a === undefined || b === undefined) continue
        segments.push({ a, b, segmentType: SegmentTyp.trim(), roadwayType: RW_TYPE.trim() })
      }
    }
  }
  return segments
}

/** Clockwise from north, in [0, 360). */
export function bearingDeg(dx: number, dy: number): number {
  const deg = (Math.atan2(dx, dy) * 180) / Math.PI
  return ((deg % 360) + 360) % 360
}

/** Rounded to 0.1° and kept in [0, 360). */
const roundHeading = (deg: number) => {
  const rounded = Math.round((((deg % 360) + 360) % 360) * 10) / 10
  return rounded >= 360 ? 0 : rounded
}

/**
 * Length-weighted principal axis of a set of segments (each treated as a uniform rod, so long
 * segments count for more and splitting a segment changes nothing).
 */
export function principalAxis(segments: readonly Segment[]): {
  centre: LocalPoint
  axis: LocalPoint
} {
  let total = 0
  let sx = 0
  let sy = 0
  for (const { a, b } of segments) {
    const length = Math.hypot(b.x - a.x, b.y - a.y)
    total += length
    sx += (length * (a.x + b.x)) / 2
    sy += (length * (a.y + b.y)) / 2
  }
  if (total === 0) throw new Error('principal axis of zero-length segments')
  const centre = { x: sx / total, y: sy / total }
  let cxx = 0
  let cyy = 0
  let cxy = 0
  for (const { a, b } of segments) {
    const length = Math.hypot(b.x - a.x, b.y - a.y)
    const mx = (a.x + b.x) / 2 - centre.x
    const my = (a.y + b.y) / 2 - centre.y
    const dx = b.x - a.x
    const dy = b.y - a.y
    cxx += length * (mx * mx + (dx * dx) / 12)
    cyy += length * (my * my + (dy * dy) / 12)
    cxy += length * (mx * my + (dx * dy) / 12)
  }
  const angle = Math.atan2(2 * cxy, cxx - cyy) / 2
  return { centre, axis: { x: Math.cos(angle), y: Math.sin(angle) } }
}

const roundPoint = (point: LocalPoint): LocalPoint => ({
  x: Math.round(point.x),
  y: Math.round(point.y),
})

type BridgeModel = Extract<LandmarkModel, { frame: { kind: 'lion-bridge' } }>
type FrontModel = Extract<LandmarkModel, { frame: { kind: 'lion-front' } }>

const isBridge = (model: LandmarkModel): model is BridgeModel => model.frame.kind === 'lion-bridge'

interface Placement {
  readonly anchor: LocalPoint
  readonly headingDeg: number
  readonly segments: number
  /** Bridges: the principal axis's centre. Others: the distance to the fronting street. */
  readonly evidence: { readonly axisCentre: LocalPoint } | { readonly frontM: number }
  readonly bridge?: { readonly ends: [LocalPoint, LocalPoint]; readonly spanM: number }
}

function bridgeFrame(
  model: BridgeModel,
  place: FramePlace,
  all: readonly Segment[],
  land: readonly PreparedArea[],
): Placement {
  const { frame } = model
  const segments = all.filter(
    (s) =>
      (frame.segmentTypes as readonly string[]).includes(s.segmentType) &&
      (frame.roadwayTypes as readonly string[]).includes(s.roadwayType),
  )
  if (segments.length === 0) {
    throw new Error(`${model.id}: no LION ${frame.street} segments of the configured types`)
  }
  const { centre, axis } = principalAxis(segments)
  let min = Infinity
  let max = -Infinity
  for (const { a, b } of segments) {
    for (const p of [a, b]) {
      const t = (p.x - centre.x) * axis.x + (p.y - centre.y) * axis.y
      min = Math.min(min, t)
      max = Math.max(max, t)
    }
  }
  const at = (t: number) => roundPoint({ x: centre.x + t * axis.x, y: centre.y + t * axis.y })
  const spans = place.spans ?? []
  if (spans.length !== 2) throw new Error(`${model.id}: a bridge must span two boroughs`)
  const boroughOf = (point: LocalPoint) => areaAt(point, land) ?? 'water'
  let ends: [LocalPoint, LocalPoint] = [at(min), at(max)]
  if (boroughOf(ends[0]) !== spans[0]) ends = [ends[1], ends[0]]
  const found = ends.map(boroughOf)
  if (found[0] !== spans[0] || found[1] !== spans[1]) {
    throw new Error(
      `${model.id}: axis ends are in ${found.join(' and ')}, not ${spans.join(' and ')}`,
    )
  }
  const [first, second] = ends
  const spanM = Math.round(Math.hypot(second.x - first.x, second.y - first.y))
  return {
    anchor: roundPoint({ x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 }),
    headingDeg: roundHeading(bearingDeg(second.x - first.x, second.y - first.y)),
    segments: segments.length,
    evidence: { axisCentre: roundPoint(centre) },
    bridge: { ends, spanM },
  }
}

function frontFrame(
  model: FrontModel,
  place: FramePlace,
  segments: readonly Segment[],
  config: GeoConfig,
): Placement {
  const anchor = project(place.location)
  let best: { distance: number; segment: Segment } | undefined
  for (const segment of segments) {
    const distance = distanceToSegment(anchor, segment.a, segment.b)
    if (best === undefined || distance < best.distance) best = { distance, segment }
  }
  if (best === undefined || best.distance > config.landmarkFrontMaxM) {
    throw new Error(
      `${model.id}: ${model.frame.street} is more than ${config.landmarkFrontMaxM} m away`,
    )
  }
  const { a, b } = best.segment
  const streetBearing = bearingDeg(b.x - a.x, b.y - a.y) % 180
  return {
    anchor: roundPoint(anchor),
    headingDeg: roundHeading(streetBearing + model.frame.faceDeg),
    segments: segments.length,
    evidence: { frontM: Math.round(best.distance * 10) / 10 },
  }
}

/** Builds every model's frame; also returns the LION sources it read, in source-id order. */
export function buildLandmarkFrames(
  inputs: LandmarkFrameInputs,
  land: readonly PreparedArea[],
  config: GeoConfig,
): { frames: LandmarkFrame[]; sources: LionSourceId[] } {
  const places = new Map(inputs.places.map((place) => [place.id, place]))
  const segmentsBySource = new Map<LionSourceId, Segment[]>()
  const segmentsOf = (street: LionStreet) => {
    const id = lionSourceId(street)
    let segments = segmentsBySource.get(id)
    if (segments === undefined) {
      const json = inputs.lion.get(id)
      if (json === undefined) throw new Error(`LION source ${id} missing`)
      segments = lionSegments(street, json)
      segmentsBySource.set(id, segments)
    }
    return segments
  }

  const frames = [...inputs.models]
    .sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
    .map((model): LandmarkFrame => {
      const place = places.get(model.id)
      if (place === undefined) throw new Error(`${model.id}: not in landmarks.json`)
      const segments = segmentsOf(model.frame.street)
      const placed = isBridge(model)
        ? bridgeFrame(model, place, segments, land)
        : frontFrame(model, place, segments, config)
      const { halfLengthM, halfWidthM } = modelHalfExtents(model, placed.bridge?.spanM ?? 0)
      const margin = config.landmarkExclusionMarginM
      return {
        id: model.id,
        base: modelBase(model),
        anchor: placed.anchor,
        headingDeg: placed.headingDeg,
        ...(placed.bridge ?? {}),
        exclusion: {
          x: placed.anchor.x,
          y: placed.anchor.y,
          halfLengthM: Math.ceil((halfLengthM + margin) * 10) / 10,
          halfWidthM: Math.ceil((halfWidthM + margin) * 10) / 10,
          angleDeg: roundHeading(90 - placed.headingDeg),
        },
        pinLiftM: Math.round(modelTopM(model) * 10) / 10,
        lion: { street: model.frame.street, segments: placed.segments, ...placed.evidence },
      }
    })
  const sources = [...segmentsBySource.keys()].sort()
  return { frames, sources }
}
