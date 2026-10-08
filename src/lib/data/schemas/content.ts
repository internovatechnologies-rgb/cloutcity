/**
 * Schemas for game content: /data/items, premium, events, jobs, venues, landmarks.
 *
 * Content never carries player-facing text. It names copy keys (`nameKey`, `titleKey`, ...)
 * that resolve through the copy layer, so every string goes through the slang pack and the
 * superlative check. Cross-file references (copy keys, balance ids) are checked in
 * src/lib/data/data.test.ts.
 */
import { z } from 'zod'
import { HOME_IDS, JOB_IDS, PaletteTokenRefSchema, RarityTierSchema } from './config'

export const IdSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'kebab-case id')
export const CopyKeyRefSchema = z.string().regex(/^[a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)+$/)

export const BOROUGHS = ['queens', 'brooklyn', 'manhattan', 'bronx', 'staten-island'] as const
export const BoroughSchema = z.enum(BOROUGHS)
export type Borough = z.infer<typeof BoroughSchema>

/** WGS84 point. Bounds against data/geo/bounds.json are checked in data.test.ts. */
export const LatLngSchema = z.strictObject({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
})

/** Rejects a list whose entries share an id. */
function uniqueIds<T extends { id: string }>(list: readonly T[], ctx: z.RefinementCtx) {
  const seen = new Set<string>()
  list.forEach((entry, index) => {
    if (seen.has(entry.id)) {
      ctx.addIssue({ code: 'custom', message: `duplicate id "${entry.id}"`, path: [index, 'id'] })
    }
    seen.add(entry.id)
  })
}

/** An array of entries with unique ids. */
export function listOf<T extends z.ZodType<{ id: string }>>(entry: T) {
  return z.array(entry).superRefine(uniqueIds)
}

const dollars = z.int().nonnegative()

export const STATS = ['energy', 'hunger', 'mood'] as const
export const StatSchema = z.enum(STATS)

/** Outfit slots. Clothing fills the first four; makeup fills `face` (src/engine/items.ts mirrors this). */
export const ITEM_SLOTS = ['top', 'bottom', 'shoes', 'accessory', 'face'] as const
export const ItemSlotSchema = z.enum(ITEM_SLOTS)
export type ItemSlot = z.infer<typeof ItemSlotSchema>

/** Which slots each wearable category may fill. Other categories have no slot. */
const CATEGORY_SLOTS: Readonly<Record<string, readonly ItemSlot[]>> = {
  clothing: ['top', 'bottom', 'shoes', 'accessory'],
  makeup: ['face'],
}

/** Where a decor item goes in an apartment: a wall, the floor, or a surface (a sill, a shelf). */
export const DECOR_FITS = ['wall', 'floor', 'surface'] as const
export const DecorFitSchema = z.enum(DECOR_FITS)
export type DecorFit = z.infer<typeof DecorFitSchema>

/**
 * A decor item's colour variant (S16): a palette token (never a hex value; theme.json must hold
 * it) and a human colour name in the shared `colors` copy namespace (A11Y-1).
 */
export const DecorVariantSchema = z.strictObject({
  id: IdSchema,
  token: PaletteTokenRefSchema,
  nameKey: CopyKeyRefSchema.refine((key) => key.startsWith('colors.'), {
    error: 'a colour name lives in the colors copy namespace',
  }),
})

/**
 * What a decor item adds to an apartment (S16): the slot kind it fits, the home score it adds
 * while placed (src/engine/home.ts), and at least two colour variants.
 */
export const DecorSchema = z.strictObject({
  fits: DecorFitSchema,
  homeScore: z.int().min(1),
  variants: listOf(DecorVariantSchema).min(2),
})

/**
 * An in-game cash item (CLAUDE.md "Two kinds of purchases"). `sellValue` is what the item sells
 * back for on the day it is bought; worn items lose more value per game day owned
 * (balance.json `items`, applied in src/engine/items.ts). It is always below `price`, so a
 * buy/sell loop can only lose cash.
 */
