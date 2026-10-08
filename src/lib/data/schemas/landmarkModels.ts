/**
 * Schemas for the landmark model kit (S07a): data/landmarks/models.json, the frames the geo
 * build derives from NYC DCP LION (data/landmarks/frames.derived.json), the `landmarks` block of
 * data/config/scene.json and the landmark palette roles in data/config/theme.json.
 *
 * A model is one of seven code-built archetypes with typed parameters: metres, counts and
 * palette roles only. Models carry no colours, no names and no text: nothing that could put a
 * sign, logo, clock face or brand on a building (LEGAL-1).
 *
 * Imports only zod and dependency-free relative `.ts` modules, so the Node geo build can load it.
 */
import { z } from 'zod'
import { LION_STREET_NAMES } from '../../geo/sources.ts'

const metres = z.number().positive()
const nonNegativeMetres = z.number().nonnegative()
const count = (min: number, max: number) => z.int().min(min).max(max)
const IdSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'kebab-case id')

// ---- palette roles ----------------------------------------------------------------------

/** Every colour role the kit paints with; theme.json maps each to a palette token. */
export const LANDMARK_ROLES = [
  'stone',
  'brick',
  'steel',
  'glass',
  'roof',
  'accent',
  'window',
  'outline',
  'dimmed',
] as const
export type LandmarkRole = (typeof LANDMARK_ROLES)[number]

/** Roles a model may paint its parts with. Window, outline and dimmed belong to the kit. */
export const PART_ROLES = ['stone', 'brick', 'steel', 'glass', 'roof', 'accent'] as const
export type PartRole = (typeof PART_ROLES)[number]
const RoleSchema = z.enum(PART_ROLES)

/** The landmark categories that get a model (S07b adds memorial: no window or emissive roles). */
export const MODEL_CATEGORIES = ['bridge', 'building', 'station', 'government'] as const
export type ModelCategory = (typeof MODEL_CATEGORIES)[number]

/** The part roles each category may use. */
export const CATEGORY_ROLES: Readonly<Record<ModelCategory, readonly PartRole[]>> = {
  bridge: ['stone', 'steel', 'accent'],
  building: ['stone', 'brick', 'steel', 'glass', 'roof', 'accent'],
  station: ['stone', 'brick', 'steel', 'glass', 'roof', 'accent'],
  government: ['stone', 'brick', 'roof', 'accent'],
}

// ---- LION frames ------------------------------------------------------------------------

/**
 * LION `SegmentTyp` codes (LION metadata, DCP "BYTES of the BIG APPLE" 26C): B both generic and
 * roadbed, C connector, E entrance/exit ramp, F faux, G generic, R roadbed, T terminator,
 * U undivided, S suppressed.
 */
export const LION_SEGMENT_TYPES = ['B', 'C', 'E', 'F', 'G', 'R', 'T', 'U', 'S'] as const
/** The main roadway: no ramps, connectors, faux segments, terminators or suppressed ones. */
export const LION_MAIN_ROADWAY_TYPES: readonly (typeof LION_SEGMENT_TYPES)[number][] = [
  'B',
  'G',
  'R',
  'U',
]
/** LION `RW_TYPE` codes 1-14 (3 is Bridge, 9 Ramp), as the service returns them, trimmed. */
export const LION_ROADWAY_TYPES = [
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  '10',
  '11',
  '12',
  '13',
  '14',
] as const

const LionStreetSchema = z.enum(LION_STREET_NAMES)

/**
 * A bridge is oriented by the principal axis of its main-roadway segments: those of `street`
 * whose segment type and roadway type are listed. Its two ends are the extremes along that axis.
 */
export const LionBridgeFrameSchema = z.strictObject({
  kind: z.literal('lion-bridge'),
  street: LionStreetSchema,
  segmentTypes: z
    .array(z.enum(LION_SEGMENT_TYPES))
    .min(1)
    .refine((types) => types.every((type) => LION_MAIN_ROADWAY_TYPES.includes(type)), {
      error: 'segmentTypes must be main roadway (B, G, R or U): no ramps or connectors',
    }),
  roadwayTypes: z.array(z.enum(LION_ROADWAY_TYPES)).min(1),
})

