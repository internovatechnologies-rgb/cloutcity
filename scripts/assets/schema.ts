/**
 * Schemas for the hand-made 3D asset pipeline (S04h, DEC-24/25/26): data/assets/catalog.json
 * (what is built, from which pinned pack, and how) and scripts/assets/sources.lock.json (what was
 * actually downloaded). The runtime manifest's schema lives in src/lib/data/schemas/assets.ts.
 */
import { z } from 'zod'
import {
  MODEL_CATEGORIES,
  MODEL_LOAD_PHASES,
  MODEL_TIERS,
} from '../../src/lib/data/schemas/assets.ts'

const httpsUrl = z.url({ protocol: /^https$/ })
export const IdSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
const sha256 = z.string().regex(/^[0-9a-f]{64}$/)
const token = z.string().regex(/^[a-z]+-\d{2,3}$/)
const hex = z.string().regex(/^#[0-9a-f]{6}$/)
/** A path inside a pack: relative, forward slashes, no `..`, no leading slash. */
const packPath = z
  .string()
  .min(1)
  .refine((path) => !path.startsWith('/') && !path.split('/').includes('..'), {
    error: 'must be a relative path without ..',
  })

/**
 * Licences an asset may carry. CC0 and MIT for third-party packs (DEC-24); `project-original`
 * only for our own Blender scripts (DEC-25). Anything else fails the catalog.
 */
export const LICENCES = ['CC0-1.0', 'MIT', 'project-original'] as const
export const PACK_LICENCES: readonly string[] = ['CC0-1.0', 'MIT']

const DownloadSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('zip'),
    url: httpsUrl,
    /** File name in the cache (.cache/assets/). */
    file: z.string().regex(/^[a-z0-9._-]+\.zip$/),
    /** Folder inside the zip that model entries are relative to. */
    root: packPath,
  }),
  z.strictObject({
    kind: z.literal('github-raw'),
    repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
    /** Full commit sha, so the files can never move under the pin. */
    commit: z.string().regex(/^[0-9a-f]{40}$/),
    /** Folder in the repository that model entries are relative to. */
    root: packPath,
  }),
  z.strictObject({
    kind: z.literal('local'),
    /** Committed Blender outputs, verified against scripts/blender/lock.json. */
    root: z.literal('scripts/blender/out'),
  }),
])
export type Download = z.infer<typeof DownloadSchema>

export const GradeSchema = z.strictObject({
  lightness: z.number().gt(0).max(2),
  chroma: z.number().min(0).max(2),
})

export const SourceSchema = z
  .strictObject({
    id: IdSchema,
    kind: z.enum(['cc0-pack', 'blender-script']),
    title: z.string().min(1),
    version: z.string().min(1),
    author: z.string().min(1),
    /** Where a human can read the pack's licence and download it. */
    homepage: httpsUrl,
    licence: z.enum(LICENCES),
    /**
     * The licence file shipped with the pack (an entry of the zip, a path in the repository at the
     * pinned commit, or a committed file for local sources) and phrases it must contain.
     */
    licenceEvidence: z.strictObject({
      entry: packPath,
      mustContain: z.array(z.string().min(1)).min(1),
    }),
    download: DownloadSchema,
    /**
     * How the pack stores material base colour factors. glTF says linear, but some older Kenney
     * exports wrote sRGB values (their own previews match the factor read as sRGB).
     */
    factorEncoding: z.enum(['linear', 'srgb']),
    /** OKLCH grade towards real-world colours (DEC-26), applied before swatch snapping. */
    grade: GradeSchema,
  })
  .refine(
    (source) =>
      source.kind === 'cc0-pack'
        ? PACK_LICENCES.includes(source.licence) && source.download.kind !== 'local'
        : source.licence === 'project-original' && source.download.kind === 'local',
    {
      error:
        'cc0-pack sources need a CC0-1.0 or MIT licence and a remote download; blender-script sources are project-original and local',
    },
  )
export type Source = z.infer<typeof SourceSchema>

const vec3 = z.tuple([z.number(), z.number(), z.number()])

const EntrySchema = z.strictObject({
  /** File inside the source's root (.glb or .gltf). */
  path: packPath.refine((path) => /\.(?:glb|gltf)$/.test(path), { error: 'must be .glb or .gltf' }),
  /** Offset in source units, applied after the rotation (composites). */
  at: vec3.optional(),
  rotateYDeg: z.number().optional(),
})

const TierSchema = z.strictObject({
  /** Target share of triangles kept by MeshoptSimplifier; 1 keeps the mesh as authored. */
  ratio: z.number().gt(0).max(1),
  /** Relative error bound for the simplifier. */
  error: z.number().min(0).max(1),
})

/** Uniform scale so the model's size along one measure is `metres` (1 scene unit = 1 m). */
const FitSchema = z.union([
  z.strictObject({ height: z.number().positive() }),
  /** Longest horizontal extent. */
  z.strictObject({ length: z.number().positive() }),
  z.strictObject({ scale: z.number().positive() }),
])

const SlotSchema = z.strictObject({
  name: IdSchema,
  tokens: z.array(token).min(1),
  /** Skinned only: limit the slot to triangles whose strongest joint is one of these. */
  joints: z.array(z.string().min(1)).min(1).optional(),
})

