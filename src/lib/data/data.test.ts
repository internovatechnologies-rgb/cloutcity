/**
 * Every file under /data is validated by a zod schema, and the cross-file references hold
 * (copy keys, balance ids, coordinates inside the NYC extent).
 */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import { parseDataFile } from './parse'
import {
  AudioConfigSchema,
  BalanceConfigSchema,
  type BalanceConfig,
  CopyConfigSchema,
  GeoConfigSchema,
  HandlesConfigSchema,
  JOB_IDS,
  LayoutConfigSchema,
  ModerationConfigSchema,
  OfflineConfigSchema,
  OnboardingConfigSchema,
  PerfConfigSchema,
  type PerfConfig,
  ProfileConfigSchema,
  ProgressionConfigSchema,
  RealtimeConfigSchema,
  SyncConfigSchema,
  ThemeConfigSchema,
  TourConfigSchema,
  createProgressionConfigSchema,
} from './schemas/config'
import {
  EventsFileSchema,
  HomesFileSchema,
  HomeInteriorsFileSchema,
  ItemsFileSchema,
  JobsFileSchema,
  LandmarksFileSchema,
  PremiumFileSchema,
  VenuesFileSchema,
} from './schemas/content'
import { NamespaceBaseSchema, SlangPackSchema, SuperlativesSchema } from './schemas/copy'
import { HandleBlocklistSchema, HandleWordsSchema } from './schemas/handles'
import { SceneConfigSchema } from './schemas/scene'
import { LandmarkModelsFileSchema } from './schemas/landmarkModels'
import { EconomyBaselineSchema } from './schemas/sim'
import {
  AudioManifestSchema,
  BlocksFileSchema,
  BoroughsFileSchema,
  BuildingsFileSchema,
  GeoBoundsSchema,
  GeoManifestSchema,
  LandFileSchema,
  LandmarkFramesFileSchema,
  ParksFileSchema,
  SubwayFileSchema,
  WaterFileSchema,
  ZoneShapesFileSchema,
  ZonesFileSchema,
} from './schemas/world'
import { ModelManifestSchema, ShowcaseSchema } from './schemas/assets'
import { CatalogSchema } from '../../../scripts/assets/schema'
import {
  audio,
  balance,
  layout,
  onboarding,
  perf,
  progression,
  realtime,
  sync,
  theme,
} from './config'
import {
  audioManifest,
  events,
  geoBounds,
  homeInteriors,
  items,
  jobs,
  landmarks,
  premiumItems,
  venues,
} from './content'
import { baseCopy } from '@/lib/copy/all'

const DATA = join(import.meta.dirname, '../../../data')

/**
 * The schema for each data file. Copy files are matched by pattern in `schemaFor`: each
 * copy/<ns>/base.json is a NamespaceBaseSchema, any other copy/<ns>/<pack>.json a SlangPackSchema.
 */
const SCHEMAS: Readonly<Record<string, z.ZodType>> = {
  'assets/catalog.json': CatalogSchema,
  'assets/manifest.json': ModelManifestSchema,
  'assets/showcase.json': ShowcaseSchema,
  'audio/manifest.json': AudioManifestSchema,
  'boroughs/boroughs.json': BoroughsFileSchema,
  'config/audio.json': AudioConfigSchema,
  'config/balance.json': BalanceConfigSchema,
  'config/copy.json': CopyConfigSchema,
  'config/geo.json': GeoConfigSchema,
  'config/handles.json': HandlesConfigSchema,
  'config/layout.json': LayoutConfigSchema,
  'config/moderation.json': ModerationConfigSchema,
  'config/offline.json': OfflineConfigSchema,
  'config/onboarding.json': OnboardingConfigSchema,
  'config/perf.json': PerfConfigSchema,
  'config/profile.json': ProfileConfigSchema,
  'config/progression.json': createProgressionConfigSchema(balance.clout.levels),
  'config/realtime.json': RealtimeConfigSchema,
  'config/scene.json': SceneConfigSchema,
  'config/sync.json': SyncConfigSchema,
  'config/theme.json': ThemeConfigSchema,
  'config/tour.json': TourConfigSchema,
  'copy/handleWords.json': HandleWordsSchema,
  'copy/superlatives.json': SuperlativesSchema,
  'events/events.json': EventsFileSchema,
  'geo/bounds.json': GeoBoundsSchema,
  'geo/land.derived.json': LandFileSchema,
  'geo/manifest.derived.json': GeoManifestSchema,
  'geo/parks.derived.json': ParksFileSchema,
  'geo/subway.derived.json': SubwayFileSchema,
  'geo/water.derived.json': WaterFileSchema,
  'homes/homes.json': HomesFileSchema,
  'homes/interiors.json': HomeInteriorsFileSchema,
  'items/items.json': ItemsFileSchema,
  'jobs/jobs.json': JobsFileSchema,
  'landmarks/frames.derived.json': LandmarkFramesFileSchema,
  'landmarks/landmarks.json': LandmarksFileSchema,
  'landmarks/models.json': LandmarkModelsFileSchema,
  'moderation/handle-blocklist.json': HandleBlocklistSchema,
  'premium/premium.json': PremiumFileSchema,
  'sim/economy-baseline.derived.json': EconomyBaselineSchema,
  'venues/venues.json': VenuesFileSchema,
  'zones/zone-shapes.derived.json': ZoneShapesFileSchema,
  'zones/zones.derived.json': ZonesFileSchema,
}

function schemaFor(file: string): z.ZodType | undefined {
  if (/^geo\/districts\/[a-z0-9-]+\.[a-z]+\.derived\.json$/.test(file)) return BuildingsFileSchema
  if (/^geo\/blocks\.[a-z]+\.derived\.json$/.test(file)) return BlocksFileSchema
  if (/^copy\/[\w-]+\/base\.json$/.test(file)) return NamespaceBaseSchema
  if (/^copy\/[\w-]+\/[\w-]+\.json$/.test(file)) return SlangPackSchema
  return SCHEMAS[file]
}

/** Extensions the data loaders parse. Every file with one of these needs a schema. */
const DATA_EXTENSIONS = ['.json', '.geojson']

/** Documentation that may sit next to data (by file name). Everything else must be data. */
const NON_DATA_FILES = new Set(['SOURCES.md', 'README.md'])

