/**
 * Client-side validation of the base geo layers the scene fetches from /geo/base. Mirrors the
 * classic-zod schemas in src/lib/data/schemas/world.ts with `zod/mini` (classic zod must not
 * reach browser code: src/lib/client-imports.test.ts), and schema.test.ts runs the real files
 * and malformed fixtures through both so they cannot drift apart.
 *
 * `import * as z` (not `import { z }`) keeps zod/mini tree-shakable: the named import makes the
 * bundler pull in all of zod/mini, locales included.
 */
import * as z from 'zod/mini'
import type { LandmarkFrame, LandmarkModel } from '@/lib/data/schemas/landmarkModels'
import { ORIGIN, PROJECTION_ID } from '@/lib/geo/projection'
import { GEO_SOURCE_IDS } from '@/lib/geo/sources'

/** Same ids and order as BOROUGHS in src/lib/data/schemas/content.ts (checked in the tests). */
export const BOROUGH_IDS = ['queens', 'brooklyn', 'manhattan', 'bronx', 'staten-island'] as const
export type BoroughId = (typeof BOROUGH_IDS)[number]

/**
 * v2 (S04c) added the `places` layer; v3 (S07a) adds the `landmarks` layer (model parameters
 * and frames) and lifts modelled landmarks' pins over their models as badges.
 */
export const GEO_BASE_FORMAT = 'cc-geo-base-v3'

/**
 * The landmark kit's archetypes (ARCHETYPES in src/lib/data/schemas/landmarkModels.ts, which is
 * classic zod and must not reach the scene; landmarks.test.ts keeps the two lists equal).
 */
export const LANDMARK_ARCHETYPES = [
  'civicHall',
  'stationConcourse',
  'setbackSpire',
  'terminalHall',
  'wedgeTower',
  'suspensionBridge',
  'cantileverBridge',
] as const

const id = z.string().check(z.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'kebab-case id'))
const borough = z.enum(BOROUGH_IDS)
const metre = z.int()
const evenLength = z.refine<number[]>((coords) => coords.length % 2 === 0, 'odd coordinate count')

/** Open ring of delta-encoded integer metres (src/lib/geo/codec.ts): at least 3 vertices. */
const ring = z.array(metre).check(z.minLength(6), evenLength)
/** [outer, ...holes]. */
const polygon = z.array(ring).check(z.minLength(1))
const polygons = z.array(polygon).check(z.minLength(1))
/** Open polyline of delta-encoded integer metres: at least 2 vertices. */
const path = z.array(metre).check(z.minLength(4), evenLength)

function listOf<T extends z.ZodMiniType<{ id: string }>>(entry: T) {
  return z
    .array(entry)
    .check(
      z.refine<z.output<T>[]>(
        (list) => new Set(list.map((item) => item.id)).size === list.length,
        'duplicate id',
      ),
    )
}

const header = {
  format: z.literal('cc-geo-v1'),
  derived: z.literal(true),
  notice: z.string().check(z.minLength(1)),
  sources: z.array(z.enum(GEO_SOURCE_IDS)).check(z.minLength(1)),
  projection: z.strictObject({
    id: z.literal(PROJECTION_ID),
    originLat: z.literal(ORIGIN.lat),
    originLng: z.literal(ORIGIN.lng),
  }),
}

export const LandMiniSchema = z.strictObject({
  ...header,
  boroughs: listOf(
    z.strictObject({ id: borough, boroCode: z.int().check(z.gte(1), z.lte(5)), polygons }),
  ).check(z.length(BOROUGH_IDS.length)),
})

export const WaterMiniSchema = z.strictObject({ ...header, sea: polygon })

export const ParksMiniSchema = z.strictObject({
  ...header,
  parks: listOf(
    z.strictObject({
      id,
      ntaCode: z.string().check(z.regex(/^[A-Z]{2}\d{4}$/, 'NTA 2020 code, e.g. QN0101')),
      kind: z.enum(['park', 'cemetery']),
      borough,
      polygons,
    }),
  ),
})

export const SubwayMiniSchema = z.strictObject({
  ...header,
  lines: listOf(
    z.strictObject({
      id,
      gtfsRouteId: z.string().check(z.minLength(1)),
      label: z.string().check(z.minLength(1)),
      paths: z.array(path).check(z.minLength(1)),
    }),
  ).check(z.minLength(1)),
  stations: listOf(
    z.strictObject({
      id,
      gtfsStopId: z.string().check(z.minLength(1)),
      name: z.string().check(z.minLength(1)),
      x: metre,
      y: metre,
      borough,
      zoneId: id,
      lines: z.array(id).check(z.minLength(1)),
    }),
  ).check(z.minLength(1)),
  terminalExtensions: z.array(
    z.strictObject({ lineId: id, stationId: id, gapM: z.int().check(z.gte(0)) }),
  ),
})

/** A pin's look: a playable place, a teaser on "expanding soon" land, or a muted memorial. */
export const PIN_STYLES = ['normal', 'teaser', 'memorial'] as const
export type PinStyle = (typeof PIN_STYLES)[number]
export const PIN_KINDS = ['venue', 'landmark'] as const
export type PinKind = (typeof PIN_KINDS)[number]