export const ModelSchema = z
  .strictObject({
    id: IdSchema,
    source: IdSchema,
    /**
     * `static` merges everything into one primitive; `skinned` keeps one skinned mesh and its
     * joints (no clips); `rig` keeps only the joints and the listed clips.
     */
    kind: z.enum(['static', 'skinned', 'rig']),
    entries: z.array(EntrySchema).min(1),
    /** Skinned only: the mesh to keep from the entry (heads and bodies share one rig). */
    mesh: z.string().min(1).optional(),
    category: z.enum(MODEL_CATEGORIES),
    fit: FitSchema,
    /** Where the origin sits after fitting. `source` keeps the authored origin. */
    pivot: z.enum(['bottom-center', 'center', 'source']),
    tiers: z.strictObject(
      Object.fromEntries(MODEL_TIERS.map((tier) => [tier, TierSchema])) as Record<
        (typeof MODEL_TIERS)[number],
        typeof TierSchema
      >,
    ),
    /** Theme `models` tokens the baked colours may snap to (CIEDE2000 within maxDeltaE). */
    swatches: z.array(token),
    /**
     * Source colours (sRGB hex, before grading) that anchor a token: a baked colour joins the token
     * of its nearest anchor when within maxDeltaE, before the swatches are tried. One anchor per
     * material covers a whole gradient (KayKit) or a mis-hued pack colour (Kenney's teal leaves).
     */
    remap: z.record(hex, token).optional(),
    /**
     * How far (CIEDE2000) a baked colour may be from a `remap` anchor to join it; defaults to
     * `maxDeltaE`. A tight radius pins one exact pack colour (the taxi's hood highlight) without
     * pulling in its neighbours (the roof sign).
     */
    remapMaxDeltaE: z.number().positive().max(100).optional(),
    maxDeltaE: z.number().positive().max(100).optional(),
    /** Tokens whose vertices glow at night (`_EMISSIVE` = 1). */
    emissive: z.array(token),
    /**
     * Night-glow colour per emissive token (e.g. dark window glass glows warm window light);
     * an emissive token without an entry glows in its own colour.
     */
    glow: z.record(token, token).optional(),
    /** Recolourable regions (`_SLOT` = index + 1), matched by token. */
    slots: z.array(SlotSchema),
    /** Rig only: animation clips kept (everything else is dropped). */
    clips: z.array(z.string().min(1)),
    loadPhase: z.enum(MODEL_LOAD_PHASES),
    /** Drawn many times at once (InstancedMesh in Part 2). */
    instanced: z.boolean(),
    /** Copy key of the model's human name (data/copy/models). */
    nameKey: z.string().regex(/^models\.name\.[a-zA-Z0-9]+$/),
  })
  .refine((model) => model.kind === 'rig' || model.clips.length === 0, {
    error: 'only rig models keep clips',
    path: ['clips'],
  })
  .refine((model) => model.kind !== 'rig' || model.clips.length > 0, {
    error: 'a rig needs at least one clip',
    path: ['clips'],
  })
  .refine((model) => (model.kind === 'skinned') === (model.mesh !== undefined), {
    error: 'skinned models (and only they) name the mesh to keep',
    path: ['mesh'],
  })
  .refine(
    (model) => model.kind === 'skinned' || model.slots.every((slot) => slot.joints === undefined),
    {
      error: 'only skinned models may limit slots by joint',
      path: ['slots'],
    },
  )
  .refine((model) => model.kind === 'static' || model.entries.length === 1, {
    error: 'only static models may be composites',
    path: ['entries'],
  })
  .refine((model) => model.kind === 'static' || model.pivot === 'source', {
    error: 'skinned and rig models keep their authored origin',
    path: ['pivot'],
  })
  .refine(
    (model) =>
      model.slots.every((slot) => slot.tokens.every((t) => model.swatches.includes(t))) &&
      model.emissive.every((t) => model.swatches.includes(t)) &&
      Object.keys(model.glow ?? {}).every((t) => model.emissive.includes(t)),
    {
      error: 'slot and emissive tokens must be in swatches, glow keys in emissive',
      path: ['slots'],
    },
  )
export type Model = z.infer<typeof ModelSchema>

export const CatalogSchema = z
  .strictObject({
    version: z.literal(1),
    /** Default CIEDE2000 snapping tolerance. */
    maxDeltaE: z.number().positive().max(100),
    sources: z.array(SourceSchema).min(1),
    models: z.array(ModelSchema),
    /** Pack items and packs deliberately left out, with the reason (LEGAL review record). */
    excluded: z.array(z.strictObject({ item: z.string().min(1), reason: z.string().min(1) })),
  })
  .superRefine((catalog, ctx) => {
    const sourceIds = new Set<string>()
    for (const [i, source] of catalog.sources.entries()) {
      if (sourceIds.has(source.id)) {
        ctx.addIssue({
          code: 'custom',
          message: `duplicate source ${source.id}`,
          path: ['sources', i],
        })
      }
      sourceIds.add(source.id)
    }
    const modelIds = new Set<string>()
    for (const [i, model] of catalog.models.entries()) {
      if (modelIds.has(model.id)) {
        ctx.addIssue({
          code: 'custom',
          message: `duplicate model ${model.id}`,
          path: ['models', i],
        })
      }
      modelIds.add(model.id)
      if (!sourceIds.has(model.source)) {
        ctx.addIssue({
          code: 'custom',
          message: `unknown source ${model.source}`,
          path: ['models', i, 'source'],
        })
      }
    }
  })
export type Catalog = z.infer<typeof CatalogSchema>

const LockFileSchema = z.strictObject({
  /** Path inside the pack (repository path or zip file name). */
  path: z.string().min(1),
  url: httpsUrl,
  sha256,
  bytes: z.int().positive(),
})

export const SourcesLockSchema = z.strictObject({
  version: z.literal(1),
  sources: z.array(
    z.strictObject({
      id: IdSchema,
      retrieved: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
      files: z.array(LockFileSchema).min(1),
    }),
  ),
})
export type SourcesLock = z.infer<typeof SourcesLockSchema>
export type LockedFile = z.infer<typeof LockFileSchema>