/** OS artefacts that are gitignored and never shipped. */
const IGNORED_FILES = new Set(['.DS_Store'])

function allFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && !IGNORED_FILES.has(entry.name))
    .map((entry) => relative(DATA, join(entry.parentPath, entry.name)).split('\\').join('/'))
    .sort()
}

const isDataFile = (file: string) => DATA_EXTENSIONS.some((ext) => file.endsWith(ext))
const baseName = (file: string) => file.split('/').pop() ?? file

/** Files that would ship without validation: unknown types, or data files with no schema. */
function unvalidatedFiles(files: readonly string[]): string[] {
  return files.filter((file) =>
    isDataFile(file) ? schemaFor(file) === undefined : !NON_DATA_FILES.has(baseName(file)),
  )
}

function dataFiles(dir: string): string[] {
  return allFiles(dir).filter(isDataFile)
}

const readJson = (file: string): unknown => JSON.parse(readFileSync(join(DATA, file), 'utf8'))

describe('/data files', () => {
  const files = dataFiles(DATA)

  it.each([
    'items',
    'premium',
    'events',
    'jobs',
    'venues',
    'landmarks',
    'geo',
    'zones',
    'audio',
    'assets',
    'boroughs',
    'homes',
    'config',
    'copy',
    'moderation',
  ])('/data/%s has at least one data file', (folder) => {
    expect(files.some((file) => file.startsWith(`${folder}/`))).toBe(true)
  })

  it('every file is a data file with a schema or allowlisted docs, so nothing ships unvalidated', () => {
    expect(unvalidatedFiles(allFiles(DATA))).toEqual([])
  })

  it('the file check rejects unknown types and schema-less .json or .geojson files', () => {
    expect(
      unvalidatedFiles([
        'config/perf.json',
        'geo/SOURCES.md',
        'geo/land.geojson',
        'items/extra.json',
        'audio/notes.txt',
        'geo/land.csv',
        'items/items.yaml',
      ]),
    ).toEqual([
      'geo/land.geojson',
      'items/extra.json',
      'audio/notes.txt',
      'geo/land.csv',
      'items/items.yaml',
    ])
  })

  it.each(dataFiles(DATA))('%s matches its schema', (file) => {
    const schema = schemaFor(file)
    if (schema === undefined) throw new Error(`no schema for ${file}`)
    expect(() => parseDataFile(file, schema, readJson(file))).not.toThrow()
  })

  it('reports the file and the failing path when a file is invalid', () => {
    expect(() => parseDataFile('config/realtime.json', RealtimeConfigSchema, {})).toThrow(
      /config\/realtime\.json[\s\S]*shardSize/,
    )
  })
})