export const ItemSchema = z
  .strictObject({
    id: IdSchema,
    nameKey: CopyKeyRefSchema,
    descriptionKey: CopyKeyRefSchema,
    category: z.enum(['clothing', 'makeup', 'gift', 'decor', 'upgrade']),
    /** Wearables only: the outfit slot the item fills. */
    slot: ItemSlotSchema.optional(),
    rarity: RarityTierSchema,
    currency: z.literal('cash'),
    /** In-game cash, whole dollars. */
    price: z.int().positive(),
    sellValue: dollars,
    cloutValue: z.int().nonnegative(),
    /** Style points while worn (S13): the outfit's score multiplies clout gains. Gifts: 0. */
    styleValue: z.int().nonnegative(),
    statEffects: z.partialRecord(StatSchema, z.int()),
    /** Decor only (S16): the slot kind, home score and colour variants. */
    decor: DecorSchema.optional(),
  })
  .refine((item) => item.category !== 'gift' || item.styleValue === 0, {
    error: 'a gift is never worn, so its styleValue must be 0',
    path: ['styleValue'],
  })
  .refine((item) => item.sellValue < item.price, {
    error: 'sellValue must be below price',
    path: ['sellValue'],
  })
  .refine(
    (item) => {
      const slots = CATEGORY_SLOTS[item.category]
      return slots === undefined
        ? item.slot === undefined
        : item.slot !== undefined && slots.includes(item.slot)
    },
    {
      error: 'clothing needs a clothing slot, makeup the face slot, others no slot',
      path: ['slot'],
    },
  )
  .refine((item) => (item.category === 'decor') === (item.decor !== undefined), {
    error: 'decor needs a decor block, and only decor has one',
    path: ['decor'],
  })
  .refine(
    (item) =>
      item.category !== 'decor' ||
      (item.cloutValue === 0 &&
        item.styleValue === 0 &&
        Object.keys(item.statEffects).length === 0),
    {
      // Decor adds clout only through the home score (src/engine/home.ts), never as item clout,
      // style or a stat effect.
      error: 'decor has cloutValue 0, styleValue 0 and no stat effects',
      path: ['category'],
    },
  )
export const ItemsFileSchema = z.strictObject({ items: listOf(ItemSchema) })
export type Item = z.infer<typeof ItemSchema>

/**
 * Real-money items. Strict on purpose: a `sellValue` or in-game `price` is a schema error,
 * because premium items can never be bought or sold for in-game cash.
 */
export const PremiumItemSchema = z.strictObject({
  id: IdSchema,
  nameKey: CopyKeyRefSchema,
  kind: z.enum(['outfit', 'apartment-theme', 'badge', 'share-frame']),
  rarity: RarityTierSchema,
  currency: z.literal('usd'),
  /** A key of balance.premiumPriceTiersUsd. */
  priceTier: z.string().regex(/^tier-\d+$/),
  cloutValue: z.int().nonnegative(),
  styleValue: z.int().nonnegative(),
})
export const PremiumFileSchema = z.strictObject({ items: listOf(PremiumItemSchema) })
export type PremiumItem = z.infer<typeof PremiumItemSchema>

/** Wages and shift length live in data/config/balance.json, keyed by job id. */
export const JobSchema = z.strictObject({
  id: z.enum(JOB_IDS),
  nameKey: CopyKeyRefSchema,
})
export const JobsFileSchema = z.strictObject({ jobs: listOf(JobSchema) })
export type Job = z.infer<typeof JobSchema>

export const VENUE_TYPES = [
  'bodega',
  'food-spot',
  'subway-station',
  'park',
  'gym',
  'coffee-shop',
  'boutique',
  'thrift',
  'club',
  'job-site',
] as const

const CLOCK_TIME = /^([01]\d|2[0-3]):[0-5]\d$/

