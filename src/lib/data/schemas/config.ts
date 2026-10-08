/**
 * Schemas for /data/config. This file imports only `zod` and dependency-free modules by relative
 * `.ts` paths (`../homes.ts`, `../cloutSources.ts`, `../goalFacts.ts`, `../../geo/sources.ts`,
 * `../../geo/projection.ts`, `./assets.ts`; no path aliases) so Node can load it directly from `scripts/` with its
 * built-in type stripping.
 */
import { z } from 'zod'
import { STYLED_SOURCES } from '../cloutSources.ts'
import {
  GOAL_FACTS,
  PRESTIGE_MUST_KEEP,
  PRESTIGE_MUST_RESET,
  PRESTIGE_PARTS,
} from '../goalFacts.ts'
import { BUILDING_DISTRICT_IDS } from '../../geo/sources.ts'
import { distanceM, project } from '../../geo/projection.ts'
import { HOME_IDS, lowestRentHome } from '../homes.ts'
import {
  LandmarkPaletteRefsSchema,
  LandmarkTrianglesMaxSchema,
  LandmarkTrianglesOverrideSchema,
} from './landmarkModels.ts'
import { MODEL_CATEGORIES, type ModelCategory } from './assets.ts'

export const QUALITY_TIERS = ['low', 'mid', 'high'] as const
export const QualityTierSchema = z.enum(QUALITY_TIERS)
export type QualityTier = z.infer<typeof QualityTierSchema>

const positive = z.number().positive()
const positiveInt = z.int().positive()

/** One value per quality tier. Rows that CLAUDE.md marks "same" for every tier are scalars. */
function perTier<T extends z.ZodType>(value: T) {
  return z.strictObject({ low: value, mid: value, high: value })
}

/** Throttle profile for `npm run e2e:perf`. */
export const ThrottleProfileSchema = z.strictObject({
  downloadKbps: positive,
  uploadKbps: positive,
  rttMs: z.number().nonnegative(),
  cpuSlowdown: z.number().min(1),
  viewport: z.strictObject({ width: positiveInt, height: positiveInt }),
})
export type ThrottleProfile = z.infer<typeof ThrottleProfileSchema>

/** True when `source` compiles as a case-insensitive regular expression. */
function compiles(source: string): boolean {
  try {
    new RegExp(source, 'i')
    return true
  } catch {
    return false
  }
}

const rendererPatterns = z
  .array(z.string().min(1).refine(compiles, { error: 'must be a valid regular expression' }))
  .min(1)

/** Device signals the tier picker compares against thresholds; each may be unknown on a device. */
const TierSignalThresholdsSchema = z.strictObject({
  maxTextureSize: positiveInt,
  /** `navigator.deviceMemory` (GB; browsers report 0.25 to 8 in powers of two). */
  deviceMemoryGb: positive,
  /** `navigator.hardwareConcurrency`. */
  cores: positiveInt,
})

/**
 * The automatic tier picker (S04b, src/lib/quality/tier.ts). Renderer patterns are
 * case-insensitive regular expressions matched against the WebGL renderer string. TUNE-6
 * placeholders until checked on real devices.
 */
export const TierPickerSchema = z
  .strictObject({
    /** A renderer matching any of these is low (software rasterisers, old mobile GPUs). */
    lowRendererPatterns: rendererPatterns,
    /** High needs a renderer matching one of these, plus every known signal at `highAtLeast`. */
    highRendererPatterns: rendererPatterns,
    /** A known signal strictly below its value makes the device low. */
    lowBelow: TierSignalThresholdsSchema,
    /** Each known signal must be at least this for high. */
    highAtLeast: TierSignalThresholdsSchema,
  })
  .refine(
    (picker) =>
      (Object.keys(picker.lowBelow) as (keyof typeof picker.lowBelow)[]).every(
        (signal) => picker.highAtLeast[signal] >= picker.lowBelow[signal],
      ),
    { error: 'highAtLeast must not be below lowBelow', path: ['highAtLeast'] },
  )
export type TierPicker = z.infer<typeof TierPickerSchema>

/**
 * Runtime step-down (drei PerformanceMonitor): FPS is averaged over `sampleMs` windows, and one
 * tier is dropped when more than `threshold` of the `sustainMs / sampleMs` windows are below
 * `belowFps`. Hysteresis: at most `maxSteps` drops per session, `cooldownMs` apart, and never an
 * automatic step up.
 */
export const FpsStepDownSchema = z
  .strictObject({
    belowFps: positive,
    sustainMs: positiveInt,
    sampleMs: positiveInt,
    threshold: z.number().gt(0).max(1),
    cooldownMs: z.int().nonnegative(),
    maxSteps: z
      .int()
      .nonnegative()
      .max(QUALITY_TIERS.length - 1),
  })
  .refine((rule) => rule.sustainMs % rule.sampleMs === 0, {
    error: 'sustainMs must be a whole number of sampleMs windows',
    path: ['sustainMs'],
  })
export type FpsStepDown = z.infer<typeof FpsStepDownSchema>

/** How `npm run e2e:perf` measures (S04b). */
export const PerfRunSchema = z.strictObject({
  /** Cold loads per measurement; the median is asserted, so the count is odd. */
  coldRuns: positiveInt.refine((runs) => runs % 2 === 1, { error: 'must be odd' }),
  /** The tier forced for the cold-load timings. */
  coldTier: QualityTierSchema,
  /** A key of `throttleProfiles`. */
  profile: z.string().min(1),
  /** Measuring waits until the 1-minute load average per CPU core is at most this. */
  maxLoadPerCore: positive,
  loadWaitMaxMs: positiveInt,
  loadPollMs: positiveInt,
  /** How long a run waits for another checkout's perf run to release the machine-wide lock. */
  lockWaitMaxMs: positiveInt,
})
export type PerfRun = z.infer<typeof PerfRunSchema>

/**
 * Every row of CLAUDE.md "Performance budgets", plus the per-tier render settings and the quality
 * tier rules (S04b). Sizes are gzipped KB (1 KB = 1000 bytes, so 1.2 MB = 1200 KB); times are
 * milliseconds.
 */
export const PerfConfigSchema = z
  .strictObject({
    /** Shell JS of route `/`, before the 3D chunk. Read by `npm run budget`. */
    shellJsGzKB: positive,
    /**
     * Room the shell keeps below `shellJsGzKB` for features still to land (S05c): the shell may
     * use at most shellJsGzKB minus this. Read by scripts/shell-guard.ts.
     */
    shellHeadroomGzKB: z.number().nonnegative(),
    sceneChunkJsGzKB: positive,
    /**
     * The apartment's 3D chunk (S16, `cc-feature:apartment-scene`): loaded when the Home panel
     * opens, so `npm run budget` reports it on its own and leaves it out of the 3D chunk counted
     * before the map is playable.
     */
    apartmentChunkJsGzKB: positive,
    /** Shell JS, the boot islands and the 3D chunk, each file once. */
    totalJsToPlayableGzKB: positive,
    baseGeoGzKB: positive,
    districtBuildingsGzKB: perTier(positive),
    /** Audio excluded: it loads after the player's choice. */
    totalBytesToPlayableGzKB: perTier(positive),
    shellInteractiveColdMs: positive,
    playableColdMs: perTier(positive),
    playableWarmMs: positive,
    /** `renderer.info.render.calls` at the default Queens-start camera. */
    drawCallsMax: perTier(positiveInt),
    trianglesMax: perTier(positiveInt),
    /**
     * Shader programs the city's renderer holds once its models have loaded
     * (`renderer.info.programs`, S04f): the day/night cycle changes uniforms only, so the count
     * is the same at every time of day. Set from a measurement + 10% (Q9).
     */
    programsMax: perTier(positiveInt),
    /**
     * The apartment interior (S16), per tier: `renderer.info.render` draw calls and triangles of
     * the room with every slot filled. `avatarReserve` is kept free inside both caps for the 3D
     * avatar standing in the room (S16a), so the room alone must stay within the cap minus it.
     */
    apartment: z
      .strictObject({
        drawCallsMax: perTier(positiveInt),
        trianglesMax: perTier(positiveInt),
        avatarReserve: z.strictObject({ drawCalls: positiveInt, triangles: positiveInt }),
      })
      .refine(
        (a) =>
          QUALITY_TIERS.every(
            (tier) =>
              a.avatarReserve.drawCalls < a.drawCallsMax[tier] &&
              a.avatarReserve.triangles < a.trianglesMax[tier],
          ),
        { error: 'the avatar reserve must leave room for the apartment in every tier' },
      ),
    dprCap: perTier(positive),
    /** `pcf-directional` means one directional light with PCFShadowMap, never PCFSoftShadowMap. */
    shadows: perTier(z.enum(['none', 'blob-or-baked', 'pcf-directional'])),
    /** Shadow map size of the directional light; 0 exactly where the tier has no such light. */
    shadowMapSizePx: perTier(z.int().nonnegative()),
    /** Read when the canvas is created, so a tier change applies it on the next load. */
    antialias: perTier(z.boolean()),
    /** Inverted-hull outlines (CLAUDE.md "Art direction": mid and high). */
    outlines: perTier(z.boolean()),
    /** Share of district buildings drawn, 0 to 1. */
    buildingDensity: perTier(z.number().gt(0).max(1)),
    /** Multiplies the distances at which detail levels switch. */
    lodDistanceScale: perTier(positive),
    /** No postprocessing pass on any tier. */
    postprocessing: z.literal('none'),
    otherPlayersMax: perTier(z.int().nonnegative()),
    otherPlayersStyle: perTier(z.enum(['billboard', 'model'])),
    /** Real reference device only (human/qa check); headless CI cannot measure FPS. */
    medianFpsMin: perTier(positive),
    /** Idle renders zero frames (`frameloop="demand"`). */
    idleFramesMax: z.literal(0),
    fpsStepDown: FpsStepDownSchema,
    tierPicker: TierPickerSchema,
    throttleProfiles: z.strictObject({ 'cc-mid-4g': ThrottleProfileSchema }),
    perfRun: PerfRunSchema,
    /**
     * Audio fetched after the player's sound choice, per tier: the first music track, the ambience
     * loop and (where the tier preloads them) the sound effects, in one encoding. Audio is not part
     * of `totalBytesToPlayableGzKB`.
     */
    audioLazyGzKB: perTier(positive),
    /** Largest single audio file. */
    audioFileMaxKB: positive,
    /** The lazily loaded audio runtime chunk (src/lib/audio/runtime.ts). */
    audioRuntimeJsGzKB: positive,
    /** The service worker script, /serwist/sw.js (S04e). Read by `npm run budget`. */
    serviceWorkerGzKB: positive,
    /**
     * Everything the service worker precaches on install (static JS/CSS/SVG/fonts, icons, pages,
     * base geo, the fallback map), gzipped. Fetched in the background after the map is playable,
     * so it is not part of `totalBytesToPlayableGzKB`. Read by `npm run budget`.
     */
    precacheGzKB: positive,
    /**
     * Triangles of every district's building masses plus the procedural blocks, per tier, as the
     * geo build counts them (TUNE-7 placeholders). Part of `trianglesMax`, not on top of it.
     */
    buildingTrianglesMax: perTier(positiveInt),
    /**
     * Triangles of one landmark model's finest level per tier (outline and windows included), by
     * landmark category (S07a). Each coarser level may have at most `landmarkLodRatioMax` of the
     * level above it.
     */
    landmarkTrianglesMax: LandmarkTrianglesMaxSchema,
    /** Per-landmark caps replacing the category caps, by landmark id. */
    landmarkTrianglesOverride: LandmarkTrianglesOverrideSchema,
    landmarkLodRatioMax: z.number().gt(0).max(1),
    /**
     * Per-asset caps for the hand-made models (S04h), by catalog category: triangles per tier and
     * gzipped bytes of the largest tier file. `npm run assets:build` fails over them and prints the
     * pressure; it never edits this file (TUNE-12: set from the Part 1 measurements).
     */
    models: z.strictObject(
      Object.fromEntries(
        MODEL_CATEGORIES.map((category) => [
          category,
          z.strictObject({ trianglesMax: perTier(z.int().nonnegative()), gzKBMax: positive }),
        ]),
      ) as Record<
        ModelCategory,
        z.ZodObject<{
          trianglesMax: ReturnType<typeof perTier<z.ZodInt>>
          gzKBMax: typeof positive
        }>
      >,
    ),
  })
  .refine(
    (perf) =>
      QUALITY_TIERS.every(
        (tier) => (perf.shadows[tier] === 'pcf-directional') === perf.shadowMapSizePx[tier] > 0,
      ),
    {
      error: 'shadowMapSizePx must be above 0 exactly where shadows is pcf-directional',
      path: ['shadowMapSizePx'],
    },
  )
  .refine((perf) => Object.hasOwn(perf.throttleProfiles, perf.perfRun.profile), {
    error: 'perfRun.profile must name a throttle profile',
    path: ['perfRun', 'profile'],
  })