describe('config/perf.json', () => {
  it('holds every budget from CLAUDE.md "Performance budgets"', () => {
    expect(perf).toEqual({
      shellJsGzKB: 180,
      // S05c: the shell keeps 20 KB of the budget free for features still to land.
      shellHeadroomGzKB: 20,
      sceneChunkJsGzKB: 350,
      // S16: the apartment's lazy 3D chunk, reported apart from the before-playable 3D chunk.
      apartmentChunkJsGzKB: 40,
      totalJsToPlayableGzKB: 550,
      baseGeoGzKB: 400,
      districtBuildingsGzKB: { low: 150, mid: 300, high: 400 },
      totalBytesToPlayableGzKB: { low: 1200, mid: 1600, high: 2000 },
      shellInteractiveColdMs: 2500,
      playableColdMs: { low: 6000, mid: 7000, high: 8000 },
      playableWarmMs: 2500,
      drawCallsMax: { low: 60, mid: 120, high: 200 },
      trianglesMax: { low: 150_000, mid: 400_000, high: 800_000 },
      // S04f (Q9): measured shader programs at the default view after the models load (low 9,
      // mid 10, high 13, day and night alike) + 10%, rounded up. A new cap, not a raised one.
      programsMax: { low: 10, mid: 11, high: 15 },
      // S16 apartment caps (TUNE-8 placeholders), with room kept for S16a's avatar.
      apartment: {
        drawCallsMax: { low: 24, mid: 32, high: 56 },
        trianglesMax: { low: 12_000, mid: 20_000, high: 30_000 },
        avatarReserve: { drawCalls: 6, triangles: 4000 },
      },
      dprCap: { low: 1, mid: 1.5, high: 2 },
      shadows: { low: 'none', mid: 'blob-or-baked', high: 'pcf-directional' },
      // S04b per-tier render settings (TUNE-6 placeholders).
      shadowMapSizePx: { low: 0, mid: 0, high: 2048 },
      antialias: { low: false, mid: true, high: true },
      outlines: { low: false, mid: true, high: true },
      buildingDensity: { low: 0.5, mid: 0.8, high: 1 },
      lodDistanceScale: { low: 0.6, mid: 1, high: 1.4 },
      postprocessing: 'none',
      otherPlayersMax: { low: 8, mid: 16, high: 24 },
      otherPlayersStyle: { low: 'billboard', mid: 'model', high: 'model' },
      medianFpsMin: { low: 30, mid: 45, high: 55 },
      idleFramesMax: 0,
      fpsStepDown: {
        belowFps: 28,
        sustainMs: 3000,
        sampleMs: 250,
        threshold: 0.9,
        cooldownMs: 10_000,
        maxSteps: 2,
      },
      tierPicker: perf.tierPicker,
      throttleProfiles: {
        'cc-mid-4g': {
          downloadKbps: 4000,
          uploadKbps: 1000,
          rttMs: 150,
          cpuSlowdown: 4,
          viewport: { width: 390, height: 844 },
        },
      },
      perfRun: {
        coldRuns: 3,
        coldTier: 'low',
        profile: 'cc-mid-4g',
        maxLoadPerCore: 0.75,
        loadWaitMaxMs: 600_000,
        loadPollMs: 5000,
        lockWaitMaxMs: 1_800_000,
      },
      audioLazyGzKB: { low: 600, mid: 1000, high: 1400 },
      audioFileMaxKB: 600,
      audioRuntimeJsGzKB: 20,
      // S04e: the service worker script and its install-time precache (not in CLAUDE.md's table).
      serviceWorkerGzKB: 15,
      precacheGzKB: 1000,
      buildingTrianglesMax: { low: 160_000, mid: 300_000, high: 480_000 },
      landmarkTrianglesMax: {
        bridge: { low: 1200, mid: 3500, high: 7000 },
        building: { low: 600, mid: 1800, high: 3500 },
        station: { low: 600, mid: 1800, high: 3500 },
        government: { low: 600, mid: 1800, high: 3500 },
      },
      landmarkTrianglesOverride: {},
      landmarkLodRatioMax: 0.5,
      // S04h (TUNE-12): per-asset caps set from the Part 1 measurements with ~15–25% headroom.
      models: {
        vehicle: { trianglesMax: { low: 1200, mid: 1500, high: 1500 }, gzKBMax: 25 },
        'street-prop': { trianglesMax: { low: 600, mid: 600, high: 600 }, gzKBMax: 12 },
        tree: { trianglesMax: { low: 500, mid: 500, high: 500 }, gzKBMax: 8 },
        building: { trianglesMax: { low: 1200, mid: 1200, high: 1500 }, gzKBMax: 18 },
        'building-detail': { trianglesMax: { low: 200, mid: 200, high: 200 }, gzKBMax: 4 },
        furniture: { trianglesMax: { low: 600, mid: 800, high: 800 }, gzKBMax: 16 },
        'room-shell': { trianglesMax: { low: 200, mid: 200, high: 200 }, gzKBMax: 4 },
        'avatar-rig': { trianglesMax: { low: 0, mid: 0, high: 0 }, gzKBMax: 8 },
        'avatar-head': { trianglesMax: { low: 350, mid: 400, high: 400 }, gzKBMax: 11 },
        'avatar-body': { trianglesMax: { low: 400, mid: 650, high: 650 }, gzKBMax: 15 },
        'avatar-accessory': { trianglesMax: { low: 100, mid: 100, high: 100 }, gzKBMax: 4 },
      },
    })
  })

  it('rejects a missing tier, an unknown key and a non-positive budget', () => {
    const valid = readJson('config/perf.json') as Record<string, unknown>
    const without = { ...valid, dprCap: { low: 1, mid: 1.5 } }
    expect(PerfConfigSchema.safeParse(without).success).toBe(false)
    expect(PerfConfigSchema.safeParse({ ...valid, extra: 1 }).success).toBe(false)
    expect(PerfConfigSchema.safeParse({ ...valid, shellJsGzKB: 0 }).success).toBe(false)
    const softShadows = { low: 'none', mid: 'blob-or-baked', high: 'pcf-soft' }
    expect(PerfConfigSchema.safeParse({ ...valid, shadows: softShadows }).success).toBe(false)
    const apartment = valid.apartment as Record<string, unknown>
    const reserveFillsLow = { ...apartment, avatarReserve: { drawCalls: 24, triangles: 1 } }
    expect(PerfConfigSchema.safeParse({ ...valid, apartment: reserveFillsLow }).success).toBe(false)
  })

  describe('S04b quality tier rules', () => {
    const valid = () => readJson('config/perf.json') as PerfConfig
    const accepts = (change: Partial<PerfConfig>) =>
      PerfConfigSchema.safeParse({ ...valid(), ...change }).success

    it('accepts the shipped file', () => {
      expect(accepts({})).toBe(true)
    })

    it('needs every renderer pattern to compile', () => {
      const { tierPicker } = valid()
      expect(accepts({ tierPicker: { ...tierPicker, lowRendererPatterns: ['mali-('] } })).toBe(
        false,
      )
      expect(accepts({ tierPicker: { ...tierPicker, highRendererPatterns: ['[a-'] } })).toBe(false)
      expect(accepts({ tierPicker: { ...tierPicker, highRendererPatterns: [] } })).toBe(false)
      expect(accepts({ tierPicker: { ...tierPicker, lowRendererPatterns: [''] } })).toBe(false)
    })

    it('keeps every high threshold at or above its low threshold', () => {
      const { tierPicker } = valid()
      const atLow = { ...tierPicker, highAtLeast: tierPicker.lowBelow }
      expect(accepts({ tierPicker: atLow })).toBe(true)
      const below = { ...tierPicker, highAtLeast: { ...tierPicker.highAtLeast, cores: 2 } }
      expect(accepts({ tierPicker: below })).toBe(false)
    })

    it('needs sustainMs to be a whole number of sampleMs windows', () => {
      const { fpsStepDown } = valid()
      expect(accepts({ fpsStepDown: { ...fpsStepDown, sampleMs: 300 } })).toBe(true)
      expect(accepts({ fpsStepDown: { ...fpsStepDown, sampleMs: 400 } })).toBe(false)
      expect(accepts({ fpsStepDown: { ...fpsStepDown, sampleMs: 0 } })).toBe(false)
    })

    it('bounds the step-down threshold and step count', () => {
      const { fpsStepDown } = valid()
      expect(accepts({ fpsStepDown: { ...fpsStepDown, threshold: 1 } })).toBe(true)
      expect(accepts({ fpsStepDown: { ...fpsStepDown, threshold: 0 } })).toBe(false)
      expect(accepts({ fpsStepDown: { ...fpsStepDown, threshold: 1.1 } })).toBe(false)
      expect(accepts({ fpsStepDown: { ...fpsStepDown, maxSteps: 0 } })).toBe(true)
      expect(accepts({ fpsStepDown: { ...fpsStepDown, maxSteps: 3 } })).toBe(false)
    })

    it('sizes a shadow map exactly where the tier has the directional PCF shadow', () => {
      expect(accepts({ shadowMapSizePx: { low: 0, mid: 0, high: 0 } })).toBe(false)
      expect(accepts({ shadowMapSizePx: { low: 0, mid: 512, high: 2048 } })).toBe(false)
      expect(accepts({ shadowMapSizePx: { low: 0, mid: 0, high: 1.5 } })).toBe(false)
    })

    it('bounds building density to (0, 1] and allows no postprocessing', () => {
      expect(accepts({ buildingDensity: { low: 0, mid: 0.8, high: 1 } })).toBe(false)
      expect(accepts({ buildingDensity: { low: 0.5, mid: 0.8, high: 1.2 } })).toBe(false)
      expect(PerfConfigSchema.safeParse({ ...valid(), postprocessing: 'bloom' }).success).toBe(
        false,
      )
    })

    it('needs an odd number of cold runs and a known throttle profile', () => {
      const { perfRun } = valid()
      expect(accepts({ perfRun: { ...perfRun, coldRuns: 1 } })).toBe(true)
      expect(accepts({ perfRun: { ...perfRun, coldRuns: 4 } })).toBe(false)
      expect(accepts({ perfRun: { ...perfRun, profile: 'cc-slow-3g' } })).toBe(false)
    })
  })
})

