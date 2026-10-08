/** Schemas for /data/geo, /data/zones and /data/audio. */
import { z } from 'zod'
import { AUDIO_CHANNELS, AUDIO_SOURCE_TYPES } from '../../audio/channels'
import { ORIGIN, PROJECTION_ID } from '../../geo/projection'
import { BUILDING_DISTRICT_IDS, DERIVED_SOURCE_IDS, GEO_SOURCE_IDS } from '../../geo/sources'
import { QUALITY_TIERS } from './config'
import { BOROUGHS, BoroughSchema, CopyKeyRefSchema, IdSchema, listOf } from './content'
import { LandmarkFrameSchema } from './landmarkModels'

/** The NYC extent in WGS84 degrees: camera bounds and a sanity check for every coordinate. */
export const GeoBoundsSchema = z
  .strictObject({
    west: z.number().min(-180).max(180),
    south: z.number().min(-90).max(90),
    east: z.number().min(-180).max(180),
    north: z.number().min(-90).max(90),
  })
  .refine((b) => b.west < b.east && b.south < b.north, { error: 'empty or inverted bounds' })
export type GeoBounds = z.infer<typeof GeoBoundsSchema>

/** Every derived layer records the projection its metres are in (src/lib/geo/projection.ts). */
export const ProjectionRefSchema = z.strictObject({
  id: z.literal(PROJECTION_ID),
  originLat: z.literal(ORIGIN.lat),
  originLng: z.literal(ORIGIN.lng),
})

/**
 * Header shared by every `*.derived.json` file written by `npm run geo:build`: it is simplified
 * artwork derived from the named sources, not the original data (MTA and NYC terms).
 */
const derivedHeader = {
  format: z.literal('cc-geo-v1'),
  derived: z.literal(true),
  notice: z.string().min(1),
  sources: z.array(z.enum(GEO_SOURCE_IDS)).min(1),
  projection: ProjectionRefSchema,
}
export const DerivedHeaderSchema = z.strictObject(derivedHeader)

const metre = z.int()

/** Open ring of integer metres, delta-encoded (see src/lib/geo/codec.ts): at least 3 vertices. */
export const DeltaRingSchema = z
  .array(metre)
  .min(6)
  .refine((ring) => ring.length % 2 === 0, { error: 'odd coordinate count' })
/** [outer, ...holes]. */
export const PolygonSchema = z.array(DeltaRingSchema).min(1)
/** Open polyline of integer metres, delta-encoded: at least 2 vertices. */
export const DeltaPathSchema = z
  .array(metre)
  .min(4)
  .refine((path) => path.length % 2 === 0, { error: 'odd coordinate count' })

const polygons = z.array(PolygonSchema).min(1)

export const LandFileSchema = z.strictObject({
  ...derivedHeader,
  boroughs: listOf(
    z.strictObject({ id: BoroughSchema, boroCode: z.int().min(1).max(5), polygons }),
  ).length(BOROUGHS.length),
})

export const WaterFileSchema = z.strictObject({ ...derivedHeader, sea: PolygonSchema })

const NtaCodeSchema = z.string().regex(/^[A-Z]{2}\d{4}$/, 'NTA 2020 code, e.g. QN0101')

export const ParksFileSchema = z.strictObject({
  ...derivedHeader,
  parks: listOf(
    z.strictObject({
      id: IdSchema,
      ntaCode: NtaCodeSchema,
      kind: z.enum(['park', 'cemetery']),
      borough: BoroughSchema,
      polygons,
    }),
  ),
})