export type PerfConfig = z.infer<typeof PerfConfigSchema>

const HEX_COLOR = /^#[0-9a-f]{6}$/i
const TOKEN_NAME = /^[a-z]+-\d{2,3}$/

const tokenRef = z.string().regex(TOKEN_NAME)
/** A palette token name (`taxi-400`), never a hex value; theme.json must define it. */
export const PaletteTokenRefSchema = tokenRef

/**
 * The 3D city's colours, as token names (never hex) of the world palette (theme.json `world`
 * and `models`, DEC-26 real-world colours). Land keys are the borough ids (BOROUGHS in
 * content.ts; this file imports only zod).
 */
export const ScenePaletteRefsSchema = z.strictObject({
  /**
   * The neutral haze "expanding soon" land is dimmed towards (S04c). Fixed: the sky colour
   * changes with the time of day, the dimmed land must not.
   */
  haze: tokenRef,
  /** The harbour's daytime colour (the day/night cycle tints it per keyframe, `sky.*.water`). */
  water: tokenRef,
  land: z.strictObject({
    manhattan: tokenRef,
    brooklyn: tokenRef,
    queens: tokenRef,
    bronx: tokenRef,
    'staten-island': tokenRef,
  }),
  park: tokenRef,
  cemetery: tokenRef,
  /** Cycled over the subway lines sorted by id: our own colours, never the MTA's. */
  subwayLines: z.array(tokenRef).min(1),
  subwayCasing: tokenRef,
  station: tokenRef,
  /** The player's avatar placeholder and the ring under it (S05). */
  player: tokenRef,
  /** Letter colour on the line chips (the chip itself takes its line's colour). */
  labelInk: tokenRef,
  /**
   * Place pins (S04c): by kind, teaser pins on "expanding soon" land, a muted colour for memorial
   * pins (the key avoids the word, which no config file may name), the selection ring.
   */
  pins: z.strictObject({
    venue: tokenRef,
    landmark: tokenRef,
    teaser: tokenRef,
    muted: tokenRef,
    selected: tokenRef,
  }),
  /** The "expanding soon" ground chips. */
  chip: z.strictObject({ fill: tokenRef, ink: tokenRef }),
  /** Travel (S08): the taxi and subway car the avatar rides in, and the trail behind it. */
  travel: z.strictObject({ taxi: tokenRef, train: tokenRef, trail: tokenRef }),
  /**
   * The apartment interior (S16): room surfaces, decor second colours, the window pane, slot
   * markers (idle, a slot the held item fits, the selected slot), blob shadows, and the warm
   * lamp light mixed into the room's ambient at night (S04f). Decor main colours come from each
   * item's variants (data/items/items.json, `colors`).
   */
  apartment: z.strictObject({
    background: tokenRef,
    floor: tokenRef,
    wall: tokenRef,
    trim: tokenRef,
    furniture: tokenRef,
    /** Second colours of decor: leaves, and the warm glow of bulbs and neon backing. */
    plant: tokenRef,
    glow: tokenRef,
    window: tokenRef,
    marker: tokenRef,
    markerActive: tokenRef,
    markerSelected: tokenRef,
    blob: tokenRef,
    lamp: tokenRef,
  }),
  /** Brightness steps of the shared toon gradient ramp, darkest first, each in (0, 1]. */
  toonRamp: z.array(z.number().gt(0).max(1)).min(2),
  /** The landmark kit's role palette (S07a). */
  landmarks: LandmarkPaletteRefsSchema,
  /**
   * District buildings and procedural blocks (S04d): facades (one picked per mass: brick,
   * brownstone, limestone, concrete, glass; repeat a token to weight it), roofs, the warm light
   * of lit windows at night, the low blocks outside the districts (one picked per block), and
   * the single colour blocks on "expanding soon" land are dimmed from.
   */
  buildings: z.strictObject({
    walls: z.array(tokenRef).min(1),
    roof: tokenRef,
    window: tokenRef,
    blocks: z.array(tokenRef).min(1),
    dimmedBlock: tokenRef,
  }),
})
export type ScenePaletteRefs = z.infer<typeof ScenePaletteRefsSchema>

/** Every token name a scene palette references. */
export function scenePaletteTokens(scene: ScenePaletteRefs): string[] {
  return [
    scene.haze,
    scene.water,
    ...Object.values(scene.land),
    scene.park,
    scene.cemetery,
    ...scene.subwayLines,
    scene.subwayCasing,
    scene.station,
    scene.player,
    scene.labelInk,
    ...Object.values(scene.pins),
    ...Object.values(scene.chip),
    ...Object.values(scene.travel),
    ...Object.values(scene.apartment),
    ...Object.values(scene.landmarks),
    ...scene.buildings.walls,
    scene.buildings.roof,
    scene.buildings.window,
    ...scene.buildings.blocks,
    scene.buildings.dimmedBlock,
  ]
}

const KEYFRAME_COLOR_SLOTS = [
  'sky',
  'fog',
  'sun',
  'ambient',
  'hemisphereSky',
  'hemisphereGround',
  'unlitTint',
  'water',
] as const

/** One day/night keyframe's colour slots (src/lib/dayNight/types.ts `KeyframeColors`). */
const SkyKeyframeSchema = z.strictObject(
  Object.fromEntries(KEYFRAME_COLOR_SLOTS.map((slot) => [slot, tokenRef])) as Record<
    (typeof KEYFRAME_COLOR_SLOTS)[number],
    typeof tokenRef
  >,
)

const palette = z.record(z.string().regex(TOKEN_NAME), z.string().regex(HEX_COLOR))

/** Tokens of both palettes with the same name must be the same colour (one taxi yellow). */
function clashingTokens(a: Record<string, string>, b: Record<string, string>): string[] {
  return Object.keys(a).filter(
    (token) => token in b && a[token]?.toLowerCase() !== b[token]?.toLowerCase(),
  )
}

/**
 * The interface's semantic colours (S04g), the only Tailwind colours (`bg-surface`, `text-fg`,
 * ...): each theme of `ui` maps every one to a `colors` token, and globals.css switches them with
 * the root's `data-theme`.
 */
export const UI_TOKENS = [
  'canvas',
  'glass',
  'surface',
  'raised',
  'pressed',
  'track',
  'scrim',
  'line',
  'line-strong',
  'fg',
  'muted',
  'taxi',
  'on-taxi',
  'taxi-ink',
  'danger',
  'success',
  'focus',
  'meter',
] as const
export type UiToken = (typeof UI_TOKENS)[number]

const UiPaletteSchema = z.strictObject(
  Object.fromEntries(UI_TOKENS.map((token) => [token, tokenRef])) as Record<
    UiToken,
    typeof tokenRef
  >,
)
const dayNight = <T extends z.ZodType>(value: T) => z.strictObject({ day: value, night: value })