describe('config/realtime.json and moderation', () => {
  it('uses the defaults from CLAUDE.md', () => {
    expect(realtime).toMatchObject({
      shardSize: 16,
      maxFriendFanout: 50,
      heartbeatIntervalMs: 60_000,
    })
  })

  it('rejects zero or fractional limits', () => {
    const valid = readJson('config/realtime.json') as Record<string, unknown>
    expect(RealtimeConfigSchema.safeParse({ ...valid, shardSize: 0 }).success).toBe(false)
    expect(RealtimeConfigSchema.safeParse({ ...valid, shardSize: 16.5 }).success).toBe(false)
    const moderationValid = readJson('config/moderation.json') as Record<string, unknown>
    expect(ModerationConfigSchema.safeParse(moderationValid).success).toBe(true)
    expect(
      ModerationConfigSchema.safeParse({ ...moderationValid, autoHideReports: 0 }).success,
    ).toBe(false)
    expect(
      ModerationConfigSchema.safeParse({ ...moderationValid, noteMaxChars: 2.5 }).success,
    ).toBe(false)
    expect(
      ModerationConfigSchema.safeParse({
        ...moderationValid,
        retention: { evidenceDays: 900, reportRowDays: 730, auditDays: 730, appealDays: 180 },
      }).success,
    ).toBe(false)
  })
})

describe('config/sync.json (S18c)', () => {
  const valid = () => structuredClone(readJson('config/sync.json')) as Record<string, unknown>

  it('holds the S18c defaults (TUNE-10 placeholders)', () => {
    expect(sync).toMatchObject({
      debounceMs: 10_000,
      maxWaitMs: 60_000,
      maxSaveBytes: 262_144,
      keepaliveMaxBytes: 61_440,
      plausibility: { margin: 1.5, maxActionsPerRealMinute: 40, burstRealMinutes: 5 },
    })
  })

  it("matches the saves table's own size check", () => {
    const migrations = join(DATA, '../supabase/migrations')
    const sql = readdirSync(migrations)
      .filter((file) => file.endsWith('.sql'))
      .map((file) => readFileSync(join(migrations, file), 'utf8'))
      .join('\n')
    const limit = /octet_length\(data::text\) <= (\d+)/.exec(sql)?.[1]
    expect(Number(limit)).toBe(sync.maxSaveBytes)
  })

  it.each<[string, (file: Record<string, unknown>) => void]>([
    ['a debounce longer than the max wait', (file) => void (file.debounceMs = 120_000)],
    ['a retry base above its max', (file) => void (file.retry = { baseMs: 10, maxMs: 5 })],
    ['a keepalive body over 64 KiB', (file) => void (file.keepaliveMaxBytes = 65_537)],
    ['a keepalive body over the save limit', (file) => void (file.maxSaveBytes = 1000)],
    ['more uploads than fit a minute', (file) => void (file.maxUploadsPerMinute = 13)],
    [
      'a margin below 1',
      (file) =>
        void (file.plausibility = {
          margin: 0.9,
          maxActionsPerRealMinute: 40,
          burstRealMinutes: 5,
        }),
    ],
    ['an unknown key', (file) => void (file.extra = 1)],
  ])('rejects %s', (_label, mutate) => {
    const file = valid()
    expect(SyncConfigSchema.safeParse(file).success).toBe(true)
    mutate(file)
    expect(SyncConfigSchema.safeParse(file).success).toBe(false)
  })
})

describe('config/onboarding.json', () => {
  it('holds the CLAUDE.md age rule: 18+, a 24 h lock on that device', () => {
    expect(onboarding).toMatchObject({ minimumAge: 18, underAgeLockHours: 24 })
    expect(onboarding.birthYearSpan).toBeGreaterThan(onboarding.minimumAge + 1)
  })

  it('rejects a fractional lock, a non-date consent version and a span nobody can pass', () => {
    const valid = readJson('config/onboarding.json') as Record<string, unknown>
    const parse = (patch: Record<string, unknown>) =>
      OnboardingConfigSchema.safeParse({ ...valid, ...patch }).success
    expect(parse({})).toBe(true)
    expect(parse({ underAgeLockHours: 0.5 })).toBe(false)
    expect(parse({ consentVersion: 'v1' })).toBe(false)
    expect(parse({ birthYearSpan: 19 })).toBe(false)
    expect(parse({ extra: true })).toBe(false)
  })
})

describe('config/layout.json', () => {
  it('holds the 300 ms panel action cooldown', () => {
    expect(layout.overlay.actionCooldownMs).toBe(300)
  })

  it('rejects a missing, zero, negative or fractional action cooldown', () => {
    const valid = readJson('config/layout.json') as { overlay: Record<string, unknown> }
    const parse = (patch: Record<string, unknown>) =>
      LayoutConfigSchema.safeParse({ ...valid, overlay: { ...valid.overlay, ...patch } }).success
    expect(parse({})).toBe(true)
    expect(parse({ actionCooldownMs: undefined })).toBe(false)
    expect(parse({ actionCooldownMs: 0 })).toBe(false)
    expect(parse({ actionCooldownMs: -300 })).toBe(false)
    expect(parse({ actionCooldownMs: 300.5 })).toBe(false)
  })
})

describe('config/audio.json', () => {
  it('has a default for every channel and a step that divides 100', () => {
    expect(Object.keys(audio.defaults).sort()).toEqual(
      ['ambience', 'master', 'music', 'sfx', 'voice'].sort(),
    )
    expect(100 % audio.volumeStep).toBe(0)
  })

  it('rejects a step that does not divide 100, off-step defaults and an over-long crossfade', () => {
    const valid = readJson('config/audio.json') as Record<string, unknown>
    const parse = (patch: Record<string, unknown>) =>
      AudioConfigSchema.safeParse({ ...valid, ...patch }).success
    expect(parse({})).toBe(true)
    expect(parse({ volumeStep: 7 })).toBe(false)
    expect(parse({ defaults: { ...audio.defaults, music: 62 } })).toBe(false)
    expect(parse({ defaults: { ...audio.defaults, music: 120 } })).toBe(false)
    expect(parse({ musicCrossfadeSeconds: 500 })).toBe(false)
    expect(parse({ prefetchAheadSeconds: 1 })).toBe(false)
  })
})