/**
 * Opening hours on the personal game clock: `24h`, or an open and a close time. A close
 * earlier than the open runs past midnight (a club open 22:00 to 04:00).
 */
export const HoursSchema = z.union([
  z.literal('24h'),
  z
    .strictObject({ open: z.string().regex(CLOCK_TIME), close: z.string().regex(CLOCK_TIME) })
    .refine((hours) => hours.open !== hours.close, {
      error: 'open and close must differ (use "24h" for always open)',
    }),
])
export type Hours = z.infer<typeof HoursSchema>

/**
 * Fields every place shares (venues and landmarks are one id space). `borough` and `zoneId`
 * are written by hand and checked against the S04 geo layers in
 * src/lib/world/places-content.test.ts, which prints the expected value on a mismatch.
 */
const placeBase = {
  id: IdSchema,
  nameKey: CopyKeyRefSchema,
  borough: BoroughSchema,
  zoneId: IdSchema,
  location: LatLngSchema,
}

/**
 * Where each home sits (S05): the player's start point and avatar position for that home.
 * `borough` and `zoneId` are checked against the S04 geo layers in
 * src/lib/world/homes-content.test.ts. Keyed by every home id, so none can be missing.
 */
export const HomeSchema = z.strictObject({
  borough: BoroughSchema,
  zoneId: IdSchema,
  location: LatLngSchema,
})
export const HomesFileSchema = z.strictObject({ homes: z.record(z.enum(HOME_IDS), HomeSchema) })
export type HomesFile = z.infer<typeof HomesFileSchema>

/** A point in an apartment, in metres: x right, y up, z toward the camera; 0,0,0 is the floor's centre. */
const RoomPointSchema = z.tuple([z.number(), z.number(), z.number()])
const metres = z.number().positive()
/** A wall of the room: the camera looks in through the open front. */
const RoomWallSchema = z.enum(['back', 'left', 'right'])

/** An opening in a wall; `centerM` runs along the wall from its middle. */
const OpeningSchema = z.strictObject({
  wall: RoomWallSchema,
  centerM: z.number(),
  widthM: metres,
  heightM: metres,
  /** Height of the bottom edge above the floor (0 for a door). */
  sillM: z.number().nonnegative(),
})

/** A decor slot: where one decor item of its kind can be placed (src/engine/home.ts). */
export const DecorSlotSchema = z.strictObject({
  id: z.string().regex(/^(?:wall|floor|surface)-\d+$/, 'slot ids are <kind>-<n>'),
  kind: DecorFitSchema,
  position: RoomPointSchema,
  /** Turn about the vertical axis, degrees. */
  rotationDeg: z.number().min(-180).max(180),
  nameKey: CopyKeyRefSchema,
})
export type DecorSlot = z.infer<typeof DecorSlotSchema>

const EPSILON_M = 1e-6

/** Whether `slot` sits where its kind says: on a wall, on the floor, or on a raised surface. */
function slotFitsRoom(
  slot: DecorSlot,
  room: { readonly widthM: number; readonly depthM: number; readonly heightM: number },
) {
  const [x, y, z] = slot.position
  const halfW = room.widthM / 2
  const halfD = room.depthM / 2
  const inside = Math.abs(x) <= halfW && z >= -halfD && z <= halfD && y >= 0 && y < room.heightM
  if (!inside) return false
  const onWall = Math.abs(Math.abs(x) - halfW) < EPSILON_M || Math.abs(z + halfD) < EPSILON_M
  switch (slot.kind) {
    case 'wall':
      return onWall && y > 0
    case 'floor':
      return y === 0 && !onWall
    case 'surface':
      return y > 0 && !onWall
  }
}

/** Whether an opening fits inside its wall. */
function openingFits(
  opening: z.infer<typeof OpeningSchema>,
  room: { readonly widthM: number; readonly depthM: number; readonly heightM: number },
) {
  const length = opening.wall === 'back' ? room.widthM : room.depthM
  return (
    Math.abs(opening.centerM) + opening.widthM / 2 <= length / 2 &&
    opening.sillM + opening.heightM <= room.heightM
  )
}