/**
 * Any other model faces `faceDeg` clockwise from the bearing (0-180°) of the nearest segment
 * of its fronting street.
 */
export const LionFrontFrameSchema = z.strictObject({
  kind: z.literal('lion-front'),
  street: LionStreetSchema,
  faceDeg: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
})

// ---- archetype parameters ----------------------------------------------------------------

const BlockSchema = z.strictObject({ widthM: metres, depthM: metres, heightM: metres })
const windows = { floors: count(1, 20), windowColumns: count(1, 24) }

/** A civic hall: a main block, optional side wings, a front portico, pediment and cupola. */
export const CivicHallParamsSchema = z
  .strictObject({
    widthM: metres,
    depthM: metres,
    heightM: metres,
    ...windows,
    wings: z.strictObject({ ...BlockSchema.shape, ...windows }).optional(),
    portico: z.strictObject({
      columns: count(2, 12),
      widthM: metres,
      depthM: metres,
      heightM: metres,
    }),
    pediment: z.strictObject({ heightM: metres }).optional(),
    cupola: z
      .strictObject({
        radiusM: metres,
        drumHeightM: metres,
        domeHeightM: metres,
        sides: count(6, 12),
      })
      .optional(),
    roles: z.strictObject({ body: RoleSchema, trim: RoleSchema, roof: RoleSchema }),
  })
  .refine((p) => p.portico.widthM <= p.widthM && p.portico.heightM <= p.heightM, {
    error: 'the portico must fit the front of the main block',
    path: ['portico'],
  })
  .refine((p) => p.cupola === undefined || p.cupola.radiusM * 2 < Math.min(p.widthM, p.depthM), {
    error: 'the cupola must fit on the roof',
    path: ['cupola'],
  })

/**
 * A station: generic entrance pavilions in a row along the front, a concourse canopy between
 * them and an optional hall behind. No signage, no clock.
 */
export const StationConcourseParamsSchema = z.strictObject({
  hall: z.strictObject({ ...BlockSchema.shape, ...windows }).optional(),
  canopy: z.strictObject({
    lengthM: metres,
    widthM: metres,
    heightM: metres,
    thicknessM: metres,
    supports: count(2, 12),
  }),
  pavilions: z.strictObject({
    count: count(1, 6),
    widthM: metres,
    depthM: metres,
    heightM: metres,
    spacingM: metres,
  }),
  roles: z.strictObject({
    body: RoleSchema,
    canopy: RoleSchema,
    glass: RoleSchema,
    trim: RoleSchema,
  }),
})

/**
 * A setback tower: stacked tiers, each inset from the one below, topped by a plain tapered
 * spire (never a copy of a real crown).
 */
export const SetbackSpireParamsSchema = z
  .strictObject({
    widthM: metres,
    depthM: metres,
    tiers: z
      .array(z.strictObject({ heightM: metres, insetM: nonNegativeMetres }))
      .min(2)
      .max(6),
    windowRows: count(1, 12),
    windowColumns: count(1, 12),
    spire: z.strictObject({ baseWidthM: metres, heightM: metres }),
    roles: z.strictObject({ body: RoleSchema, trim: RoleSchema, spire: RoleSchema }),
  })
  .refine(
    (p) => {
      const inset = p.tiers.reduce((sum, tier) => sum + tier.insetM, 0)
      return Math.min(p.widthM, p.depthM) - 2 * inset >= p.spire.baseWidthM
    },
    { error: 'the tiers must stay wider than the spire base', path: ['tiers'] },
  )