describe('data/audio/manifest.json and public/audio', () => {
  const PUBLIC = join(DATA, '../public')
  const sourcesOf = audioManifest.tracks.flatMap((track) =>
    track.sources.map((source) => ({ track, source })),
  )

  it('every file exists in public/ with the recorded size and sha256', () => {
    for (const { source } of sourcesOf) {
      const bytes = readFileSync(join(PUBLIC, source.file))
      expect(bytes.byteLength, source.file).toBe(source.bytes)
      expect(createHash('sha256').update(bytes).digest('hex'), source.file).toBe(source.sha256)
    }
  })

  it('public/audio holds nothing the manifest does not list', () => {
    const listed = new Set(sourcesOf.map(({ source }) => source.file))
    const onDisk = readdirSync(join(PUBLIC, 'audio'), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name !== '.DS_Store')
      .map(
        (entry) => `/${relative(PUBLIC, join(entry.parentPath, entry.name)).split('\\').join('/')}`,
      )
    expect(onDisk.filter((file) => !listed.has(file))).toEqual([])
  })

  it('every music track has a "Title by Artist" copy key', () => {
    const keys = new Set(Object.keys(baseCopy.strings))
    for (const track of audioManifest.tracks.filter((entry) => entry.channel === 'music')) {
      expect(track.titleKey !== undefined && keys.has(track.titleKey), track.id).toBe(true)
    }
  })

  it('is CC0 only, from https pages, with every sound listed in SOURCES.md', () => {
    const sourcesMd = readFileSync(join(DATA, 'audio/SOURCES.md'), 'utf8')
    for (const track of audioManifest.tracks) {
      expect(track.license).toBe('CC0-1.0')
      expect(track.sourceUrl.startsWith('https://'), track.id).toBe(true)
      expect(sourcesMd.includes(`\`${track.id}\``), track.id).toBe(true)
      for (const source of track.sources) expect(source.file.startsWith('/audio/')).toBe(true)
    }
  })

  it('every file fits the per-file cap', () => {
    for (const { source } of sourcesOf) {
      expect(statSync(join(PUBLIC, source.file)).size, source.file).toBeLessThanOrEqual(
        perf.audioFileMaxKB * 1000,
      )
    }
  })

  it.each(['low', 'mid', 'high'] as const)(
    'the first music track, the ambience and the %s-tier sfx fit audioLazyGzKB in each encoding',
    (tier) => {
      const byId = new Map(audioManifest.tracks.map((track) => [track.id, track]))
      const initial = [audioManifest.playlists.music[0], audioManifest.playlists.ambience[0]]
      if (audio.tiers[tier].preloadSfx) initial.push(...Object.values(audioManifest.sfx))
      for (const type of ['audio/webm; codecs=opus', 'audio/mp4; codecs=mp4a.40.2']) {
        // Audio is already compressed; gzip would not shrink it, so bytes count as is.
        const bytes = initial.reduce((sum, id) => {
          const source = byId.get(id ?? '')?.sources.find((entry) => entry.type === type)
          if (source === undefined) throw new Error(`${id} has no ${type} source`)
          return sum + source.bytes
        }, 0)
        expect(bytes, `${tier} ${type}`).toBeLessThanOrEqual(perf.audioLazyGzKB[tier] * 1000)
      }
    },
  )
})

describe('config/theme.json', () => {
  it('has the real-world interface (DEC-26): one taxi yellow, no indigo or hot pink in the UI', () => {
    expect(theme.colors['taxi-400']).toBe('#f5b800')
    expect(theme.models['taxi-400']).toBe('#f5b800')
    for (const ui of [theme.ui.day, theme.ui.night]) {
      expect(ui.taxi).toBe('taxi-400')
      for (const token of Object.values(ui))
        expect(token).not.toMatch(/^(night|pink|indigo|violet)-/)
    }
    expect(
      Object.keys(theme.colors).filter((token) => /^(night|indigo|violet)-/.test(token)),
    ).toEqual([])
  })

  it('rejects a bad hex, a themeColor that names no token and a ui colour that names none', () => {
    const valid = () =>
      structuredClone(readJson('config/theme.json')) as {
        colors: Record<string, string>
        themeColor: { day: string; night: string }
        ui: { day: Record<string, string> }
      }
    expect(ThemeConfigSchema.safeParse(valid()).success).toBe(true)
    const badHex = valid()
    badHex.colors['taxi-400'] = 'yellow'
    expect(ThemeConfigSchema.safeParse(badHex).success).toBe(false)
    const badThemeColor = valid()
    badThemeColor.themeColor.night = 'nope-1'
    expect(ThemeConfigSchema.safeParse(badThemeColor).success).toBe(false)
    const badUi = valid()
    badUi.ui.day.fg = 'nope-100'
    expect(ThemeConfigSchema.safeParse(badUi).success).toBe(false)
    const missingToken = valid()
    delete missingToken.ui.day.meter
    expect(ThemeConfigSchema.safeParse(missingToken).success).toBe(false)
  })
})