export const SubwayLineSchema = z.strictObject({
  id: IdSchema,
  gtfsRouteId: z.string().min(1),
  /** route_short_name, drawn as plain text in our own style (never MTA bullets). */
  label: z.string().min(1),
  paths: z.array(DeltaPathSchema).min(1),
})
export const SubwayStationSchema = z.strictObject({
  id: IdSchema,
  gtfsStopId: z.string().min(1),
  /** GTFS stop_name (STN-1: branded names get generic display labels through copy later). */
  name: z.string().min(1),
  x: metre,
  y: metre,
  borough: BoroughSchema,
  zoneId: IdSchema,
  lines: z.array(IdSchema).min(1),
})
export const SubwayFileSchema = z.strictObject({
  ...derivedHeader,
  lines: listOf(SubwayLineSchema).min(1),
  stations: listOf(SubwayStationSchema).min(1),
  /** Paths extended to a station their GTFS shapes stop short of (listed in SOURCES.md). */
  terminalExtensions: z.array(
    z.strictObject({ lineId: IdSchema, stationId: IdSchema, gapM: z.int().nonnegative() }),
  ),
})
export type SubwayLine = z.infer<typeof SubwayLineSchema>
export type SubwayStation = z.infer<typeof SubwayStationSchema>

/**
 * Play zones: one per 2020 Community District Tabulation Area (59 community districts plus 12
 * joint interest areas such as parks and airports), each a group of NYC Neighborhood
 * Tabulation Areas. `name` is the CDTA name from the source data (a place name, not our copy).
 */
export const ZoneSchema = z.strictObject({
  id: IdSchema,
  cdtaCode: z.string().regex(/^(?:BK|BX|MN|QN|SI)\d{2}$/, 'CDTA 2020 code, e.g. QN01'),
  kind: z.enum(['district', 'joint-interest-area']),
  name: z.string().min(1),
  borough: BoroughSchema,
  ntaCodes: z.array(NtaCodeSchema).min(1),
  /** An interior label point in local metres. */
  centroid: z.strictObject({ x: metre, y: metre }),
})
export const ZonesFileSchema = z.strictObject({ ...derivedHeader, zones: listOf(ZoneSchema) })
export type Zone = z.infer<typeof ZoneSchema>

export const ZoneShapesFileSchema = z.strictObject({
  ...derivedHeader,
  zones: listOf(z.strictObject({ id: IdSchema, polygons })),
})

/**
 * Header of the per-tier building files (`cc-buildings-v1`, `cc-blocks-v1`): derived artwork like
 * the base layers, but may name the paged building-footprint sources too.
 */
const tieredHeader = {
  derived: z.literal(true),
  notice: z.string().min(1),
  sources: z.array(z.enum(DERIVED_SOURCE_IDS)).min(1),
  projection: ProjectionRefSchema,
  tier: z.enum(QUALITY_TIERS),
}

/**
 * data/geo/districts/<district>.<tier>.derived.json: one district's building masses for one
 * quality tier, as columns. Numbers only past the header: no names or any other attribute of a
 * real building can ride along.
 */
export const BuildingsFileSchema = z
  .strictObject({
    format: z.literal('cc-buildings-v1'),
    ...tieredHeader,
    district: z.enum(BUILDING_DISTRICT_IDS),
    /** Local metres the rings are relative to (the district centre, rounded). */
    origin: z.strictObject({ x: metre, y: metre }),
    /** Mass heights, whole metres. */
    h: z.array(z.int().positive()),
    /** Mass footprints, [outer, ...holes], delta-encoded relative to `origin`. */
    r: z.array(PolygonSchema),
  })
  .refine((file) => file.h.length === file.r.length, { error: 'h and r must be the same length' })
export type BuildingsFile = z.infer<typeof BuildingsFileSchema>

/** Block centres as one delta-encoded path (a single block is a one-point path). */
const BlockPointsSchema = z
  .array(metre)
  .min(2)
  .refine((points) => points.length % 2 === 0, { error: 'odd coordinate count' })

/**
 * data/geo/blocks.<tier>.derived.json: procedural low blocks outside the districts, one group
 * (an instanced mesh) per borough, square `sizeM` boxes rotated by the group's grid angle.
 */