/**
 * One home's interior (S16): the room, its window and door, the camera pose, where the avatar
 * stands, and its decor slots. Slot ids are shared between homes (`wall-1` is the main wall in
 * every home), so moving keeps what fits (src/engine/home.ts `placementsAfterMove`).
 */
export const HomeInteriorSchema = z
  .strictObject({
    room: z.strictObject({ widthM: metres, depthM: metres, heightM: metres }),
    window: OpeningSchema,
    door: OpeningSchema.refine((door) => door.sillM === 0, { error: 'a door starts at the floor' }),
    /**
     * The camera looks from `position` towards `target` through the open front. The scene keeps
     * that direction and target and moves along it until the room fits the free scene row
     * (src/scene/apartment/fit.ts), so `position` sets the angle, not the distance.
     */
    camera: z.strictObject({
      position: RoomPointSchema,
      target: RoomPointSchema,
      fovDeg: z.number().gt(0).lt(180),
    }),
    avatarAnchor: z.strictObject({
      position: RoomPointSchema,
      rotationDeg: z.number().min(-180).max(180),
    }),
    slots: listOf(DecorSlotSchema).min(1),
  })
  .refine((home) => home.slots.every((slot) => slot.id.startsWith(`${slot.kind}-`)), {
    error: "a slot's id starts with its kind",
    path: ['slots'],
  })
  .refine((home) => home.slots.every((slot) => slotFitsRoom(slot, home.room)), {
    error: 'a slot sits outside the room or off the wall, floor or surface its kind needs',
    path: ['slots'],
  })
  .refine((home) => openingFits(home.window, home.room) && openingFits(home.door, home.room), {
    error: 'the window or door does not fit its wall',
    path: ['window'],
  })
export type HomeInterior = z.infer<typeof HomeInteriorSchema>

/** data/homes/interiors.json: every home's interior, keyed by home id (none can be missing). */
export const HomeInteriorsFileSchema = z.strictObject({
  homes: z.strictObject(
    Object.fromEntries(HOME_IDS.map((id) => [id, HomeInteriorSchema])) as Record<
      (typeof HOME_IDS)[number],
      typeof HomeInteriorSchema
    >,
  ),
})
export type HomeInteriorsFile = z.infer<typeof HomeInteriorsFileSchema>

/** Station venues are deliberately unbranded and point at an S04 subway station. */
const StationVenueSchema = z.strictObject({
  ...placeBase,
  blurbKey: CopyKeyRefSchema,
  type: z.literal('subway-station'),
  hours: HoursSchema,
  stationId: IdSchema,
})

const BusinessVenueSchema = z.strictObject({
  ...placeBase,
  blurbKey: CopyKeyRefSchema,
  type: z.enum(VENUE_TYPES).exclude(['subway-station']),
  hours: HoursSchema,
  /** Jobs worked here (data only until a task wires shifts to venues). */
  jobIds: z.array(z.enum(JOB_IDS)).min(1).optional(),
})

/** Invented businesses with original names, at plausible real coordinates. No prices here. */
export const VenueSchema = z.discriminatedUnion('type', [StationVenueSchema, BusinessVenueSchema])
export const VenuesFileSchema = z.strictObject({ venues: listOf(VenueSchema) })
export type Venue = z.infer<typeof VenueSchema>

export const LANDMARK_CATEGORIES = [
  'bridge',
  'building',
  'monument',
  'park',
  'stadium',
  'government',
  'station',
  'neighborhood',
  'memorial',
] as const

/** What a player can do at a non-memorial landmark. */
export const LANDMARK_INTERACTIONS = ['visit', 'flex', 'emote', 'events'] as const