describe('config/progression.json (S15)', () => {
  const schema = createProgressionConfigSchema(balance.clout.levels)
  const valid = () => structuredClone(readJson('config/progression.json')) as ProgressionShape
  type ProgressionShape = {
    goals: {
      id: string
      fact: string
      level?: string
      available?: boolean
      victory?: true
      reward: { cash?: number; clout?: number; badge?: true }
    }[]
    grants: {
      capPctOfGap: { cash: number; clout: number }
      maxPerGrant: { cash: number; clout: number }
    }
    prestige: { requiresGoal: string; badgeIds: string[]; resets: string[]; keeps: string[] }
  }
  const goal = (file: ProgressionShape, id: string) => {
    const found = file.goals.find((entry) => entry.id === id)
    if (found === undefined) throw new Error(`no goal ${id}`)
    return found
  }

  it('lists the S15 goals: five firsts and one goal per clout level above Nobody', () => {
    expect(progression.goals.map((entry) => entry.id)).toEqual([
      'first-paycheck',
      'first-outfit',
      'first-landmark-visit',
      'first-club-night',
      'first-friend',
      'reach-local',
      'reach-scene-regular',
      'reach-known',
      'reach-famous',
      'reach-icon',
    ])
    expect(progression.prestige.requiresGoal).toBe('reach-icon')
  })

  it('accepts the shipped file and the intra-file rules on their own', () => {
    expect(schema.safeParse(valid()).success).toBe(true)
    expect(ProgressionConfigSchema.safeParse(valid()).success).toBe(true)
  })

  it.each<[string, (file: ProgressionShape) => void]>([
    ['a duplicate goal id', (file) => void (goal(file, 'first-outfit').id = 'first-paycheck')],
    ['a goal id that is not kebab case', (file) => void (goal(file, 'first-outfit').id = 'Bad_Id')],
    ['an unknown fact', (file) => void (goal(file, 'first-outfit').fact = 'first-kiss')],
    ['a level on a non-level goal', (file) => void (goal(file, 'first-outfit').level = 'local')],
    ['a level goal without a level', (file) => void delete goal(file, 'reach-local').level],
    ['a level that does not exist', (file) => void (goal(file, 'reach-local').level = 'mayor')],
    ['two goals for one level', (file) => void (goal(file, 'reach-known').level = 'local')],
    ['no victory goal', (file) => void delete goal(file, 'reach-icon').victory],
    ['two victory goals', (file) => void (goal(file, 'reach-famous').victory = true)],
    [
      'a victory goal below the top level',
      (file) => {
        delete goal(file, 'reach-icon').victory
        goal(file, 'reach-famous').victory = true
        file.prestige.requiresGoal = 'reach-famous'
      },
    ],
    ['a badge on another goal', (file) => void (goal(file, 'first-outfit').reward.badge = true)],
    ['cash beside the badge', (file) => void (goal(file, 'reach-icon').reward.cash = 10)],
    [
      'an item reward',
      (file) => void Object.assign(goal(file, 'first-outfit').reward, { itemId: 'denim-jacket' }),
    ],
    [
      'a cash reward over maxPerGrant',
      (file) => void (goal(file, 'first-outfit').reward.cash = file.grants.maxPerGrant.cash + 1),
    ],
    [
      'a clout reward over maxPerGrant',
      (file) => void (goal(file, 'first-outfit').reward.clout = file.grants.maxPerGrant.clout + 1),
    ],
    ['a fractional reward', (file) => void (goal(file, 'first-outfit').reward.cash = 2.5)],
    ['a cap of 0 percent', (file) => void (file.grants.capPctOfGap.cash = 0)],
    ['a cap of 100 percent', (file) => void (file.grants.capPctOfGap.clout = 100)],
    [
      'prestige requiring a non-victory goal',
      (file) => void (file.prestige.requiresGoal = 'reach-local'),
    ],
    ['a repeated badge id', (file) => void file.prestige.badgeIds.push('prestige-1')],
    ['a part listed twice', (file) => void file.prestige.keeps.push('cash')],
    ['a part not listed', (file) => void (file.prestige.resets = file.prestige.resets.slice(1))],
    [
      'keeping clout',
      (file) => {
        file.prestige.resets = file.prestige.resets.filter((part) => part !== 'clout')
        file.prestige.keeps.push('clout')
      },
    ],
    [
      'resetting premium clout',
      (file) => {
        file.prestige.keeps = file.prestige.keeps.filter((part) => part !== 'premium')
        file.prestige.resets.push('premium')
      },
    ],
  ])('rejects %s', (_label, mutate) => {
    const file = valid()
    mutate(file)
    expect(schema.safeParse(file).success).toBe(false)
  })

  it('keeps outfits through prestige (user ruling Q-8), and may move inventory back to resets', () => {
    const file = valid()
    expect(file.prestige.keeps).toContain('inventory')
    file.prestige.keeps = file.prestige.keeps.filter((part) => part !== 'inventory')
    file.prestige.resets.push('inventory')
    expect(schema.safeParse(file).success).toBe(true)
  })
})