/**
 * The palettes (DEC-26 real-world colours):
 * - `colors`: the DOM palette: interface colours (S04g) and item swatch colours (product
 *   colours, data/items/items.json variants; the root layout writes those as `--palette-<token>`).
 * - `ui`: the light day and dark-glass night interface (S04g), as `colors` tokens, with the
 *   cross-fade and the frosted glass settings.
 * - `world`: 3D-only raw colours (land, haze, subway ribbons, room surfaces, the keyframe skies).
 * - `sky`: per day/night keyframe (scene.json `dayNight`), its colour slots as world tokens.
 * - `scene`: the city's colour roles as world or models tokens.
 * - `models`: the hand-made models' real-material colours (S04h).
 */
export const ThemeConfigSchema = z
  .strictObject({
    colors: palette,
    ui: z.strictObject({
      day: UiPaletteSchema,
      night: UiPaletteSchema,
      /** How long a theme switch cross-fades (instant under reduced motion). */
      crossFadeMs: z.int().nonnegative().max(2000),
      /** Glass opacity over the map where the backdrop blurs (mid and high tiers). */
      glassAlpha: dayNight(z.number().gt(0).max(1)),
      glassBlurPx: z.number().nonnegative().max(40),
    }),
    /** Tokens for the browser/PWA theme colour per interface theme (the manifest takes day). */
    themeColor: dayNight(z.string()),
    world: palette,
    sky: z.strictObject({
      dawn: SkyKeyframeSchema,
      morning: SkyKeyframeSchema,
      day: SkyKeyframeSchema,
      golden: SkyKeyframeSchema,
      dusk: SkyKeyframeSchema,
      night: SkyKeyframeSchema,
    }),
    scene: ScenePaletteRefsSchema,
    /**
     * Real-world colours for the hand-made 3D models (S04h, DEC-26): `npm run assets:build`
     * snaps baked pack colours to these, and avatar swatches recolour from them. Each token has a
     * human colour name in copy (`models.color.<token without its hyphen>`, e.g.
     * `models.color.taxi400`). Separate from `colors`: these never
     * become Tailwind classes.
     */
    models: palette,
  })
  .refine((theme) => Object.values(theme.themeColor).every((token) => token in theme.colors), {
    error: 'themeColor must name tokens in colors',
    path: ['themeColor'],
  })
  .refine(
    (theme) =>
      [theme.ui.day, theme.ui.night].every((ui) =>
        Object.values(ui).every((token) => token in theme.colors),
      ),
    { error: 'every ui colour must name a token in colors', path: ['ui'] },
  )
  .refine((theme) => Object.keys(theme.world).every((token) => !(token in theme.models)), {
    error: 'world and models must not share a token name',
    path: ['world'],
  })
  .refine(
    (theme) =>
      clashingTokens(theme.colors, theme.models).length === 0 &&
      clashingTokens(theme.colors, theme.world).length === 0,
    { error: 'a token in colors and in world or models must be the same colour', path: ['colors'] },
  )
  .refine(
    (theme) =>
      scenePaletteTokens(theme.scene).every(
        (token) => token in theme.world || token in theme.models,
      ),
    { error: 'every scene colour must name a token in world or models', path: ['scene'] },
  )
  .refine(
    (theme) =>
      Object.values(theme.sky).every((slots) =>
        Object.values(slots).every((token) => token in theme.world || token in theme.models),
      ),
    { error: 'every sky colour must name a token in world or models', path: ['sky'] },
  )
  .refine(
    (theme) => theme.scene.toonRamp.every((step, i, ramp) => i === 0 || step > (ramp[i - 1] ?? 0)),
    { error: 'toonRamp must increase', path: ['scene', 'toonRamp'] },
  )
export type ThemeConfig = z.infer<typeof ThemeConfigSchema>

const RateLimitSchema = z.strictObject({ max: positiveInt, windowMs: positiveInt })

export const RealtimeConfigSchema = z.strictObject({
  shardSize: positiveInt,
  maxFriendFanout: positiveInt,
  heartbeatIntervalMs: positiveInt,
  /** Minimum time between two accepted `move` calls from one player. */
  moveMinIntervalMs: positiveInt,
  emoteRateLimit: RateLimitSchema,
  /** Cost guard for S35's load simulation. */
  budgetMsgsPerPlayerMinute: positive,
})
export type RealtimeConfig = z.infer<typeof RealtimeConfigSchema>

/**
 * data/config/moderation.json (S18b). The database enforces these from its own copy,
 * private.moderation_settings (tests/integration/safety.test.ts checks the two match).
 */
export const ModerationConfigSchema = z
  .strictObject({
    /** Content auto-hides, pending review, after this many distinct trusted reporters. */
    autoHideReports: positiveInt,
    /** A reporter counts toward auto-hide only once their account is this old. */
    autoHideMinReporterAgeHours: z.int().nonnegative(),
    /** Reports a moderator dismissed as abusive before a reporter stops counting. */
    falseReportThreshold: positiveInt,
    /** Reports one player may file per New York day. */
    reportsPerDay: positiveInt,
    noteMaxChars: positiveInt,
    appealMaxChars: positiveInt,
    /** How long a block can be undone with its friendship and roommate link restored. */
    blockUndoSeconds: positiveInt,
    blockMax: positiveInt,
    muteMax: positiveInt,
    retention: z
      .strictObject({
        /** Snapshots and notes of resolved reports (never under legal hold). */
        evidenceDays: positiveInt,
        /** Resolved report rows themselves. */
        reportRowDays: positiveInt,
        auditDays: positiveInt,
        /** Resolved appeals. */
        appealDays: positiveInt,
      })
      .refine((retention) => retention.evidenceDays <= retention.reportRowDays, {
        error: 'evidenceDays must not exceed reportRowDays',
      }),
    /**
     * The /mod console's server routes (S18b part 2), not mirrored in the database: sign-in
     * links one IP may ask for per window, and how many cases one queue read returns.
     */
    console: z.strictObject({
      signInMaxPerWindow: positiveInt,
      signInWindowMs: positiveInt,
      queueLimit: z.int().min(1).max(200),
    }),
  })
  .refine((config) => config.noteMaxChars <= 1000 && config.appealMaxChars <= 2000, {
    error: 'note and appeal limits must stay within the database column checks',
  })
export type ModerationConfig = z.infer<typeof ModerationConfigSchema>

/** data/config/profile.json (S18a part 2): the Me panel's client-side timing. */
export const ProfileConfigSchema = z.strictObject({
  /** How long the handle form waits after typing stops before it asks whether a handle is free. */
  handleCheckDebounceMs: z.int().min(0).max(5000),
})
export type ProfileConfig = z.infer<typeof ProfileConfigSchema>

/**
 * data/config/handles.json (S18a). The database enforces these: the migration's generated seed
 * (scripts/moderation/blocklist-sql.ts) copies them into private.handle_settings, and the
 * format rule is the pattern src/lib/handles/normalise.ts builds from them.
 */
export const HandlesConfigSchema = z
  .strictObject({
    minLength: positiveInt,
    maxLength: positiveInt,
    /** Letters a handle needs, so it reads as a name rather than a number. */
    minLetters: positiveInt,
    /** Guest handles: AdjectiveNoun plus `digits` digits; `fallbackDigits` after `attempts` misses. */
    generated: z.strictObject({
      digits: positiveInt,
      fallbackDigits: positiveInt,
      attempts: positiveInt,
    }),
    /**
     * The first `freeChanges` changes are not limited. After that, at most `perWindow` changes in
     * any `windowDays`, at least `minIntervalHours` apart.
     */
    changes: z.strictObject({
      freeChanges: z.int().nonnegative(),
      perWindow: positiveInt,
      windowDays: positiveInt,
      minIntervalHours: positiveInt,
    }),
    /** A released handle stays reserved for this long, so nobody can take over a known name. */
    quarantineDays: positiveInt,
    rateLimits: z.strictObject({
      /** check_handle and set_handle, per player. */
      checkHandle: RateLimitSchema,
      /** get_public_profile and get_public_profiles, per player. */
      publicProfile: RateLimitSchema,
    }),
    /** Most ids get_public_profiles accepts in one call. */
    publicProfilesMaxIds: positiveInt,
  })
  .refine((config) => config.minLength <= config.maxLength, {
    error: 'minLength must not exceed maxLength',
  })
  .refine((config) => config.minLetters <= config.minLength, {
    error: 'minLetters must not exceed minLength',
  })
  .refine((config) => config.generated.digits < config.generated.fallbackDigits, {
    error: 'fallbackDigits must be more than digits',
  })
export type HandlesConfig = z.infer<typeof HandlesConfigSchema>

/**
 * The browser's fetch keepalive budget: a request body sent with `keepalive` (the hidden-tab and
 * pagehide flush, S18c) is refused above 64 KiB.
 */
const KEEPALIVE_LIMIT_BYTES = 65_536