/** A terminal hall: a main hall with arched openings on its front, side wings and a low roof. */
export const TerminalHallParamsSchema = z
  .strictObject({
    widthM: metres,
    depthM: metres,
    heightM: metres,
    ...windows,
    arches: z.strictObject({ count: count(1, 5), widthM: metres, heightM: metres }),
    wings: BlockSchema,
    roof: z.strictObject({ heightM: metres }),
    roles: z.strictObject({ body: RoleSchema, trim: RoleSchema, roof: RoleSchema }),
  })
  .refine((p) => p.arches.count * p.arches.widthM < p.widthM && p.arches.heightM < p.heightM, {
    error: 'the arches must fit the front of the hall',
    path: ['arches'],
  })

/**
 * A wedge: plain triangular massing (a truncated prow at the front) on a low podium. Nothing
 * more: no cornice, no ornament (LEGAL-1).
 */
export const WedgeTowerParamsSchema = z
  .strictObject({
    lengthM: metres,
    baseWidthM: metres,
    prowWidthM: metres,
    heightM: metres,
    podiumHeightM: metres,
    podiumOutsetM: nonNegativeMetres,
    ...windows,
    roles: z.strictObject({ body: RoleSchema, podium: RoleSchema }),
  })
  .refine((p) => p.prowWidthM < p.baseWidthM && p.podiumHeightM < p.heightM, {
    error: 'the prow must be narrower than the base and the podium lower than the top',
  })

const deck = z.strictObject({
  widthM: metres,
  /** Deck top above the water plane at the towers (the deck meets the land top at its ends). */
  clearanceM: metres,
  thicknessM: metres,
})

/** Increasing offsets in metres along the bridge axis from the anchor, toward the second end. */
const axisOffsets = (min: number, max: number) =>
  z
    .array(z.number())
    .min(min)
    .max(max)
    .refine((list) => list.every((value, i) => i === 0 || value > (list[i - 1] ?? value)), {
      error: 'offsets must increase',
    })

/** Two towers on piers from the water, main cables between them and hangers to the deck. */
export const SuspensionBridgeParamsSchema = z
  .strictObject({
    deck,
    towers: z.strictObject({
      offsetsM: axisOffsets(2, 2),
      /** Tower top above the water plane. */
      heightM: metres,
      widthM: metres,
      depthM: metres,
      legWidthM: metres,
      openings: count(1, 2),
      pierHeightM: metres,
    }),
    cables: z.strictObject({ perSide: count(1, 2), hangerSpacingM: metres }),
    roles: z.strictObject({ deck: RoleSchema, tower: RoleSchema, cable: RoleSchema }),
  })
  .refine((p) => p.towers.heightM > p.deck.clearanceM && p.towers.pierHeightM < p.deck.clearanceM, {
    error: 'towers must rise above the deck and their piers stay below it',
    path: ['towers'],
  })
  .refine((p) => p.towers.widthM > p.deck.widthM, {
    error: 'the towers must be wider than the deck',
    path: ['towers', 'widthM'],
  })

/** Piers from the water with truss towers, a through truss over the deck between them. */
export const CantileverBridgeParamsSchema = z
  .strictObject({
    deck,
    piers: z.strictObject({
      offsetsM: axisOffsets(2, 6),
      /** Pier tower top above the water plane. */
      heightM: metres,
      widthM: metres,
      depthM: metres,
      finialM: metres,
    }),
    truss: z.strictObject({ heightM: metres, midHeightM: metres, panelM: metres }),
    roles: z.strictObject({ deck: RoleSchema, truss: RoleSchema, pier: RoleSchema }),
  })
  .refine((p) => p.truss.midHeightM < p.truss.heightM, {
    error: 'the truss must be lower mid-span than at the piers',
    path: ['truss'],
  })
  .refine((p) => p.piers.heightM - p.piers.finialM > p.deck.clearanceM + p.truss.heightM, {
    error: 'pier towers must rise above the truss',
    path: ['piers', 'heightM'],
  })
  .refine((p) => p.piers.widthM > p.deck.widthM, {
    error: 'piers must be wider than the deck',
    path: ['piers', 'widthM'],
  })