const landmarkBase = {
  ...placeBase,
  infoKey: CopyKeyRefSchema,
  /** `generic` for trademarked or corporate-branded names. */
  nameMode: z.enum(['real', 'generic']),
  /** Stays false until a human checks the name and depiction. */
  legalReviewed: z.boolean(),
  /**
   * Where the player stands and routes to when `location` is not reachable land (a bridge
   * midspan, an island). `borough` and `zoneId` describe this point when it is set.
   */
  approach: LatLngSchema.optional(),
  /** Boroughs a bridge connects. */
  spans: z.array(BoroughSchema).min(2).optional(),
}

const InteractionsSchema = z
  .array(z.enum(LANDMARK_INTERACTIONS))
  .min(1)
  .refine((list) => new Set(list).size === list.length, { error: 'interactions repeat' })

const PlainLandmarkSchema = z.strictObject({
  ...landmarkBase,
  category: z.enum(LANDMARK_CATEGORIES).exclude(['memorial']),
  interactions: InteractionsSchema,
})

/**
 * Memorials are respectful, look-only stops (CLAUDE.md "Map and landmarks"). Strict, so any
 * interaction, flex, clout, emote or event field is a schema error.
 */
const MemorialLandmarkSchema = z.strictObject({
  ...landmarkBase,
  category: z.literal('memorial'),
  lookOnly: z.literal(true),
})

export const LandmarkSchema = z.discriminatedUnion('category', [
  PlainLandmarkSchema,
  MemorialLandmarkSchema,
])
export const LandmarksFileSchema = z.strictObject({ landmarks: listOf(LandmarkSchema) })
export type Landmark = z.infer<typeof LandmarkSchema>

/**
 * Events (S14): data-driven moments with conditions, a weight and two or three choices.
 * The engine (src/engine/events.ts) picks among the eligible ones with a seeded random source.
 *
 * Safety rules (CLAUDE.md "Map and landmarks", "Safety rules") are enforced twice: here, so no
 * event can even name a memorial or put a crime event at a government building, and again in
 * the engine, which refuses every event at a memorial and every crime event at a government
 * building whatever the data says.
 */
export const EVENT_TAGS = [
  'transit',
  'money',
  'food',
  'nightlife',
  'social',
  'landmark',
  'weather',
  'home',
  'crime',
] as const
export const EventTagSchema = z.enum(EVENT_TAGS)
export type EventTag = z.infer<typeof EventTagSchema>

/** Where an event may happen: a landmark category or a venue type. Memorials are never valid. */
export const EventLocationCategorySchema = z.union([
  z.enum(LANDMARK_CATEGORIES).exclude(['memorial']),
  z.enum(VENUE_TYPES),
])
/** Every place category the engine can be told the player is at, memorials included. */
export type LocationCategory = Landmark['category'] | Venue['type']

const statPoints = z.int().nonnegative()

/** An inclusive range; at least one bound, and min <= max. */
function rangeOf(value: z.ZodInt) {
  return z
    .strictObject({ min: value.optional(), max: value.optional() })
    .refine((range) => range.min !== undefined || range.max !== undefined, {
      error: 'a range needs min or max',
    })
    .refine(
      (range) => range.min === undefined || range.max === undefined || range.min <= range.max,
      { error: 'min must not exceed max' },
    )
}

/**
 * All present conditions must hold. Within a list, any entry matches. `locationIds` and
 * `locationCategories` together describe one "where": the player must be at a listed place
 * or at a place of a listed category.
 */