/** Cloud save sync timings and server save plausibility (S18c; placeholders, TUNE-10). */
export const SyncConfigSchema = z
  .strictObject({
    /** Quiet time after the last meaningful change before an upload. */
    debounceMs: positiveInt,
    /** The longest a change waits for an upload while play keeps changing the save. */
    maxWaitMs: positiveInt,
    /** Exponential backoff after a failed upload: first wait, and the most it grows to. */
    retry: z.strictObject({ baseMs: positiveInt, maxMs: positiveInt }),
    /** Wait before uploading again after the server rejected a save (paused sync). */
    rejectedRetryMs: positiveInt,
    /** Server rate limit: least time between two accepted uploads, and most per minute. */
    minUploadIntervalMs: positiveInt,
    maxUploadsPerMinute: positiveInt,
    /** Largest save body the server stores (the saves table's own check matches it). */
    maxSaveBytes: positiveInt,
    /** Largest body the hidden-tab / pagehide keepalive upload may send. */
    keepaliveMaxBytes: positiveInt.max(KEEPALIVE_LIMIT_BYTES),
    /** Accepted saves the server keeps per player, and quarantined (rejected) ones. */
    historyKeep: positiveInt,
    /**
     * Revisions per player the revision ledger keeps (when each was accepted, and its credits:
     * a few numbers a row), oldest pruned. "Keep this device" from a trimmed revision uses it.
     */
    revisionLedgerKeep: positiveInt,
    quarantineKeep: positiveInt,
    plausibility: z.strictObject({
      /** The economy fixture's maxima are multiplied by this before they act as ceilings. */
      margin: z.number().min(1),
      /** Taps a person can make in one real minute (each writes at most one clout entry). */
      maxActionsPerRealMinute: positiveInt,
      /**
       * The most real minutes of slack a window can carry (a token bucket the server keeps per
       * player, DEC-19): uploads lag the play they carry.
       */
      burstRealMinutes: positive,
      /**
       * Clout other players may see an account gain per real minute of its age (the public
       * level cap, DEC-19). Kept apart from the upload pace: a public level behind the save's is
       * a display delay, never a refusal. (Icon − every wearable's clout) ÷ this ≥ 60 minutes.
       */
      publicCloutPerRealMinute: positive,
      /** "Keep this device" uploads a player may make in an hour (H2 overrides; 429 beyond). */
      overrideMaxPerHour: positiveInt,
    }),
  })
  .refine((sync) => sync.debounceMs <= sync.maxWaitMs, {
    error: 'debounceMs must not exceed maxWaitMs',
    path: ['debounceMs'],
  })
  .refine((sync) => sync.retry.baseMs <= sync.retry.maxMs, {
    error: 'retry.baseMs must not exceed retry.maxMs',
    path: ['retry'],
  })
  .refine((sync) => sync.keepaliveMaxBytes <= sync.maxSaveBytes, {
    error: 'keepaliveMaxBytes must not exceed maxSaveBytes',
    path: ['keepaliveMaxBytes'],
  })
  .refine((sync) => sync.minUploadIntervalMs * sync.maxUploadsPerMinute <= 60_000, {
    error: 'maxUploadsPerMinute must fit in a minute at minUploadIntervalMs',
    path: ['maxUploadsPerMinute'],
  })
export type SyncConfig = z.infer<typeof SyncConfigSchema>

const dollars = z.int().nonnegative()
/** Whole percent, 0..99: resale is always worth less than the price. */
const percent = z.int().min(0).max(99)
const MinMaxSchema = z
  .strictObject({ min: dollars, max: dollars })
  .refine((range) => range.min <= range.max, { error: 'min must not exceed max' })

export const RARITY_TIERS = ['common', 'medium', 'rare'] as const
export const RarityTierSchema = z.enum(RARITY_TIERS)
export type RarityTier = z.infer<typeof RarityTierSchema>

export { HOME_IDS }
export const JOB_IDS = ['barista', 'retail', 'delivery', 'junior-dev'] as const

/** Player needs, 0..stats.max. Hunger is fullness: high is fed, 0 is starving. */
export const STAT_KEYS = ['energy', 'hunger', 'mood'] as const
export type StatKey = (typeof STAT_KEYS)[number]

const statPoints = z.int().nonnegative()
const StatsRecordSchema = z.strictObject({
  energy: statPoints,
  hunger: statPoints,
  mood: statPoints,
})
function PartialStatsSchema<T extends z.ZodType<number>>(value: T) {
  return z.strictObject({
    energy: value.optional(),
    hunger: value.optional(),
    mood: value.optional(),
  })
}

/** What happens each game hour a stat sits at zero. */
const AtZeroSchema = z.strictObject({
  /** Extra points drained from the other stats per game hour. */
  extraDecayPerGameHour: PartialStatsSchema(statPoints),
  /** Action durations are multiplied by this (rounded up); multipliers of several zero stats stack. */
  durationMultiplier: z.number().min(1),
})

/** One action: what it costs up front and what it changes once its time has passed. */
export const ActionDefSchema = z.strictObject({
  /** Game minutes the personal clock fast-forwards. */
  durationMin: z.int().nonnegative(),
  cashCost: dollars,
  energyCost: statPoints,
  /** Points added (or removed, if negative) when the action finishes. */
  statEffects: PartialStatsSchema(z.int()),
})
export type ActionDef = z.infer<typeof ActionDefSchema>

/**
 * Who may enter a borough: always (`open`), from a clout level (`clout`, a `clout.levels` id),
 * or nobody yet (`expanding-soon`, shown as dimmed teaser land).
 */
export const BoroughAccessRuleSchema = z.discriminatedUnion('access', [
  z.strictObject({ access: z.literal('open') }),
  z.strictObject({ access: z.literal('clout'), level: z.string() }),
  z.strictObject({ access: z.literal('expanding-soon') }),
])
export type BoroughAccessRule = z.infer<typeof BoroughAccessRuleSchema>

const MINUTES_PER_DAY_MAX = 24 * 60
const LatLngSchema = z.strictObject({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
})
const probability = z.number().min(0).max(1)

/** A daily window of the personal clock, [startMin, endMin) minutes after midnight. */
const DayWindowSchema = z
  .strictObject({
    startMin: z.int().nonnegative().max(MINUTES_PER_DAY_MAX),
    endMin: z.int().nonnegative().max(MINUTES_PER_DAY_MAX),
  })
  .refine((window) => window.startMin < window.endMin, { error: 'startMin must be before endMin' })

/**
 * Walk, subway and taxi (S08, src/engine/transit). Distances are local metres from the shared
 * projection; times are game minutes. The subway fare itself is `costs.subwayFare`.
 */
export const TransitConfigSchema = z.strictObject({
  /** Shorter trips are refused: the player is already there. */
  minTripM: positive,
  /**
   * A trip end off land (a bridge's midspan, a pier) moves to the nearest land within this many
   * metres; further out it is unreachable.
   */
  snapToLandM: z.number().nonnegative(),
  walk: z.strictObject({
    speedKmh: positive,
    /** Street distance over straight-line distance (the grid is not a straight line). */
    detourFactor: z.number().min(1),
    /** Energy points drained per km walked (also on the subway's walking legs). */
    energyPerKm: z.number().nonnegative(),
    /** A walk whose straight line leaves land for longer than this in one stretch is refused. */
    maxWaterM: z.number().nonnegative(),
  }),
  taxi: z.strictObject({
    speedKmh: positive,
    detourFactor: z.number().min(1),
    /** Wait for the pickup, game minutes. */
    pickupMin: z.number().nonnegative(),
    /** Flag drop, whole dollars. */
    baseFare: dollars,
    /** Dollars per km driven; the total fare rounds up to whole dollars. */
    perKm: z.number().nonnegative(),
    /** A drive leaving land for longer than this in one stretch must use a crossing instead. */
    maxWaterM: z.number().nonnegative(),
    /**
     * The straight-line taxi estimate (used only when the geo layers cannot load) multiplies the
     * straight distance by this, so it is never cheaper or quicker than the routed taxi via the
     * crossings (TRV-5; checked against every place pair in src/engine/transit/trip.test.ts).
     */
    estimateDetourFactor: z.number().min(1),
  }),
  /**
   * Bridges and vehicle tunnels the taxi may use across water: one point on land at each end.
   * Ids are data only (never rendered by S08).
   */
  crossings: z.array(
    z.strictObject({ id: z.string().regex(/^[a-z0-9-]+$/), a: LatLngSchema, b: LatLngSchema }),
  ),
  /** Points on land a taxi may also drive through, so a drive can bend around a bay. */
  roadWaypoints: z.array(
    z.strictObject({ id: z.string().regex(/^[a-z0-9-]+$/), at: LatLngSchema }),
  ),
  subway: z.strictObject({
    /** In-vehicle speed along the line path. */
    speedKmh: positive,
    /** Extra minutes per stop the train makes. */
    dwellMinPerStop: z.number().nonnegative(),
    /** Wait on the platform before the first train. */
    boardWaitMin: z.number().nonnegative(),
    /** Minutes added for each change of line (walk inside the station and wait). */
    transferPenaltyMin: z.number().nonnegative(),
    /** Separate stations this close are linked by a walking transfer. */
    transferWalkMaxM: z.number().nonnegative(),
    /** How many of the nearest stations to each end are tried as entry and exit. */
    accessCandidates: positiveInt,
    /** Stations further than this are not tried, except the single nearest one. */
    accessMaxM: positive,
    /** Stations further than this from every path of a line they list are not on it. */
    stationSnapM: positive,
    /**
     * Consecutive stretches of track drawn for one ride may be this far apart; further apart (a
     * change between two paths of the line), the drawn path goes through the station.
     */
    pathJoinM: z.number().nonnegative(),
  }),
  rushHour: z.strictObject({
    /** By personal clock time of departure. */
    windows: z.array(DayWindowSchema).min(1),
    /** In-vehicle and dwell time are multiplied by this in rush hour. */
    subwayDurationMultiplier: z.number().min(1),
    /** Mood points drained by a subway trip that departs in rush hour. */
    subwayMoodDrain: z.int().nonnegative(),
    /** Taxi driving time is multiplied by this in rush hour (no mood drain). */
    taxiDurationMultiplier: z.number().min(1),
  }),
  /** Random delay on subway trips; the roll uses the injected seeded random source. */
  delay: z.strictObject({
    probability,
    rushProbability: probability,
    minutes: z
      .strictObject({ min: z.int().nonnegative(), max: z.int().nonnegative() })
      .refine((range) => range.min <= range.max, { error: 'min must not exceed max' }),
    moodDrain: z.int().nonnegative(),
  }),
  animation: z.strictObject({
    /** Longest the travel animation may run, real milliseconds. */
    maxMs: z.int().nonnegative(),
    /** Real milliseconds of animation per game minute of travel, before the cap. */
    msPerGameMinute: z.number().nonnegative(),
  }),
})
export type TransitConfig = z.infer<typeof TransitConfigSchema>

const KEBAB_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const COPY_KEY = /^[a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)+$/

/**
 * A club's door and what a night inside does (S09). The door refuses anyone below
 * `minCloutLevel` (a `clout.levels` id) with the in-voice `refusalKey` copy; inside, the cover
 * is paid up front, the night lasts `durationMin` and ends with `moodGain` and `cloutGain`.
 */