describe('config/balance.json', () => {
  it('holds the CLAUDE.md balance anchors', () => {
    expect(balance.time).toMatchObject({
      gameMinutesPerRealMinute: 10,
      gameDayHours: 24,
      rentPeriodGameDays: 7,
      speeds: [1, 2],
    })
    expect(balance.start).toEqual({ cash: 150, home: 'queens-room' })
    expect(balance.rentPerWeek).toEqual({
      'queens-room': 280,
      'brooklyn-1br': 520,
      'manhattan-loft': 1100,
    })
    expect(balance.jobs).toMatchObject({
      shiftHours: 4,
      hourlyWage: { barista: 14, retail: 16, delivery: 18, 'junior-dev': 35 },
    })
    expect(balance.costs).toEqual({ food: { min: 4, max: 12 }, subwayFare: 3 })
  })

  it('rejects an inverted range and fractional dollars', () => {
    const valid = readJson('config/balance.json') as Record<string, unknown>
    const costs = { food: { min: 12, max: 4 }, subwayFare: 3 }
    expect(BalanceConfigSchema.safeParse({ ...valid, costs }).success).toBe(false)
    const start = { cash: 150.5, home: 'queens-room' }
    expect(BalanceConfigSchema.safeParse({ ...valid, start }).success).toBe(false)
  })

  it('rejects clock speeds without 1x, stats above the max and oversized actions', () => {
    const valid = readJson('config/balance.json') as BalanceConfig
    const time = (patch: Partial<BalanceConfig['time']>) => ({
      ...valid,
      time: { ...valid.time, ...patch },
    })
    expect(BalanceConfigSchema.safeParse(time({ speeds: [2, 1] })).success).toBe(false)
    expect(BalanceConfigSchema.safeParse(time({ speeds: [1, 1] })).success).toBe(false)
    expect(BalanceConfigSchema.safeParse(time({ startMinuteOfDay: 1440 })).success).toBe(false)
    const stats = { ...valid.stats, start: { ...valid.stats.start, mood: valid.stats.max + 1 } }
    expect(BalanceConfigSchema.safeParse({ ...valid, stats }).success).toBe(false)
    const huge = {
      durationMin: valid.actions.maxDurationMin + 1,
      cashCost: 0,
      energyCost: 0,
      statEffects: {},
    }
    const actions = { ...valid.actions, catalog: { ...valid.actions.catalog, huge } }
    expect(BalanceConfigSchema.safeParse({ ...valid, actions }).success).toBe(false)
    const effect = { durationMin: 1, cashCost: 0, energyCost: 0, statEffects: { mood: -101 } }
    const badEffect = { ...valid.actions, catalog: { effect } }
    expect(BalanceConfigSchema.safeParse({ ...valid, actions: badEffect }).success).toBe(false)
  })

  it('rejects a borough rule with an unknown clout level, a missing borough or bad access', () => {
    const valid = readJson('config/balance.json') as BalanceConfig
    const boroughs = (patch: Record<string, unknown>) => ({
      ...valid,
      boroughs: { ...valid.boroughs, ...patch },
    })
    expect(BalanceConfigSchema.safeParse(boroughs({})).success).toBe(true)
    const mayor = { brooklyn: { access: 'clout', level: 'mayor' } }
    expect(BalanceConfigSchema.safeParse(boroughs(mayor)).success).toBe(false)
    expect(BalanceConfigSchema.safeParse(boroughs({ queens: { access: 'clout' } })).success).toBe(
      false,
    )
    expect(BalanceConfigSchema.safeParse(boroughs({ queens: { access: 'vip' } })).success).toBe(
      false,
    )
    const withoutBronx: Partial<BalanceConfig['boroughs']> = { ...valid.boroughs }
    delete withoutBronx.bronx
    expect(BalanceConfigSchema.safeParse({ ...valid, boroughs: withoutBronx }).success).toBe(false)
  })

  it('rejects venue hours that never open and a station venue without its station', () => {
    const file = readJson('venues/venues.json') as { venues: Record<string, unknown>[] }
    const withVenue = (index: number, patch: Record<string, unknown>) => ({
      venues: [{ ...file.venues[index], ...patch }],
    })
    const station = file.venues.findIndex((venue) => venue.type === 'subway-station')
    const shop = file.venues.findIndex((venue) => venue.type === 'coffee-shop')
    expect(VenuesFileSchema.safeParse(withVenue(shop, {})).success).toBe(true)
    const same = { hours: { open: '09:00', close: '09:00' } }
    expect(VenuesFileSchema.safeParse(withVenue(shop, same)).success).toBe(false)
    const late = { hours: { open: '24:00', close: '09:00' } }
    expect(VenuesFileSchema.safeParse(withVenue(shop, late)).success).toBe(false)
    expect(VenuesFileSchema.safeParse(withVenue(shop, { price: 5 })).success).toBe(false)
    expect(VenuesFileSchema.safeParse(withVenue(shop, { jobIds: ['dj'] })).success).toBe(false)
    expect(VenuesFileSchema.safeParse(withVenue(station, { stationId: undefined })).success).toBe(
      false,
    )
    expect(VenuesFileSchema.safeParse(withVenue(station, { jobIds: ['retail'] })).success).toBe(
      false,
    )
  })

  it('food actions cost within the food range', () => {
    for (const id of ['bodega-breakfast', 'home-meal']) {
      const cost = balance.actions.catalog[id]?.cashCost
      expect(cost, id).toBeGreaterThanOrEqual(balance.costs.food.min)
      expect(cost, id).toBeLessThanOrEqual(balance.costs.food.max)
    }
  })
})

describe('content schemas', () => {
  const item = {
    id: 'tee',
    nameKey: 'items.tee.name',
    descriptionKey: 'items.tee.description',
    category: 'clothing',
    slot: 'top',
    rarity: 'common',
    currency: 'cash',
    price: 20,
    sellValue: 8,
    cloutValue: 1,
    styleValue: 1,
    statEffects: { mood: 2 },
  }

  it('rejects an item that sells for more than it costs, or an unknown stat', () => {
    expect(ItemsFileSchema.safeParse({ items: [item] }).success).toBe(true)
    expect(ItemsFileSchema.safeParse({ items: [{ ...item, sellValue: 21 }] }).success).toBe(false)
    expect(
      ItemsFileSchema.safeParse({ items: [{ ...item, statEffects: { luck: 1 } }] }).success,
    ).toBe(false)
  })

  it('rejects duplicate ids', () => {
    expect(ItemsFileSchema.safeParse({ items: [item, item] }).success).toBe(false)
  })

  it('rejects a premium item with a sellValue or a non-USD currency', () => {
    const premium = premiumItems[0]
    expect(PremiumFileSchema.safeParse({ items: [{ ...premium, sellValue: 1 }] }).success).toBe(
      false,
    )
    expect(PremiumFileSchema.safeParse({ items: [{ ...premium, currency: 'cash' }] }).success).toBe(
      false,
    )
  })

  it('rejects a landmark with an unknown category or no nameMode', () => {
    const noMode: Record<string, unknown> = { ...landmarks[0] }
    delete noMode.nameMode
    expect(LandmarksFileSchema.safeParse({ landmarks: [noMode] }).success).toBe(false)
    const tower = { ...landmarks[0], category: 'tower' }
    expect(LandmarksFileSchema.safeParse({ landmarks: [tower] }).success).toBe(false)
  })

  it('accepts only CC0 audio tracks with an https source, served from /audio/', () => {
    const valid = readJson('audio/manifest.json') as { tracks: Record<string, unknown>[] }
    const withTrack = (patch: Record<string, unknown>) => ({
      ...valid,
      tracks: valid.tracks.map((track, index) => (index === 0 ? { ...track, ...patch } : track)),
    })
    const source = (valid.tracks[0]?.sources as Record<string, unknown>[])[0]
    expect(AudioManifestSchema.safeParse(withTrack({})).success).toBe(true)
    expect(AudioManifestSchema.safeParse(withTrack({ license: 'CC-BY-4.0' })).success).toBe(false)
    expect(
      AudioManifestSchema.safeParse(withTrack({ sourceUrl: 'http://example.org/x' })).success,
    ).toBe(false)
    const remote = { ...source, file: 'https://radio.example.org/live.webm' }
    expect(AudioManifestSchema.safeParse(withTrack({ sources: [remote] })).success).toBe(false)
    const wrongType = { ...source, type: 'audio/mp4; codecs=mp4a.40.2' }
    expect(AudioManifestSchema.safeParse(withTrack({ sources: [wrongType] })).success).toBe(false)
    expect(AudioManifestSchema.safeParse(withTrack({ sources: [] })).success).toBe(false)
    expect(AudioManifestSchema.safeParse(withTrack({ titleKey: undefined })).success).toBe(false)
    expect(AudioManifestSchema.safeParse(withTrack({ loopEndMs: 999_999_999 })).success).toBe(false)
  })

  it('rejects playlists and sfx that name a missing track or the wrong channel', () => {
    const valid = readJson('audio/manifest.json') as Record<string, unknown>
    const playlists = { music: ['nyc-night'], ambience: ['nyc-night'] }
    expect(AudioManifestSchema.safeParse({ ...valid, playlists }).success).toBe(false)
    const sfx = { 'ui-tap': 'nope', purchase: 'purchase', 'clout-up': 'clout-up' }
    expect(AudioManifestSchema.safeParse({ ...valid, sfx }).success).toBe(false)
  })

  it('rejects a zone with a bad CDTA or NTA code, no NTAs or a fractional centroid', () => {
    const file = readJson('zones/zones.derived.json') as { zones: Record<string, unknown>[] }
    const zone = file.zones[0]
    const withZone = (patch: Record<string, unknown>) => ({
      ...file,
      zones: [{ ...zone, ...patch }],
    })
    expect(ZonesFileSchema.safeParse(withZone({})).success).toBe(true)
    expect(ZonesFileSchema.safeParse(withZone({ cdtaCode: 'QN1' })).success).toBe(false)
    expect(ZonesFileSchema.safeParse(withZone({ ntaCodes: ['Q101'] })).success).toBe(false)
    expect(ZonesFileSchema.safeParse(withZone({ ntaCodes: [] })).success).toBe(false)
    expect(ZonesFileSchema.safeParse(withZone({ centroid: { x: 1.5, y: 0 } })).success).toBe(false)
  })

  it('rejects a derived geo file that drops its derived flag or names another projection', () => {
    const file = readJson('geo/water.derived.json') as Record<string, unknown>
    expect(WaterFileSchema.safeParse(file).success).toBe(true)
    expect(WaterFileSchema.safeParse({ ...file, derived: false }).success).toBe(false)
    const projection = { id: 'other', originLat: 40.7, originLng: -73.98 }
    expect(WaterFileSchema.safeParse({ ...file, projection }).success).toBe(false)
  })

  it('rejects geo config whose station tolerance is below the simplification error', () => {
    const valid = readJson('config/geo.json') as Record<string, unknown>
    expect(GeoConfigSchema.safeParse(valid).success).toBe(true)
    expect(GeoConfigSchema.safeParse({ ...valid, stationOnLineToleranceM: 8 }).success).toBe(false)
  })
})