export const BlocksFileSchema = z.strictObject({
  format: z.literal('cc-blocks-v1'),
  ...tieredHeader,
  sizeM: z.int().positive(),
  groups: z.array(
    z
      .strictObject({
        borough: BoroughSchema,
        /** Degrees counter-clockwise from east. */
        angleDeg: z.number().min(-90).max(90),
        p: BlockPointsSchema,
        /** Heights, whole metres. */
        h: z.array(z.int().positive()).min(1),
      })
      .refine((group) => group.p.length === 2 * group.h.length, {
        error: 'one point per height',
      }),
  ),
})
export type BlocksFile = z.infer<typeof BlocksFileSchema>

const TIERED_PATH = new RegExp(
  `^geo/(?:districts/(?:${BUILDING_DISTRICT_IDS.join('|')})|blocks)\\.(?:${QUALITY_TIERS.join('|')})\\.derived\\.json$`,
)

/**
 * data/landmarks/frames.derived.json: where each modelled landmark stands and faces, derived
 * from NYC DCP LION street centerlines (S07a).
 */
export const LandmarkFramesFileSchema = z.strictObject({
  ...derivedHeader,
  landmarks: listOf(LandmarkFrameSchema).min(1),
})
export type LandmarkFramesFile = z.infer<typeof LandmarkFramesFileSchema>

/** data/geo/manifest.derived.json: size and hash of every file the geo build writes. */
export const GeoManifestSchema = z.strictObject({
  format: z.literal('cc-geo-manifest-v1'),
  files: z
    .array(
      z
        .strictObject({
          /** Relative to data/. */
          path: z
            .string()
            .regex(
              /^(?:(?:geo|zones|landmarks)\/(?:[a-z0-9-]+\.derived\.json|SOURCES\.md)|geo\/districts\/[a-z0-9-]+\.[a-z]+\.derived\.json|geo\/blocks\.[a-z]+\.derived\.json)$/,
            ),
          /**
           * `base` ships with the map (perf.json baseGeoGzKB); `district` and `blocks` load per
           * quality tier (perf.json districtBuildingsGzKB); `docs` never ships.
           */
          group: z.enum(['base', 'docs', 'district', 'blocks']),
          /** Set exactly for `district` and `blocks` files. */
          tier: z.enum(QUALITY_TIERS).optional(),
          bytes: z.int().positive(),
          sha256: z.string().regex(/^[0-9a-f]{64}$/),
        })
        .refine(
          (file) =>
            (file.group === 'district' || file.group === 'blocks') ===
            (file.tier !== undefined && TIERED_PATH.test(file.path)),
          { error: 'district and blocks files carry a tier and a per-tier path; others neither' },
        ),
    )
    .min(1),
})
export type GeoManifest = z.infer<typeof GeoManifestSchema>

export { AUDIO_CHANNELS }

const AUDIO_FILE = /^\/audio\/[a-z0-9/_-]+\.(?:webm|m4a)$/
const EXTENSION_OF_TYPE: Readonly<Record<(typeof AUDIO_SOURCE_TYPES)[number], string>> = {
  'audio/webm; codecs=opus': '.webm',
  'audio/mp4; codecs=mp4a.40.2': '.m4a',
}