export const ClubRuleSchema = z.strictObject({
  coverCharge: dollars,
  minCloutLevel: z.string().regex(KEBAB_ID),
  refusalKey: z.string().regex(COPY_KEY),
  durationMin: positiveInt,
  energyCost: statPoints,
  // Positive so a repeat entry (no clout) still says what the night gave.
  moodGain: positiveInt,
  cloutGain: positiveInt,
})
export type ClubRule = z.infer<typeof ClubRuleSchema>

/**
 * What a player can do at a place (S09, src/engine/placeActions.ts). Ids of venues, venue
 * types and landmarks are checked against data/venues and data/landmarks in
 * src/lib/world/placeActions-content.test.ts (this file cannot import the content schemas).
 */
export const PlaceConfigSchema = z.strictObject({
  /**
   * Actions offered at each venue type, by id: a key of `actions.catalog` or of `actions`
   * below. Shifts come from a venue's `jobIds` and the club night from `clubs`, not from here.
   */
  venueActions: z.record(z.string().regex(KEBAB_ID), z.array(z.string().regex(KEBAB_ID))),
  /**
   * What the player can do at home (sleep, a nap, a home-cooked meal), by `actions.catalog` id,
   * in display order. Only at home (DEC-22): away, the home card offers the trip back.
   */
  homeActions: z.array(z.string().regex(KEBAB_ID)).min(1),
  /** Actions only places offer (a coffee, a meal out), shaped like `actions.catalog`. */
  actions: z.record(z.string().regex(KEBAB_ID), ActionDefSchema),
  /** Door and night rules for every club venue, by venue id. */
  clubs: z.record(z.string().regex(KEBAB_ID), ClubRuleSchema),
  /** The Visit action at any landmark that allows `visit` (never a memorial). */
  visit: z.strictObject({
    durationMin: positiveInt,
    energyCost: statPoints,
    moodGain: positiveInt,
  }),
  /**
   * How much a flex at a landmark counts (read by S13), by landmark id; others get `default`.
   * Landmarks that do not allow `flex` (memorials included) have no multiplier at all.
   */
  flexMultiplier: z.strictObject({
    default: positive,
    byLandmark: z.record(z.string().regex(KEBAB_ID), positive),
  }),
})
export type PlaceConfig = z.infer<typeof PlaceConfigSchema>

/**
 * Clout (S13, src/engine/clout.ts): levels, how flexing and style work, the ledger and the
 * premium cap. Venue types in `flex.venueTypes` are checked against the content schema in
 * src/lib/world/placeActions-content.test.ts (this file cannot import the content schemas).
 */
export const CloutConfigSchema = z
  .strictObject({
    /** Lowest first. A player is at the highest level whose `minClout` they hold. */
    levels: z
      .array(
        z.strictObject({
          id: z.string().regex(KEBAB_ID),
          minClout: z.int().nonnegative(),
        }),
      )
      .min(1),
    /** One-off gains: the first paycheck ever earned. */
    sources: z.strictObject({ firstPaycheck: positiveInt }),
    /**
     * The Flex action: at a landmark that allows it (its `place.flexMultiplier`) or a venue of
     * one of `venueTypes` (the default multiplier; never `club`). Once per place per game day, at most
     * `maxPerGameDay` a day. A flex goes viral when one seeded draw falls below
     * min(maxChance, (baseChance + style score * perStylePoint) * place multiplier); a viral
     * flex earns `baseClout * cloutMultiplier`.
     */
    flex: z.strictObject({
      durationMin: positiveInt,
      energyCost: statPoints,
      cashCost: dollars,
      baseClout: positiveInt,
      maxPerGameDay: positiveInt,
      venueTypes: z.array(z.string().regex(KEBAB_ID)),
      viral: z.strictObject({
        baseChance: probability,
        perStylePoint: probability,
        maxChance: probability,
        cloutMultiplier: z.int().min(1),
      }),
    }),
    /**
     * The outfit's style score (the `styleValue` of every worn item) multiplies positive gains
     * from `appliesTo` by 100 + min(maxBonusPct, score * pctPerPoint) percent. `club` cannot be
     * listed (STYLED_SOURCES): club clout is exactly the configured value.
     */
    style: z.strictObject({
      pctPerPoint: z.int().nonnegative(),
      maxBonusPct: z.int().nonnegative(),
      appliesTo: z.array(z.enum(STYLED_SOURCES)),
    }),
    /** Entries kept one by one; older ones fold into per-source totals. */
    ledger: z.strictObject({ maxEntries: positiveInt }),
    /** The most clout a currency other than in-game cash can add (premium items: `usd`). */
    caps: z.strictObject({ byCurrency: z.strictObject({ usd: z.int().nonnegative() }) }),
  })
  .refine(
    ({ levels }) =>
      levels[0]?.minClout === 0 &&
      levels.every((level, i) => i === 0 || level.minClout > (levels[i - 1]?.minClout ?? 0)) &&
      new Set(levels.map((level) => level.id)).size === levels.length,
    { error: 'clout.levels must start at 0, rise strictly and have unique ids', path: ['levels'] },
  )
  .refine(({ levels, caps }) => caps.byCurrency.usd < (levels.at(-1)?.minClout ?? 0), {
    error:
      'caps.byCurrency.usd must stay below the top level, so premium clout alone never reaches it',
    path: ['caps', 'byCurrency', 'usd'],
  })
  .refine(({ style }) => new Set(style.appliesTo).size === style.appliesTo.length, {
    error: 'style.appliesTo must not repeat a source',
    path: ['style', 'appliesTo'],
  })
  .refine(({ flex }) => !flex.venueTypes.includes('club'), {
    // Nightlife is flavour only: a club pays its configured clout and nothing more.
    error: 'flex.venueTypes must not include club',
    path: ['flex', 'venueTypes'],
  })
  .refine(({ flex }) => flex.viral.baseChance <= flex.viral.maxChance, {
    error: 'flex.viral.baseChance must not exceed maxChance',
    path: ['flex', 'viral'],
  })
export type CloutConfig = z.infer<typeof CloutConfigSchema>