describe('cross-file references', () => {
  const copyKeys = new Set(Object.keys(baseCopy.strings))

  // Each content file's keys live in the one namespace its consumer loads (S05c): events in
  // `events` (EventSheet), items in `items` (shopCopy), places in `venues` and `landmarks`
  // (world/places), and so on. A key elsewhere would render as CopyNamespaceNotLoadedError.
  const refsByNamespace: Readonly<Record<string, readonly string[]>> = {
    items: items.flatMap((entry) => [entry.nameKey, entry.descriptionKey]),
    premium: premiumItems.map((entry) => entry.nameKey),
    events: events.flatMap((entry) => [
      entry.titleKey,
      entry.bodyKey,
      ...entry.choices.flatMap((choice) => [choice.labelKey, choice.resultKey]),
    ]),
    jobs: jobs.map((entry) => entry.nameKey),
    venues: venues.flatMap((entry) => [entry.nameKey, entry.blurbKey]),
    landmarks: landmarks.flatMap((entry) => [entry.nameKey, entry.infoKey]),
    club: Object.values(balance.place.clubs).map((club) => club.refusalKey),
    colors: items.flatMap((entry) => entry.decor?.variants.map((variant) => variant.nameKey) ?? []),
    housing: Object.values(homeInteriors).flatMap((home) => home.slots.map((slot) => slot.nameKey)),
  }

  it('every copy key named by content exists in data/copy', () => {
    const refs = Object.values(refsByNamespace).flat()
    expect(refs.filter((key) => !copyKeys.has(key))).toEqual([])
  })

  it.each(Object.entries(refsByNamespace))(
    'content keys for %s live in that copy namespace',
    (namespace, refs) => {
      expect(refs.length).toBeGreaterThan(0)
      expect(refs.filter((key) => !key.startsWith(`${namespace}.`))).toEqual([])
    },
  )

  it('jobs and balance wages list the same job ids', () => {
    expect(jobs.map((job) => job.id).sort()).toEqual([...JOB_IDS].sort())
    expect(Object.keys(balance.jobs.hourlyWage).sort()).toEqual([...JOB_IDS].sort())
  })

  it('every premium price tier exists in balance', () => {
    const tiers = Object.keys(balance.premiumPriceTiersUsd)
    expect(premiumItems.filter((entry) => !tiers.includes(entry.priceTier))).toEqual([])
  })

  it('every venue and landmark sits inside the NYC extent', () => {
    const outside = [...venues, ...landmarks].filter(
      ({ location: { lat, lng } }) =>
        lng < geoBounds.west ||
        lng > geoBounds.east ||
        lat < geoBounds.south ||
        lat > geoBounds.north,
    )
    expect(outside).toEqual([])
  })
})

describe('economy baseline (S12, read by S18c)', () => {
  const file = readJson('sim/economy-baseline.derived.json') as Record<string, unknown>

  it('rejects a best job with no run, a negative ceiling and an unknown field', () => {
    expect(EconomyBaselineSchema.safeParse(file).success).toBe(true)
    expect(EconomyBaselineSchema.safeParse({ ...file, bestJob: 'junior-dev' }).success).toBe(false)
    const cash = { maxGainPerAction: -1, maxGainPerGameDay: 0, maxGainPerGameHour: 0 }
    expect(EconomyBaselineSchema.safeParse({ ...file, cash }).success).toBe(false)
    expect(EconomyBaselineSchema.safeParse({ ...file, extra: 1 }).success).toBe(false)
  })
})
