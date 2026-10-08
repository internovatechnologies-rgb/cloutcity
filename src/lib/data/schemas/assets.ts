/**
 * Schema for data/assets/manifest.json, written by `npm run assets:build` (S04h): every
 * hand-made model the game can load, per quality tier, with its hashed file, sizes and triangle
 * count. This file imports only `zod` so Node can load it directly from scripts/.
 */
import { z } from 'zod'

export const MODEL_TIERS = ['low', 'mid', 'high'] as const
export type ModelTier = (typeof MODEL_TIERS)[number]

/** Each category has its own per-asset caps in perf.json `models`. */
export const MODEL_CATEGORIES = [
  'vehicle',
  'street-prop',
  'tree',
  'building',
  'building-detail',
  'furniture',
  'room-shell',
  'avatar-rig',
  'avatar-head',
  'avatar-body',
  'avatar-accessory',
] as const
export type ModelCategory = (typeof MODEL_CATEGORIES)[number]

/**
 * When a model is first needed: with the city (`playable`), streamed in after it
 * (`after-playable`), or only when the apartment or the avatar creator opens.
 */
export const MODEL_LOAD_PHASES = ['playable', 'after-playable', 'apartment', 'creator'] as const

const id = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
const vec3 = z.tuple([z.number(), z.number(), z.number()])

const TierFileSchema = z.strictObject({
  /** Served path: /models/<id>.<tier>.<sha8>.glb (tiers with identical bytes share a file). */
  file: z.string().regex(/^\/models\/[a-z0-9-]+\.(?:low|mid|high)\.[0-9a-f]{8}\.glb$/),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.int().positive(),
  gzBytes: z.int().positive(),
  triangles: z.int().nonnegative(),
})
export type ModelTierFile = z.infer<typeof TierFileSchema>

export const ModelManifestEntrySchema = z
  .strictObject({
    id,
    kind: z.enum(['static', 'skinned', 'rig']),
    category: z.enum(MODEL_CATEGORIES),
    loadPhase: z.enum(MODEL_LOAD_PHASES),
    instanced: z.boolean(),
    nameKey: z.string().regex(/^models\.name\.[a-zA-Z0-9]+$/),
    /** Fitted bounds in metres (1 scene unit = 1 m); rigs have none. */
    bounds: z.strictObject({ min: vec3, max: vec3 }).optional(),
    /** Recolourable slots, in `_SLOT` order (attribute value = index + 1). */
    slots: z.array(id),
    /** Whether any vertex carries `_EMISSIVE`. */
    emissive: z.boolean(),
    clips: z.array(z.string().min(1)),
    tiers: z.strictObject({ low: TierFileSchema, mid: TierFileSchema, high: TierFileSchema }),
  })
  .refine((model) => (model.kind === 'rig') === (model.bounds === undefined), {
    error: 'every model but a rig has bounds',
    path: ['bounds'],
  })
export type ModelManifestEntry = z.infer<typeof ModelManifestEntrySchema>

export const ModelManifestSchema = z
  .strictObject({
    version: z.literal(1),
    /** Hash of everything below, so a client cache keyed on it changes with any model. */
    assetVersion: z.string().regex(/^[0-9a-f]{16}$/),
    models: z.array(ModelManifestEntrySchema),
  })
  .refine((manifest) => new Set(manifest.models.map((m) => m.id)).size === manifest.models.length, {
    error: 'model ids must be unique',
  })
export type ModelManifest = z.infer<typeof ModelManifestSchema>

/**
 * data/assets/showcase.json: the /dev/models review scenes (test builds only, S04h). Colours
 * are theme.json `models` token names; lighting presets stand in for the day/night keyframes
 * until the S04f lighting reaches this route.
 */
const hex = z.string().regex(/^#[0-9a-f]{6}$/)
const token = z.string().regex(/^[a-z]+-[0-9]+$/)
const ShowcaseCameraSchema = z.strictObject({
  position: vec3,
  target: vec3,
  fovDeg: z.number().min(10).max(90),
})
const ShowcaseLightSchema = z.strictObject({
  sky: hex,
  ambient: z.strictObject({ color: hex, intensity: z.number().nonnegative() }),
  hemisphere: z.strictObject({ sky: hex, ground: hex, intensity: z.number().nonnegative() }),
  sun: z.strictObject({ color: hex, intensity: z.number().nonnegative(), position: vec3 }),
  /** Which scene.json `models.emissive` intensity the night-glow vertices use. */
  glow: z.enum(['day', 'night']),
  /** The sun's shadow on the high tier (one directional PCFShadowMap, perf.json `shadows`). */
  shadow: z.strictObject({
    extentM: z.number().positive(),
    mapSizePx: z.union([z.literal(1024), z.literal(2048)]),
    bias: z.number().max(0),
    normalBias: z.number().nonnegative(),
  }),
})
const SlotTokensSchema = z.record(id, token)
const ShowcaseViewSchema = z.strictObject({
  camera: z.strictObject({ landscape: ShowcaseCameraSchema, portrait: ShowcaseCameraSchema }),
  grounds: z.array(
    z.strictObject({
      color: token,
      center: vec3,
      size: z.tuple([z.number().positive(), z.number().positive()]),
    }),
  ),
  placements: z.array(
    z.strictObject({
      model: id,
      position: vec3,
      rotationDeg: z.number().optional(),
      scale: z.number().positive().optional(),
      colors: SlotTokensSchema.optional(),
    }),
  ),
  lineup: z
    .strictObject({
      columns: z.strictObject({ landscape: z.int().positive(), portrait: z.int().positive() }),
      spacingM: z.number().positive(),
      rowDepthM: z.number().positive(),
      clip: z.string().min(1),
      avatars: z.array(
        z.strictObject({
          head: id,
          body: id,
          colors: z.strictObject({ head: SlotTokensSchema, body: SlotTokensSchema }),
        }),
      ),
    })
    .optional(),
  /** Every catalog model in a grid, each scaled to fit one cell. */
  grid: z
    .strictObject({
      cellM: z.number().positive(),
      columns: z.strictObject({ landscape: z.int().positive(), portrait: z.int().positive() }),
    })
    .optional(),
})
export const SHOWCASE_VIEWS = ['avatars', 'street', 'room', 'catalog'] as const
export const SHOWCASE_TIMES = ['day', 'golden', 'night'] as const
export const ShowcaseSchema = z.strictObject({
  version: z.literal(1),
  lighting: z.strictObject({
    day: ShowcaseLightSchema,
    golden: ShowcaseLightSchema,
    night: ShowcaseLightSchema,
  }),
  views: z.strictObject({
    avatars: ShowcaseViewSchema,
    street: ShowcaseViewSchema,
    room: ShowcaseViewSchema,
    catalog: ShowcaseViewSchema,
  }),
})
export type Showcase = z.infer<typeof ShowcaseSchema>
export type ShowcaseView = Showcase['views']['street']
export type ShowcaseLight = Showcase['lighting']['day']