/** CLAUDE.md "Balance anchors". Money is whole in-game dollars. */
export const BalanceConfigSchema = z
  .strictObject({
    time: z.strictObject({
      gameMinutesPerRealMinute: positive,
      gameDayHours: positiveInt,
      rentPeriodGameDays: positiveInt,
      /** The personal clock starts on day 1 at this minute of the day. */
      startMinuteOfDay: z.int().nonnegative(),
      /** Passive clock speed multipliers the player can toggle between; 1 must be first. */
      speeds: z.array(positiveInt).min(1),
      /** Longest real gap one tick may count, so a stalled or sleeping tab cannot skip time. */
      maxTickRealMs: positiveInt,
      /** How often the client clock driver ticks the store. */
      tickIntervalMs: positiveInt,
    }),
    start: z.strictObject({ cash: dollars, home: z.enum(HOME_IDS) }),
    stats: z.strictObject({
      max: positiveInt,
      start: StatsRecordSchema,
      decayPerGameHour: StatsRecordSchema,
      atZero: z.strictObject({ energy: AtZeroSchema, hunger: AtZeroSchema, mood: AtZeroSchema }),
    }),
    actions: z.strictObject({
      /** Longest duration any one action may have, in game minutes. */
      maxDurationMin: positiveInt,
      catalog: z.record(z.string().regex(/^[a-z0-9-]+$/), ActionDefSchema),
    }),
    rentPerWeek: z.strictObject({
      'queens-room': dollars,
      'brooklyn-1br': dollars,
      'manhattan-loft': dollars,
    }),
    jobs: z.strictObject({
      shiftHours: positive,
      hourlyWage: z.strictObject({
        barista: dollars,
        retail: dollars,
        delivery: dollars,
        'junior-dev': dollars,
      }),
      /** Energy points paid up front for one shift (passive decay during the shift is extra). */
      energyCostPerShift: z.strictObject({
        barista: statPoints,
        retail: statPoints,
        delivery: statPoints,
        'junior-dev': statPoints,
      }),
      /** Jobs locked until the player reaches a clout level (an id in `clout.levels`). */
      requiredCloutLevel: z.partialRecord(z.enum(JOB_IDS), z.string()),
    }),
    /**
     * Moving home (S12 measures it, S16 spends it). `moveInCost` is the whole dollars a player
     * needs on top of their rent reserve (rent owed plus this week's rent) to move into a home.
     * Every home except the lowest-rent one has a cost; the lowest-rent home (where an eviction
     * lands; on a tie, the first in HOME_IDS, as the engine's cheapestHome) has none.
     */
    housing: z.strictObject({
      moveInCost: z.partialRecord(z.enum(HOME_IDS), dollars),
    }),
    /**
     * The apartment (S16, src/engine/home.ts; TUNE-8 placeholders). A home's score is its
     * `baseScore` plus the `homeScore` of every decor item placed there; home clout is that score
     * capped at `maxClout`. `moveLogMax` is how many moves the save keeps (newest last).
     */
    home: z.strictObject({
      baseScore: z.strictObject(
        Object.fromEntries(HOME_IDS.map((id) => [id, z.int().nonnegative()])) as Record<
          (typeof HOME_IDS)[number],
          z.ZodInt
        >,
      ),
      maxClout: positiveInt,
      moveLogMax: positiveInt,
    }),
    /**
     * Missed rent. Each consecutive due date the player cannot pay in full adds that week's
     * rent to what they owe, plus `lateFees[missed - 1]` (0 is a warning). On the
     * `evictAfterMissed`-th miss the player is evicted to the lowest-rent home.
     */
    rent: z.strictObject({
      lateFees: z.array(dollars),
      evictAfterMissed: positiveInt,
    }),
    /** Clout (S13, src/engine/clout.ts). Every number here is a TUNE-4 placeholder. */
    clout: CloutConfigSchema,
    costs: z.strictObject({ food: MinMaxSchema, subwayFare: dollars }),
    transit: TransitConfigSchema,
    target: z.strictObject({
      shiftsPerDay: positive,
      weeklySavings: dollars,
      firstUpgradeGameDay: MinMaxSchema,
    }),
    /**
     * Shop and resale (S10). Integer percentages keep the money maths exact.
     * - An item's `sellValue` in data/items is floor(price * resalePct[rarity] / 100).
     * - A wearable sells for floor(sellValue * max(minResalePct, 100 - days owned *
     *   depreciationPctPerGameDay) / 100), counting whole game days since it was bought.
     *   Gifts do not age: they sell for their `sellValue`.
     * - A player holds at most `maxGiftStack` of each gift.
     */
    items: z.strictObject({
      resalePct: z.strictObject({ common: percent, medium: percent, rare: percent }),
      depreciationPctPerGameDay: percent,
      minResalePct: percent,
      maxGiftStack: positiveInt,
    }),
    events: z.strictObject({
      /** Chance (0..1) that a roll fires an event when one is eligible. */
      rollChance: z.number().min(0).max(1),
      /** Game minutes before an event can fire again, unless the event sets its own. */
      defaultCooldownMin: z.int().nonnegative(),
      /** Clout and item effects kept in the save until S13 and S10 consume them. */
      maxPendingEffects: positiveInt,
    }),
    rarityTiers: z.array(RarityTierSchema).length(RARITY_TIERS.length),
    /** Placeholder USD prices (whole dollars) until a human sets them. */
    premiumPriceTiersUsd: z.record(z.string().regex(/^tier-\d+$/), z.int().positive()),
    /** Borough gating, keyed by borough id (the ids of BOROUGHS in schemas/content.ts). */
    boroughs: z.strictObject({
      queens: BoroughAccessRuleSchema,
      brooklyn: BoroughAccessRuleSchema,
      manhattan: BoroughAccessRuleSchema,
      bronx: BoroughAccessRuleSchema,
      'staten-island': BoroughAccessRuleSchema,
    }),
    /** Place actions, club doors, landmark visits and flex multipliers (S09). */
    place: PlaceConfigSchema,
  })
  .refine((balance) => new Set(balance.rarityTiers).size === RARITY_TIERS.length, {
    error: 'rarityTiers must list each tier once',
    path: ['rarityTiers'],
  })
  .refine((balance) => balance.time.speeds[0] === 1, {
    error: 'speeds must start with 1x',
    path: ['time', 'speeds'],
  })
  .refine((balance) => new Set(balance.time.speeds).size === balance.time.speeds.length, {
    error: 'speeds must not repeat',
    path: ['time', 'speeds'],
  })
  .refine((balance) => balance.time.startMinuteOfDay < balance.time.gameDayHours * 60, {
    error: 'startMinuteOfDay must fall inside one game day',
    path: ['time', 'startMinuteOfDay'],
  })
  .refine(
    (balance) =>
      STAT_KEYS.every((key) => balance.stats.start[key] <= balance.stats.max) &&
      STAT_KEYS.every((key) => balance.stats.decayPerGameHour[key] <= balance.stats.max),
    { error: 'start stats and decay must not exceed stats.max', path: ['stats'] },
  )
  .refine(
    (balance) =>
      Object.values(balance.actions.catalog).every(
        (action) =>
          action.durationMin <= balance.actions.maxDurationMin &&
          action.energyCost <= balance.stats.max &&
          STAT_KEYS.every((key) => Math.abs(action.statEffects[key] ?? 0) <= balance.stats.max),
      ),
    { error: 'an action exceeds maxDurationMin or stats.max', path: ['actions', 'catalog'] },
  )
  .refine(
    (balance) =>
      Number.isInteger(balance.jobs.shiftHours * 60) &&
      balance.jobs.shiftHours * 60 <= balance.actions.maxDurationMin &&
      JOB_IDS.every((id) =>
        Number.isInteger(balance.jobs.hourlyWage[id] * balance.jobs.shiftHours),
      ),
    {
      error: 'a shift must be whole game minutes within maxDurationMin and pay whole dollars',
      path: ['jobs', 'shiftHours'],
    },
  )
  .refine(
    (balance) => JOB_IDS.every((id) => balance.jobs.energyCostPerShift[id] <= balance.stats.max),
    {
      error: 'a shift energy cost exceeds stats.max',
      path: ['jobs', 'energyCostPerShift'],
    },
  )
  .refine(
    (balance) =>
      Object.values(balance.jobs.requiredCloutLevel).every((level) =>
        balance.clout.levels.some((entry) => entry.id === level),
      ),
    {
      error: 'requiredCloutLevel must name a level in clout.levels',
      path: ['jobs', 'requiredCloutLevel'],
    },
  )
  .refine(
    (balance) =>
      Object.values(balance.boroughs).every(
        (rule) =>
          rule.access !== 'clout' || balance.clout.levels.some((entry) => entry.id === rule.level),
      ),
    { error: 'a clout-gated borough must name a level in clout.levels', path: ['boroughs'] },
  )
  .refine(
    (balance) => {
      const cheapest = lowestRentHome(balance.rentPerWeek)
      return HOME_IDS.every((id) => (id === cheapest) === !(id in balance.housing.moveInCost))
    },
    {
      error: 'housing.moveInCost needs every home except the lowest-rent one, and not that one',
      path: ['housing', 'moveInCost'],
    },
  )
  .refine(({ home }) => Object.values(home.baseScore).every((score) => score <= home.maxClout), {
    error: 'home.baseScore must not exceed home.maxClout',
    path: ['home', 'baseScore'],
  })
  .refine(({ home, start }) => home.baseScore[start.home] === 0, {
    // The start home adds no clout, so a new player (and the economy bot) starts at 0.
    error: 'the start home must have a base score of 0',
    path: ['home', 'baseScore'],
  })
  .refine(({ home, clout }) => home.maxClout < (clout.levels.at(-1)?.minClout ?? 0), {
    error: 'home.maxClout must be below the top clout level',
    path: ['home', 'maxClout'],
  })
  .refine((balance) => balance.rent.lateFees.length === balance.rent.evictAfterMissed - 1, {
    error: 'rent.lateFees needs one fee for each miss before eviction',
    path: ['rent', 'lateFees'],
  })
  .refine(
    ({ actions, stats, clout }) =>
      clout.flex.durationMin <= actions.maxDurationMin && clout.flex.energyCost <= stats.max,
    { error: 'clout.flex exceeds maxDurationMin or stats.max', path: ['clout', 'flex'] },
  )
  .refine(
    ({ actions, place }) =>
      Object.values(place.venueActions).every((ids) =>
        ids.every((id) => Object.hasOwn(actions.catalog, id) || Object.hasOwn(place.actions, id)),
      ),
    {
      error: 'place.venueActions must name actions in actions.catalog or place.actions',
      path: ['place', 'venueActions'],
    },
  )
  .refine(
    ({ actions, place }) =>
      place.homeActions.every((id) => Object.hasOwn(actions.catalog, id)) &&
      new Set(place.homeActions).size === place.homeActions.length,
    {
      error: 'place.homeActions must name distinct actions in actions.catalog',
      path: ['place', 'homeActions'],
    },
  )
  .refine(
    ({ actions, place }) =>
      Object.keys(place.actions).every((id) => !Object.hasOwn(actions.catalog, id)),
    { error: 'place.actions must not reuse an actions.catalog id', path: ['place', 'actions'] },
  )
  .refine(
    ({ actions, stats, place }) =>
      [
        ...Object.values(place.actions).map((action) => ({
          durationMin: action.durationMin,
          energyCost: action.energyCost,
          effects: STAT_KEYS.map((key) => action.statEffects[key] ?? 0),
        })),
        ...Object.values(place.clubs).map((club) => ({
          durationMin: club.durationMin,
          energyCost: club.energyCost,
          effects: [club.moodGain],
        })),
        {
          durationMin: place.visit.durationMin,
          energyCost: place.visit.energyCost,
          effects: [place.visit.moodGain],
        },
      ].every(
        (action) =>
          action.durationMin <= actions.maxDurationMin &&
          action.energyCost <= stats.max &&
          action.effects.every((effect) => Math.abs(effect) <= stats.max),
      ),
    { error: 'a place action exceeds maxDurationMin or stats.max', path: ['place'] },
  )
  .refine(
    ({ clout, place }) =>
      Object.values(place.clubs).every((club) =>
        clout.levels.some((level) => level.id === club.minCloutLevel),
      ),
    {
      error: 'place.clubs minCloutLevel must name a level in clout.levels',
      path: ['place', 'clubs'],
    },
  )
export type BalanceConfig = z.infer<typeof BalanceConfigSchema>

/**
 * data/config/offline.json (S04e): when the service worker registers, and when it warms the
 * player's tier. Registration waits for the map to be playable, then for the browser to be idle,
 * but no longer than `idleTimeoutMs`. The tier warm (the tier's district assets fetched into the
 * worker's cache ahead of the next load) follows registration, and is skipped under a data-saver
 * request and on a device reporting at most `skipAtOrBelowDeviceMemoryGB` of memory
 * (navigator.deviceMemory, where the browser exposes it).
 */
export const OfflineConfigSchema = z.strictObject({
  registration: z.strictObject({ idleTimeoutMs: positiveInt }),
  tierWarm: z.strictObject({ skipAtOrBelowDeviceMemoryGB: positive }),
})
export type OfflineConfig = z.infer<typeof OfflineConfigSchema>