export const ARCHETYPES = [
  'civicHall',
  'stationConcourse',
  'setbackSpire',
  'terminalHall',
  'wedgeTower',
  'suspensionBridge',
  'cantileverBridge',
] as const
export type Archetype = (typeof ARCHETYPES)[number]

/** The landmark category each archetype depicts. */
export const ARCHETYPE_CATEGORY: Readonly<Record<Archetype, ModelCategory>> = {
  civicHall: 'government',
  stationConcourse: 'station',
  setbackSpire: 'building',
  terminalHall: 'station',
  wedgeTower: 'building',
  suspensionBridge: 'bridge',
  cantileverBridge: 'bridge',
}

// ---- models -----------------------------------------------------------------------------

/**
 * Where a model's height comes from. Wikidata "height" (P2048) is CC0; a model without one is
 * stylised and its height approximate (data/landmarks/SOURCES.md says which).
 */
export const HeightSourceSchema = z.strictObject({
  kind: z.literal('wikidata'),
  qid: z.string().regex(/^Q\d+$/),
  property: z.literal('P2048'),
  valueM: metres,
})

const modelBase = {
  id: IdSchema,
  /** `massing`: plain volumes only (LEGAL-1); `stylised`: generic low-poly detail. */
  depiction: z.enum(['massing', 'stylised']),
  heightSource: HeightSourceSchema.optional(),
}

export const LandmarkModelSchema = z.discriminatedUnion('archetype', [
  z.strictObject({
    ...modelBase,
    archetype: z.literal('civicHall'),
    params: CivicHallParamsSchema,
    frame: LionFrontFrameSchema,
  }),
  z.strictObject({
    ...modelBase,
    archetype: z.literal('stationConcourse'),
    params: StationConcourseParamsSchema,
    frame: LionFrontFrameSchema,
  }),
  z.strictObject({
    ...modelBase,
    archetype: z.literal('setbackSpire'),
    params: SetbackSpireParamsSchema,
    frame: LionFrontFrameSchema,
  }),
  z.strictObject({
    ...modelBase,
    archetype: z.literal('terminalHall'),
    params: TerminalHallParamsSchema,
    frame: LionFrontFrameSchema,
  }),
  z.strictObject({
    ...modelBase,
    archetype: z.literal('wedgeTower'),
    params: WedgeTowerParamsSchema,
    frame: LionFrontFrameSchema,
  }),
  z.strictObject({
    ...modelBase,
    archetype: z.literal('suspensionBridge'),
    params: SuspensionBridgeParamsSchema,
    frame: LionBridgeFrameSchema,
  }),
  z.strictObject({
    ...modelBase,
    archetype: z.literal('cantileverBridge'),
    params: CantileverBridgeParamsSchema,
    frame: LionBridgeFrameSchema,
  }),
])
export type LandmarkModel = z.infer<typeof LandmarkModelSchema>
export type ModelOf<A extends Archetype> = Extract<LandmarkModel, { archetype: A }>
export type ParamsOf<A extends Archetype> = ModelOf<A>['params']

/** Every role a model's params name. */
export function modelRoles(model: LandmarkModel): PartRole[] {
  return Object.values(model.params.roles)
}

/**
 * Landmarks LEGAL-1 ruled must be plain massing: no ornament that recreates a claimed design.
 * (The terminal is a generic hall: no sculpture group, no clock.)
 */
export const MASSING_ONLY_IDS: readonly string[] = ['wedge-building', 'midtown-terminal']