/** One encoding of a track, served from our own origin under /audio/ (no streams, no radio). */
export const AudioSourceSchema = z
  .strictObject({
    /** Path under public/, e.g. `/audio/music/lofi-loop.webm`. */
    file: z.string().regex(AUDIO_FILE),
    type: z.enum(AUDIO_SOURCE_TYPES),
    bytes: z.int().positive(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .refine((source) => source.file.endsWith(EXTENSION_OF_TYPE[source.type]), {
    error: 'file extension must match type',
    path: ['file'],
  })

/**
 * One sound, as `npm run audio:build` wrote it. Everything is CC0 only (no radio, user ruling)
 * and records where it came from; data/audio/SOURCES.md has the full provenance.
 */
export const AudioTrackSchema = z
  .strictObject({
    id: IdSchema,
    channel: z.enum(AUDIO_CHANNELS),
    /** "Title by Artist" shown while it plays. Required for music. */
    titleKey: CopyKeyRefSchema.optional(),
    /** Encodings in the order the runtime tries them (Opus first, AAC for Safari). */
    sources: z.array(AudioSourceSchema).min(1),
    durationMs: z.int().positive(),
    loop: z.boolean(),
    loopStartMs: z.int().nonnegative().optional(),
    loopEndMs: z.int().positive().optional(),
    /** Extra gain applied on playback, after loudness normalisation. */
    gainDb: z.number().min(-24).max(6),
    license: z.literal('CC0-1.0'),
    sourceUrl: z.url({ protocol: /^https$/ }),
    author: z.string().min(1),
    retrievedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .refine((track) => track.channel !== 'music' || track.titleKey !== undefined, {
    error: 'music needs a titleKey',
    path: ['titleKey'],
  })
  .refine(
    (track) => track.loop || (track.loopStartMs === undefined && track.loopEndMs === undefined),
    { error: 'loop points need loop: true', path: ['loopStartMs'] },
  )
  .refine(
    ({ loopStartMs = 0, loopEndMs, durationMs }) =>
      loopEndMs === undefined
        ? loopStartMs < durationMs
        : loopStartMs < loopEndMs && loopEndMs <= durationMs,
    { error: 'loop points must fall inside the track, start before end', path: ['loopEndMs'] },
  )
export type AudioTrack = z.infer<typeof AudioTrackSchema>

export const AudioManifestSchema = z
  .strictObject({
    version: z.literal(2),
    channels: z.array(z.enum(AUDIO_CHANNELS)).length(AUDIO_CHANNELS.length),
    tracks: listOf(AudioTrackSchema),
    /** Play order per looping channel: music rotates, ambience loops its first track. */
    playlists: z.strictObject({
      music: z.array(IdSchema).min(1),
      ambience: z.array(IdSchema).min(1),
    }),
    /** The track each sound-effect id plays. */
    sfx: z.strictObject({ 'ui-tap': IdSchema, purchase: IdSchema, 'clout-up': IdSchema }),
  })
  .refine((manifest) => new Set(manifest.channels).size === AUDIO_CHANNELS.length, {
    error: 'channels must list each channel once',
    path: ['channels'],
  })
  .superRefine((manifest, ctx) => {
    const channelOf = new Map(manifest.tracks.map((track) => [track.id, track.channel]))
    const expect = (ids: readonly string[], channel: string, path: (string | number)[]) => {
      ids.forEach((id, index) => {
        if (channelOf.get(id) !== channel) {
          ctx.addIssue({
            code: 'custom',
            message: `${id} is not a ${channel} track`,
            path: [...path, index],
          })
        }
      })
    }
    expect(manifest.playlists.music, 'music', ['playlists', 'music'])
    expect(manifest.playlists.ambience, 'ambience', ['playlists', 'ambience'])
    expect(Object.values(manifest.sfx), 'sfx', ['sfx'])
  })
export type AudioManifest = z.infer<typeof AudioManifestSchema>

/**
 * data/boroughs/boroughs.json: borough copy and teasers. Whether a borough is open, gated by
 * clout or "expanding soon" is balance (data/config/balance.json `boroughs`).
 */
export const BoroughsFileSchema = z.strictObject({
  boroughs: listOf(
    z.strictObject({
      id: BoroughSchema,
      nameKey: CopyKeyRefSchema,
      /** Why-locked copy for a clout-gated borough; takes {level} and {current}. */
      lockedKey: CopyKeyRefSchema.optional(),
      /** "Expanding soon" copy for a borough that is not playable yet. */
      teaserKey: CopyKeyRefSchema.optional(),
      /** Landmarks shown as teaser pins on a dimmed borough. */
      teaserLandmarkIds: z.array(IdSchema),
    }),
  ).length(BOROUGHS.length),
})
export type BoroughsFile = z.infer<typeof BoroughsFileSchema>