export const LayoutConfigSchema = z.strictObject({
  overlay: z
    .strictObject({
      bannerHeightPx: positive,
      /**
       * The HUD's two rows of 44 px targets (S05). On a short, wide screen (a landscape phone:
       * width ≥ hudWideMinWidthPx and height ≤ hudCompactMaxHeightPx) it is one row,
       * hudCompactHeightPx tall. globals.css repeats the two thresholds as media queries
       * (src/app/layout-css.test.ts keeps them equal).
       */
      hudHeightPx: z.number().min(2 * 44),
      hudCompactHeightPx: z.number().min(44),
      hudWideMinWidthPx: positiveInt,
      hudCompactMaxHeightPx: positiveInt,
      /**
       * At or below this width (a 320 px phone) the two-row phone HUD cannot hold the sound
       * control's two text lines beside Places and More: the sound control turns icon-only and
       * the clout column may shrink to fit, so the HUD never overflows the viewport (UI-1).
       * globals.css repeats it as the `hud-tiny` variant.
       */
      hudTinyMaxWidthPx: positiveInt,
      toastHeightPx: positive,
      /** How long a toast (the level-up message) shows before it closes itself. */
      toastMs: positiveInt,
      sheetMaxHeightVh: positive,
      sheetMaxWidthPx: positive,
      tabBarHeightPx: positive,
      /**
       * The free scene row never shrinks below this, so the map stays visible and the map
       * attribution with its 44 px credits link always fits (banner, toast and sheet shrink first).
       */
      freeSceneMinHeightPx: z.number().min(44),
      /**
       * A lazily loaded feature's loading skeleton stays invisible this long, so a fast load never
       * flashes a placeholder (its status is announced at once).
       */
      loadingRevealDelayMs: z.int().nonnegative(),
      /**
       * After a sheet or panel action, pointer taps on its actions are ignored this long (ms), so
       * the second tap of a drifting double tap cannot land on the row or button that replaced
       * the one tapped. Keyboard activations are not delayed.
       */
      actionCooldownMs: positiveInt,
    })
    .refine((overlay) => overlay.hudCompactHeightPx < overlay.hudHeightPx, {
      error: 'hudCompactHeightPx must be less than hudHeightPx',
      path: ['hudCompactHeightPx'],
    }),
})
export type LayoutConfig = z.infer<typeof LayoutConfigSchema>

const PACK_ID = /^[a-z0-9-]+$/

export const CopyConfigSchema = z
  .strictObject({
    /** Active slang pack id. Swapping it needs no code change. */
    slangPack: z.string().regex(PACK_ID),
    /**
     * Every slang pack. A pack overrides a namespace with data/copy/<namespace>/<pack>.json;
     * a namespace it does not override has no file for it.
     */
    packs: z.array(z.string().regex(PACK_ID)).min(1),
  })
  .refine((config) => config.packs.includes(config.slangPack), {
    error: 'slangPack must be one of packs',
    path: ['slangPack'],
  })
  .refine((config) => new Set(config.packs).size === config.packs.length, {
    error: 'packs must not repeat',
    path: ['packs'],
  })
export type CopyConfig = z.infer<typeof CopyConfigSchema>