export const LandmarkModelsFileSchema = z.strictObject({
  models: z
    .array(
      LandmarkModelSchema.superRefine((model, ctx) => {
        const allowed = CATEGORY_ROLES[ARCHETYPE_CATEGORY[model.archetype]]
        for (const [part, role] of Object.entries(model.params.roles)) {
          if (!allowed.includes(role)) {
            ctx.addIssue({
              code: 'custom',
              message: `role "${role}" is not allowed for a ${ARCHETYPE_CATEGORY[model.archetype]}`,
              path: ['params', 'roles', part],
            })
          }
        }
      }),
    )
    .superRefine((models, ctx) => {
      const seen = new Set<string>()
      models.forEach((model, index) => {
        if (seen.has(model.id)) {
          ctx.addIssue({ code: 'custom', message: `duplicate id "${model.id}"`, path: [index] })
        }
        seen.add(model.id)
        if (MASSING_ONLY_IDS.includes(model.id) && model.depiction !== 'massing') {
          ctx.addIssue({
            code: 'custom',
            message: `${model.id} must be depiction "massing" (LEGAL-1)`,
            path: [index, 'depiction'],
          })
        }
      })
    }),
})
export type LandmarkModelsFile = z.infer<typeof LandmarkModelsFileSchema>

/** The landmarks.json fields the cross-file checks need. */
export interface ModelledPlace {
  readonly id: string
  readonly category: string
}

/**
 * models.json against landmarks.json: exactly one model per landmark in MODEL_CATEGORIES, and
 * each model's archetype depicts that landmark's category.
 */
export function landmarkModelsFileSchemaFor(places: readonly ModelledPlace[]) {
  const categoryOf = new Map(places.map((place) => [place.id, place.category]))
  const expected = places
    .filter((place) => (MODEL_CATEGORIES as readonly string[]).includes(place.category))
    .map((place) => place.id)
    .sort()
  return LandmarkModelsFileSchema.superRefine((file, ctx) => {
    const ids = file.models.map((model) => model.id).sort()
    if (ids.join() !== expected.join()) {
      ctx.addIssue({
        code: 'custom',
        message: `models must cover exactly ${expected.join(', ')}; got ${ids.join(', ')}`,
        path: ['models'],
      })
    }
    file.models.forEach((model, index) => {
      const category = categoryOf.get(model.id)
      if (category !== undefined && category !== ARCHETYPE_CATEGORY[model.archetype]) {
        ctx.addIssue({
          code: 'custom',
          message: `${model.id} is a ${category}; ${model.archetype} depicts a ${ARCHETYPE_CATEGORY[model.archetype]}`,
          path: ['models', index, 'archetype'],
        })
      }
    })
  })
}

// ---- derived frames ------------------------------------------------------------------------

const PointSchema = z.strictObject({ x: z.number(), y: z.number() })
const heading = z.number().min(0).lt(360)

/**
 * A rotated rectangle, local metres: the ground a landmark occupies, which district buildings
 * keep clear of (S04d, INT-7). Centred on (x, y); the length runs along `angleDeg`, measured
 * counter-clockwise from east (the frame's heading turned into S04d's convention).
 */
export const ExclusionRectSchema = z.strictObject({
  x: z.number(),
  y: z.number(),
  halfLengthM: metres,
  halfWidthM: metres,
  angleDeg: z.number().min(0).lt(360),
})

/** One landmark's placement, written by `npm run geo:build`. */
export const LandmarkFrameSchema = z.strictObject({
  id: IdSchema,
  /** The model's base: the land top (buildings) or the water plane (bridge piers). */
  base: z.enum(['land', 'water']),
  /** Local metres (x east, y north). Non-bridges: the landmark's location; bridges: mid-axis. */
  anchor: PointSchema,
  /** Where the model's front (or a bridge's second end) points, clockwise from north. */
  headingDeg: heading,
  /** Bridges: the axis ends, first in the first borough the bridge spans. */
  ends: z.tuple([PointSchema, PointSchema]).optional(),
  spanM: metres.optional(),
  exclusion: ExclusionRectSchema,
  /** Height of the model's top above its base, unscaled: where a pin sits clear of it. */
  pinLiftM: metres,
  /**
   * What the frame was derived from: the LION street, the number of straight LION line pieces used, and either the bridge's
   * principal-axis centre or the distance from the location to the fronting street.
   */
  lion: z.union([
    z.strictObject({
      street: LionStreetSchema,
      segments: z.int().positive(),
      axisCentre: PointSchema,
    }),
    z.strictObject({
      street: LionStreetSchema,
      segments: z.int().positive(),
      frontM: nonNegativeMetres,
    }),
  ]),
})
export type LandmarkFrame = z.infer<typeof LandmarkFrameSchema>