/** Pins and borough render states (src/lib/world/placesLayer.ts). */
export const PlacesMiniSchema = z.strictObject({
  pins: listOf(
    z.strictObject({
      id,
      kind: z.enum(PIN_KINDS),
      category: id,
      borough,
      x: metre,
      y: metre,
      style: z.enum(PIN_STYLES),
      /** Extra height above the land top; omitted means 0 (S07a lifts pins over models). */
      liftM: z.optional(z.number().check(z.gte(0))),
      /** A modelled landmark's pin: a compact badge over its model (S07a). */
      badge: z.optional(z.literal(true)),
    }),
  ),
  boroughs: listOf(
    z.strictObject({
      id: borough,
      render: z.enum(['normal', 'dimmed']),
      teaserIds: z.array(id),
    }),
  ).check(z.length(BOROUGH_IDS.length)),
})

const point = z.strictObject({ x: z.number(), y: z.number() })

/**
 * The landmarks layer (src/lib/world/landmarksLayer.ts). The frame is checked in full; a model's
 * parameters only by shape, since the server validated every one against its archetype's
 * schema at build time and the kit's builders read them as typed (a model that still fails to
 * build is skipped, never the whole map: src/scene/landmarks/Landmarks.tsx).
 */
export const LandmarksMiniSchema = z.strictObject({
  models: listOf(
    z
      .strictObject({
        id,
        borough,
        category: id,
        style: z.enum(['normal', 'teaser']),
        model: z.looseObject({
          id,
          archetype: z.enum(LANDMARK_ARCHETYPES),
          depiction: z.enum(['massing', 'stylised']),
          params: z.looseObject({ roles: z.record(z.string(), z.string()) }),
        }),
        frame: z.looseObject({
          id,
          base: z.enum(['land', 'water']),
          anchor: point,
          headingDeg: z.number().check(z.gte(0), z.lt(360)),
          ends: z.optional(z.tuple([point, point])),
          spanM: z.optional(z.number().check(z.gt(0))),
          exclusion: z.looseObject({
            x: z.number(),
            y: z.number(),
            halfLengthM: z.number().check(z.gt(0)),
            halfWidthM: z.number().check(z.gt(0)),
          }),
          pinLiftM: z.number().check(z.gt(0)),
        }),
      })
      .check(
        z.refine(
          (entry) => entry.model.id === entry.id && entry.frame.id === entry.id,
          'model and frame must carry the entry id',
        ),
      ),
  ),
})

/** One modelled landmark as the scene builds it. */
export interface GeoLandmark {
  readonly id: string
  readonly borough: BoroughId
  /** landmarks.json category: decides whether the night glow may touch it. */
  readonly category: string
  readonly style: 'normal' | 'teaser'
  readonly model: LandmarkModel
  readonly frame: LandmarkFrame
}

/** The body of GET /geo/base (src/app/geo/base/route.ts). */
export const GeoBaseSchema = z.strictObject({
  format: z.literal(GEO_BASE_FORMAT),
  /** Short hash of the base layers and places (src/lib/data/geo.ts geoVersion). */
  version: z.string().check(z.regex(/^[0-9a-f]{12}$/)),
  land: LandMiniSchema,
  water: WaterMiniSchema,
  parks: ParksMiniSchema,
  subway: SubwayMiniSchema,
  places: PlacesMiniSchema,
  landmarks: LandmarksMiniSchema,
})
export type GeoBase = Omit<z.infer<typeof GeoBaseSchema>, 'landmarks'> & {
  readonly landmarks: { readonly models: readonly GeoLandmark[] }
}
export type GeoLand = GeoBase['land']
export type GeoParks = GeoBase['parks']
export type GeoSubway = GeoBase['subway']
export type GeoWater = GeoBase['water']
export type GeoPlaces = GeoBase['places']
export type GeoPin = GeoPlaces['pins'][number]

/** The first failing paths of a rejected body (never the payload itself). */
function failingPaths(issues: readonly { readonly path: readonly PropertyKey[] }[]): string[] {
  return issues.slice(0, 3).map((issue) => issue.path.map(String).join('.') || '(root)')
}

/**
 * Validates a fetched geo body without throwing (fail fast: a bad payload never reaches the
 * geometry builders). A rejection names the first failing paths only, never the payload.
 */
export function safeParseGeoBase(
  json: unknown,
): { ok: true; geo: GeoBase } | { ok: false; paths: string[] } {
  const result = GeoBaseSchema.safeParse(json)
  if (!result.success) return { ok: false, paths: failingPaths(result.error.issues) }
  // The models' parameters were validated against their archetypes on the server
  // (see LandmarksMiniSchema); the shape checked here is narrower than the kit's types.
  const landmarks = result.data.landmarks as unknown as GeoBase['landmarks']
  return { ok: true, geo: { ...result.data, landmarks } }
}

/** Like {@link safeParseGeoBase}, but throws (for server code and tests). */
export function parseGeoBase(json: unknown): GeoBase {
  const result = safeParseGeoBase(json)
  if (!result.ok) throw new Error(`Invalid geo base payload at ${result.paths.join(', ')}`)
  return result.geo
}