/** The welcome card: the 18+ check, the under-age lock and the consent version (S05a). */
export const OnboardingConfigSchema = z
  .strictObject({
    /** Players must be at least this old. The year picker never shows or hints at it. */
    minimumAge: positiveInt,
    /** How long an under-age answer locks the gate on that device. */
    underAgeLockHours: positiveInt,
    /** How many years back the year picker goes from the current year. */
    birthYearSpan: positiveInt,
    /** Version of the Terms and Privacy Policy a player consents to (an ISO date). */
    consentVersion: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .refine((config) => config.birthYearSpan > config.minimumAge + 1, {
    error: 'birthYearSpan must reach past minimumAge, or no year in the picker can pass',
    path: ['birthYearSpan'],
  })
export type OnboardingConfig = z.infer<typeof OnboardingConfigSchema>

/** The kinds of notice a new player may see (GR-9): each surface tags itself `data-cc-notice`. */
export const NOTICE_KINDS = [
  'tour',
  'level-up',
  'goals-ready',
  'event',
  'icon',
  'update',
  'rent',
] as const

/**
 * The first-run tour (S06): coach marks over the live map that walk a new player through one
 * purchase, and the GR-9 limit on what a new player is shown. Cross-file references (the place,
 * its action, the step copy) are checked in src/lib/data/data.test.ts.
 */
export const TourConfigSchema = z.strictObject({
  /** The place the tour leads to, and the action bought there. */
  placeId: z.string().min(1),
  actionId: z.string().min(1),
  /** At most this many steps (GR-9: short). */
  maxSteps: positiveInt,
  /** A step's text, with its values filled in, fits the banner zone at 390 px. */
  maxCharsPerStep: positiveInt,
  /**
   * The tour starts by itself only for a fresh game: nothing bought, earned or visited yet, and
   * no more than this many game minutes played. Any other player is a veteran: the tour is
   * marked done without showing, and stays one tap away in More, Help.
   */
  freshStartMaxGameMinutes: positiveInt,
  /**
   * How long the tour takes a player (the acceptance target: about 20 s): reading each step at
   * `readCharsPerSecond` plus one tap per step.
   */
  timing: z.strictObject({
    targetSeconds: positive,
    readCharsPerSecond: positive,
    secondsPerTap: positive,
  }),
  /** GR-9: a new player starts with at most this many notices. */
  newPlayerNoticeMax: positiveInt,
  /** The notice kinds that may reach a new player; every `data-cc-notice` must be one. */
  meaningfulNotices: z
    .array(z.enum(NOTICE_KINDS))
    .min(1)
    .refine((kinds) => new Set(kinds).size === kinds.length, { error: 'kinds must not repeat' }),
})
export type TourConfig = z.infer<typeof TourConfigSchema>

const volume = z.int().min(0).max(100)
const AudioTierSchema = z.strictObject({
  /** Decode the sound effects as soon as the runtime starts (else on first use). */
  preloadSfx: z.boolean(),
  /** Fetch the next music track ahead of the crossfade (else at the switch). */
  prefetchNextMusic: z.boolean(),
})

/**
 * The audio mixer and runtime (S05b). Volumes are whole percent 0-100 on the player's sliders;
 * gains follow a squared curve (src/lib/audio/mixer.ts). Times are seconds.
 */
export const AudioConfigSchema = z
  .strictObject({
    defaults: z.strictObject({
      master: volume,
      music: volume,
      sfx: volume,
      ambience: volume,
      voice: volume,
    }),
    /** Slider step; every stored volume is a multiple of it. */
    volumeStep: z.int().min(1).max(50),
    /** Length of the linear ramp on every gain change, so volume moves never click. */
    rampSeconds: positive,
    musicCrossfadeSeconds: positive,
    /** How long one music track plays before the next fades in. */
    musicTrackPlaySeconds: positive,
    /** How far ahead of the switch the next track is fetched, where the tier prefetches. */
    prefetchAheadSeconds: positive,
    tiers: perTier(AudioTierSchema),
  })
  .refine((audio) => 100 % audio.volumeStep === 0, {
    error: 'volumeStep must divide 100',
    path: ['volumeStep'],
  })
  .refine(
    (audio) => Object.values(audio.defaults).every((value) => value % audio.volumeStep === 0),
    { error: 'defaults must be multiples of volumeStep', path: ['defaults'] },
  )
  .refine((audio) => audio.musicCrossfadeSeconds < audio.musicTrackPlaySeconds, {
    error: 'the crossfade must be shorter than a track',
    path: ['musicCrossfadeSeconds'],
  })
  .refine(
    (audio) =>
      audio.prefetchAheadSeconds > audio.musicCrossfadeSeconds &&
      audio.prefetchAheadSeconds < audio.musicTrackPlaySeconds,
    {
      error: 'prefetchAheadSeconds must fall between the crossfade and the track length',
      path: ['prefetchAheadSeconds'],
    },
  )
export type AudioConfig = z.infer<typeof AudioConfigSchema>

const metres = z.number().positive()

const GEO_BOROUGHS = ['manhattan', 'bronx', 'brooklyn', 'queens', 'staten-island'] as const

export const GeoDistrictSchema = z.strictObject({
  id: z.enum(BUILDING_DISTRICT_IDS),
  label: z.string().min(1),
  borough: z.enum(GEO_BOROUGHS),
  /** WGS84 centre, inside the NYC extent. */
  center: z.strictObject({
    lat: z.number().min(40.4).max(41),
    lng: z.number().min(-74.3).max(-73.6),
  }),
  radiusM: metres,
})
export type GeoDistrict = z.infer<typeof GeoDistrictSchema>

/** How one quality tier simplifies the district footprints. */
export const BuildingTierSchema = z.strictObject({
  /** Douglas-Peucker tolerance for each output ring. */
  simplifyM: metres,
  /** Footprints smaller than this (true m², after projection) are dropped. */
  minAreaM2: metres,
  /** Footprints lower than this (after the feet-to-metres conversion) are dropped. */
  minHeightM: z.number().nonnegative(),
  /** Heights are rounded to multiples of this; touching footprints in one bin may merge. */
  heightBinM: metres,
  /** Merge touching footprints of the same height bin into one mass. */
  merge: z.boolean(),
})
export type BuildingTier = z.infer<typeof BuildingTierSchema>

export const BuildingTiersSchema = z
  .strictObject({
    /** Height used when HEIGHT_ROOF is missing or zero. */
    defaultHeightM: metres,
    /** Footprints are snapped to this grid before merging. */
    quantumM: z.literal(1),
    tiers: perTier(BuildingTierSchema),
  })
  .refine(
    ({ tiers }) =>
      tiers.low.simplifyM >= tiers.mid.simplifyM &&
      tiers.mid.simplifyM >= tiers.high.simplifyM &&
      tiers.low.minAreaM2 >= tiers.mid.minAreaM2 &&
      tiers.mid.minAreaM2 >= tiers.high.minAreaM2,
    { error: 'lower tiers must simplify at least as much as higher ones', path: ['tiers'] },
  )
export type BuildingTiers = z.infer<typeof BuildingTiersSchema>

/** Procedural low blocks outside the districts, one jittered grid per tier and borough. */
export const BlocksConfigSchema = z.strictObject({
  /** Seed for src/engine/rng.ts; changing it reshuffles every block. */
  seed: z.int().nonnegative(),
  /** Storey height: a block is its zone's average floors times this. */
  floorM: metres,
  /** Random offset of a block from its grid point, as a fraction of the spacing. */
  jitter: z.number().min(0).max(0.5),
  /** Random spread of the floor count around the zone average (0.4 = plus or minus 40%). */
  heightJitter: z.number().min(0).max(0.9),
  /** Floor-area ratio at which every grid point gets a block; lower FAR fills proportionally. */
  fullFar: positive,
  /** Block side as a fraction of the grid spacing. */
  footprintFraction: z.number().gt(0).max(1),
  spacingM: perTier(metres),
  /** The build fails when a tier places more blocks than this. */
  maxInstances: perTier(positiveInt),
  /** Grid rotation per borough, degrees counter-clockwise from east (Manhattan's street grid). */
  gridAngleDeg: z.strictObject({
    manhattan: z.number().min(-90).max(90),
    bronx: z.number().min(-90).max(90),
    brooklyn: z.number().min(-90).max(90),
    queens: z.number().min(-90).max(90),
    'staten-island': z.number().min(-90).max(90),
  }),
})
export type BlocksConfig = z.infer<typeof BlocksConfigSchema>

/**
 * Parameters of `npm run geo:build` (scripts/geo). Distances in metres, weights and areas in
 * square metres. Changing any of them changes the committed geo outputs: rebuild them.
 */
export const GeoConfigSchema = z
  .strictObject({
    /** Output grid: coordinates are rounded to whole metres. */
    quantumM: z.literal(1),
    /** Visvalingam minimum triangle area kept on borough shorelines. */
    landMinWeightM2: metres,
    landMinRingAreaM2: metres,
    zoneMinWeightM2: metres,
    zoneMinRingAreaM2: metres,
    parkMinRingAreaM2: metres,
    /** Douglas-Peucker tolerance for subway paths. */
    subwayToleranceM: metres,
    /** A shape is dropped when every vertex lies this close to the paths already kept. */
    subwayDedupCoverM: metres,
    /** A station must lie this close to a path of one of its own lines. */
    stationOnLineToleranceM: metres,
    /** Longest gap a route's path may be extended by to reach its terminal station. */
    terminalGapMaxM: metres,
    /** Longest distance a station may be snapped to its nearest borough or zone. */
    stationAreaFallbackM: metres,
    /** How far the sea extends beyond data/geo/bounds.json. */
    waterMarginM: metres,
    /**
     * Districts with real building masses (S04d): footprints whose centroid lies inside the
     * circle are kept. `label` names the district in SOURCES.md and build logs only; player-facing
     * names come from copy.
     */
    districts: z.array(GeoDistrictSchema).min(1),
    buildingTiers: BuildingTiersSchema,
    blocks: BlocksConfigSchema,
    /** A landmark's fronting LION street must pass this close to its location (S07a). */
    landmarkFrontMaxM: metres,
    /** Clear ground kept around a landmark model's footprint (its exclusion rectangle). */
    landmarkExclusionMarginM: z.number().nonnegative(),
  })
  .refine((geo) => new Set(geo.districts.map((d) => d.id)).size === geo.districts.length, {
    error: 'district ids must be unique',
    path: ['districts'],
  })
  .refine(
    (geo) =>
      geo.districts.every((a, i) =>
        geo.districts
          .slice(i + 1)
          .every((b) => distanceM(project(a.center), project(b.center)) > a.radiusM + b.radiusM),
      ),
    { error: 'district circles must not overlap', path: ['districts'] },
  )
  .refine(
    (geo) =>
      geo.stationOnLineToleranceM >
      geo.subwayToleranceM + geo.subwayDedupCoverM + geo.quantumM / Math.SQRT2,
    {
      error: 'stationOnLineToleranceM must exceed simplification plus dedup plus rounding error',
      path: ['stationOnLineToleranceM'],
    },
  )
export type GeoConfig = z.infer<typeof GeoConfigSchema>

/** A goal's reward: whole dollars, whole clout points and, for the victory goal, a badge. */
const GoalRewardSchema = z.strictObject({
  cash: z.optional(dollars),
  clout: z.optional(z.int().nonnegative()),
  /** The run's prestige badge (`prestige.badgeIds`); only the victory goal may carry it. */
  badge: z.optional(z.literal(true)),
})

const GoalSchema = z.strictObject({
  id: z.string().regex(KEBAB_ID),
  fact: z.enum(GOAL_FACTS),
  /** For `clout-level` goals only: the `clout.levels` id the player's goal clout must hold. */
  level: z.optional(z.string().regex(KEBAB_ID)),
  /** False while the feature behind the goal is not built yet: shown as coming soon. */
  available: z.optional(z.boolean()),
  /** Reaching this goal is winning the game: the Icon moment and prestige (exactly one). */
  victory: z.optional(z.literal(true)),
  reward: GoalRewardSchema,
})

const gapPct = z.int().min(1).max(99)

/**
 * Goals, grants and prestige (S15, src/engine/goals.ts, grants.ts, prestige.ts). Every reward is
 * paid by the one grant function, capped at `grants.capPctOfGap` percent of what the player
 * still needs for their next progression goal (clout: the next level; cash: the next home's rent
 * reserve plus move-in cost), and at most `grants.maxPerGrant`. A percentage below 100 means a
 * grant can never by itself close the gap. All numbers are TUNE-5 placeholders.
 *
 * Rules that need the clout levels (level goals name real levels, one goal per level above the
 * first, the victory goal at the top) are added by {@link createProgressionConfigSchema}.
 */
export const ProgressionConfigSchema = z
  .strictObject({
    goals: z.array(GoalSchema).min(1),
    grants: z.strictObject({
      capPctOfGap: z.strictObject({ cash: gapPct, clout: gapPct }),
      maxPerGrant: z.strictObject({ cash: dollars, clout: z.int().nonnegative() }),
      /** Grant records kept in the save (oldest dropped first). */
      log: z.strictObject({ maxEntries: positiveInt }),
    }),
    prestige: z.strictObject({
      /** The goal a run must reach before the player may prestige: the victory goal. */
      requiresGoal: z.string().regex(KEBAB_ID),
      /** The badge each run earns, in order; runs past the end earn the last one again. */
      badgeIds: z.array(z.string().regex(KEBAB_ID)).min(1),
      /** Whether goals pay their cash and clout again in later runs (the badge always does). */
      rewardsRepeat: z.boolean(),
      resets: z.array(z.enum(PRESTIGE_PARTS)),
      keeps: z.array(z.enum(PRESTIGE_PARTS)),
    }),
  })
  .refine(({ goals }) => new Set(goals.map((goal) => goal.id)).size === goals.length, {
    error: 'goal ids must be unique',
    path: ['goals'],
  })
  .refine(
    ({ goals }) =>
      goals.every((goal) => (goal.fact === 'clout-level') === (goal.level !== undefined)),
    { error: 'a goal has a level exactly when its fact is clout-level', path: ['goals'] },
  )
  .refine(({ goals }) => goals.filter((goal) => goal.victory === true).length === 1, {
    error: 'exactly one goal must be the victory goal',
    path: ['goals'],
  })
  .refine(
    ({ goals }) =>
      goals.every(
        (goal) => goal.reward.badge === undefined || (goal.victory === true && !goalPays(goal)),
      ),
    { error: 'only the victory goal carries a badge, and then no cash or clout', path: ['goals'] },
  )
  .refine(
    ({ goals, grants }) =>
      goals.every(
        (goal) =>
          (goal.reward.cash ?? 0) <= grants.maxPerGrant.cash &&
          (goal.reward.clout ?? 0) <= grants.maxPerGrant.clout,
      ),
    { error: 'a goal reward exceeds grants.maxPerGrant', path: ['goals'] },
  )
  .refine(
    ({ goals, prestige }) =>
      goals.some((goal) => goal.id === prestige.requiresGoal && goal.victory === true),
    { error: 'prestige.requiresGoal must be the victory goal', path: ['prestige', 'requiresGoal'] },
  )
  .refine(({ prestige }) => new Set(prestige.badgeIds).size === prestige.badgeIds.length, {
    error: 'prestige.badgeIds must be unique',
    path: ['prestige', 'badgeIds'],
  })
  .refine(
    ({ prestige: { resets, keeps } }) => {
      const listed = [...resets, ...keeps]
      return (
        listed.length === PRESTIGE_PARTS.length &&
        PRESTIGE_PARTS.every((part) => listed.includes(part))
      )
    },
    { error: 'every prestige part is listed once, in resets or keeps', path: ['prestige'] },
  )
  .refine(
    ({ prestige: { resets, keeps } }) =>
      PRESTIGE_MUST_RESET.every((part) => resets.includes(part)) &&
      PRESTIGE_MUST_KEEP.every((part) => keeps.includes(part)),
    {
      error: `prestige must reset ${PRESTIGE_MUST_RESET.join(', ')} and keep ${PRESTIGE_MUST_KEEP.join(', ')}`,
      path: ['prestige'],
    },
  )
export type ProgressionConfig = z.infer<typeof ProgressionConfigSchema>

function goalPays(goal: { readonly reward: { cash?: number; clout?: number } }): boolean {
  return (goal.reward.cash ?? 0) > 0 || (goal.reward.clout ?? 0) > 0
}

/**
 * {@link ProgressionConfigSchema} plus the rules that need `clout.levels` (balance.json): every
 * level goal names a level above the first, every such level has exactly one goal, and the
 * victory goal is the top level's.
 */
export function createProgressionConfigSchema(
  levels: readonly { readonly id: string; readonly minClout: number }[],
) {
  const above = levels.slice(1).map((level) => level.id)
  return ProgressionConfigSchema.refine(
    ({ goals }) => {
      const named = goals.flatMap((goal) => (goal.level === undefined ? [] : [goal.level]))
      return (
        named.every((id) => above.includes(id)) &&
        above.every((id) => named.filter((name) => name === id).length === 1)
      )
    },
    {
      error: 'every clout level above the first has exactly one level goal, and no other',
      path: ['goals'],
    },
  ).refine(
    ({ goals }) => {
      const victory = goals.find((goal) => goal.victory === true)
      return victory?.level !== undefined && victory.level === levels.at(-1)?.id
    },
    { error: 'the victory goal must be the top clout level', path: ['goals'] },
  )
}