// ---- scene and theme config --------------------------------------------------------------

const perTier = <T extends z.ZodType>(value: T) =>
  z.strictObject({ low: value, mid: value, high: value })

/** Switch distances, nearest first, from 0; then the cull distance beyond the last level. */
const LodTierSchema = z
  .strictObject({ distancesM: z.array(z.number().nonnegative()).min(2).max(3), cullM: metres })
  .refine((tier) => tier.distancesM[0] === 0, { error: 'the first level starts at 0 m' })
  .refine(
    (tier) =>
      [...tier.distancesM, tier.cullM].every(
        (value, i, list) => i === 0 || value > (list[i - 1] ?? value),
      ),
    { error: 'distances and then cullM must strictly increase' },
  )

/** S04c's focus distance: a focused landmark must never be culled. */
export const LANDMARK_FOCUS_DISTANCE_M = 3000

/** data/config/scene.json `landmarks`: level-of-detail and look per quality tier. */
export const LandmarkSceneConfigSchema = z
  .strictObject({
    /** Applied to every model's heights (true heights at 1). */
    heightScale: z.number().min(0.5).max(2),
    /** Low tier starts at L1 (two levels); mid and high at L0 (three). */
    lod: z.strictObject({
      low: LodTierSchema.refine((t) => t.distancesM.length === 2, {
        error: 'low tier has two levels (L1, L2)',
      }),
      mid: LodTierSchema.refine((t) => t.distancesM.length === 3, {
        error: 'mid tier has three levels',
      }),
      high: LodTierSchema.refine((t) => t.distancesM.length === 3, {
        error: 'high tier has three levels',
      }),
    }),
    /** Bridges are long: their switch and cull distances are multiplied by this. */
    bridgeDistanceMultiplier: z.number().min(1),
    /** Fraction of a switch distance the camera must pass back before the level switches back. */
    hysteresis: z.number().min(0).lt(1),
    /** Inverted-hull outlines and lit windows, on the finest level only; never on low. */
    outline: z.strictObject({ low: z.literal(false), mid: z.boolean(), high: z.boolean() }),
    windows: z.strictObject({ low: z.literal(false), mid: z.boolean(), high: z.boolean() }),
    labelMaxDistanceM: metres,
    outlineWidthM: metres,
  })
  .refine(
    (config) => Object.values(config.lod).every((tier) => tier.cullM > LANDMARK_FOCUS_DISTANCE_M),
    { error: `cullM must exceed the ${LANDMARK_FOCUS_DISTANCE_M} m focus distance`, path: ['lod'] },
  )
export type LandmarkSceneConfig = z.infer<typeof LandmarkSceneConfigSchema>

/** Per-tier triangle caps (perf.json): unknown category keys fail. */
const trianglesPerTier = perTier(z.int().positive())
export const LandmarkTrianglesMaxSchema = z.strictObject({
  bridge: trianglesPerTier,
  building: trianglesPerTier,
  station: trianglesPerTier,
  government: trianglesPerTier,
})
/** Per-landmark overrides of the category caps, by landmark id. */
export const LandmarkTrianglesOverrideSchema = z.record(IdSchema, trianglesPerTier)

const TOKEN_NAME = /^[a-z]+-\d{2,3}$/
/** theme.json `scene.landmarks`: the palette token behind each landmark role. */
export const LandmarkPaletteRefsSchema = z.strictObject(
  Object.fromEntries(LANDMARK_ROLES.map((role) => [role, z.string().regex(TOKEN_NAME)])) as Record<
    LandmarkRole,
    z.ZodString
  >,
)