export const EventConditionsSchema = z.strictObject({
  /** Personal-clock hour window [from, to); wraps past midnight when from > to. */
  hours: z
    .strictObject({ from: z.int().min(0).max(23), to: z.int().min(0).max(23) })
    .refine((window) => window.from !== window.to, {
      error: 'an empty window: omit hours for all day',
    })
    .optional(),
  /** Earliest game day (1-based) the event can fire. */
  minDay: z.int().positive().optional(),
  boroughs: z.array(BoroughSchema).min(1).optional(),
  /** Landmark or venue ids. */
  locationIds: z.array(IdSchema).min(1).optional(),
  locationCategories: z.array(EventLocationCategorySchema).min(1).optional(),
  stats: z.partialRecord(StatSchema, rangeOf(statPoints)).optional(),
  /** Whole dollars on hand. */
  cash: rangeOf(z.int().nonnegative()).optional(),
  /** Clout points (S13). */
  clout: rangeOf(z.int().nonnegative()).optional(),
  /** Item ids (S10): owns at least one of `anyOf`, none of `noneOf`. */
  items: z
    .strictObject({
      anyOf: z.array(IdSchema).min(1).optional(),
      noneOf: z.array(IdSchema).min(1).optional(),
    })
    .optional(),
})
export type EventConditions = z.infer<typeof EventConditionsSchema>

const nonZero = z.int().refine((amount) => amount !== 0, { error: 'amount must not be 0' })

/**
 * What a choice does. Cash, stats and time apply now through the engine. Clout (S13) and items
 * (S10) are recorded as typed pending effects in the save until those systems consume them.
 * There is deliberately no effect that involves drinking.
 */
export const EventEffectSchema = z.discriminatedUnion('kind', [
  /** Whole dollars; negative is a cost the player must be able to pay. */
  z.strictObject({ kind: z.literal('cash'), amount: nonZero }),
  z.strictObject({ kind: z.literal('stat'), stat: StatSchema, amount: nonZero }),
  /** Game minutes the personal clock fast-forwards. */
  z.strictObject({ kind: z.literal('time'), minutes: z.int().positive() }),
  z.strictObject({ kind: z.literal('clout'), amount: nonZero }),
  z.strictObject({ kind: z.literal('item'), itemId: IdSchema, op: z.enum(['grant', 'consume']) }),
])
export type EventEffect = z.infer<typeof EventEffectSchema>

export const EventChoiceSchema = z.strictObject({
  id: IdSchema,
  /** Button text: plain and clear. */
  labelKey: CopyKeyRefSchema,
  /** What happened, shown after the choice. */
  resultKey: CopyKeyRefSchema,
  effects: z.array(EventEffectSchema),
})
export type EventChoice = z.infer<typeof EventChoiceSchema>

/** Net whole dollars a choice takes (0 when free). Mirrors `choiceCashCost` in src/engine/events.ts. */
function choiceCashCost(choice: Pick<EventChoice, 'effects'>): number {
  const net = choice.effects.reduce(
    (sum, effect) => (effect.kind === 'cash' ? sum + effect.amount : sum),
    0,
  )
  return Math.max(0, -net)
}

export const EventSchema = z
  .strictObject({
    id: IdSchema,
    titleKey: CopyKeyRefSchema,
    bodyKey: CopyKeyRefSchema,
    tags: z.array(EventTagSchema).min(1),
    /** Relative chance among the events eligible at the same moment. */
    weight: z.int().positive(),
    /** Game minutes before it can fire again; defaults to balance `events.defaultCooldownMin`. */
    cooldownMin: z.int().nonnegative().optional(),
    /** Fires at most once per save. */
    once: z.boolean().optional(),
    conditions: EventConditionsSchema,
    choices: listOf(EventChoiceSchema).min(2).max(3),
  })
  .refine((event) => event.choices.some((choice) => choiceCashCost(choice) === 0), {
    error: 'every event needs a choice that costs no cash, so a broke player is never stuck',
    path: ['choices'],
  })
  .refine(
    (event) =>
      !event.tags.includes('crime') ||
      !(event.conditions.locationCategories ?? []).includes('government'),
    {
      error: 'no crime events at government buildings',
      path: ['conditions', 'locationCategories'],
    },
  )
export const EventsFileSchema = z.strictObject({ events: listOf(EventSchema) })
export type GameEvent = z.infer<typeof EventSchema>
