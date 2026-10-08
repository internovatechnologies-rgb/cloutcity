/**
 * The balance numbers the engine runs on. Engine functions take an EngineConfig argument, so
 * tests can pass their own; the game passes `engineConfig`, built from data/config/balance.json
 * (validated by BalanceConfigSchema in src/lib/data/data.test.ts).
 *
 * The JSON (balance, progression (validated by createProgressionConfigSchema), the item catalog, data/events/events.json validated by EventsFileSchema,
 * and the landmark and venue lists) is read directly rather than through src/lib/data/config.ts
 * so the engine stays off classic zod and out of the shell JS budget
 * (src/lib/client-imports.test.ts).
 */
import balanceJson from '@data/config/balance.json'
import progressionJson from '@data/config/progression.json'
import eventsJson from '@data/events/events.json'
import interiorsJson from '@data/homes/interiors.json'
import itemsJson from '@data/items/items.json'
import landmarksJson from '@data/landmarks/landmarks.json'
import venuesJson from '@data/venues/venues.json'
import { STYLED_SOURCES, type StyledSourceId } from '@/lib/data/cloutSources'
import { GOAL_FACTS, PRESTIGE_PARTS, type GoalFact, type PrestigePart } from '@/lib/data/goalFacts'
import type { BalanceConfig, BoroughAccessRule, ProgressionConfig } from '@/lib/data/schemas/config'
import type { Borough, GameEvent, LocationCategory } from '@/lib/data/schemas/content'
import { DECOR_FITS, catalogFromJson, type DecorFit, type ItemDef } from './itemCatalog'

/** A housing tier: a key of `rentPerWeek`. */
export type HomeId = keyof BalanceConfig['rentPerWeek']
/** A job: a key of `jobs.hourlyWage`. */
export type JobId = keyof BalanceConfig['jobs']['hourlyWage']

/** A decor slot as the engine sees it (data/homes/interiors.json; the rest is for the scene). */
export interface SlotDef {
  readonly id: string
  readonly kind: DecorFit
}

/** A goal (data/config/progression.json, src/engine/goals.ts). */
export type GoalDef = ProgressionConfig['goals'][number]

export interface EngineConfig {
  readonly time: BalanceConfig['time']
  readonly stats: BalanceConfig['stats']
  readonly actions: BalanceConfig['actions']
  readonly jobs: BalanceConfig['jobs']
  /** Whole dollars per rent week, by home. */
  readonly rentPerWeek: BalanceConfig['rentPerWeek']
  readonly rent: BalanceConfig['rent']
  /** Move-in costs (src/engine/housing.ts). */
  readonly housing: BalanceConfig['housing']
  /**
   * Home scores, the home clout cap and the move log's length (src/engine/home.ts), plus each
   * home's decor slots, in data/homes/interiors.json order.
   */
  readonly home: BalanceConfig['home'] & {
    readonly slots: Readonly<Record<HomeId, readonly SlotDef[]>>
  }
  /** Food range and the subway fare, in whole dollars. */
  readonly costs: BalanceConfig['costs']
  /** Levels, flex, style, the ledger and the premium cap (src/engine/clout.ts). */
  readonly clout: BalanceConfig['clout']
  /** Shop, resale and gift-stack rules, plus the cash item catalog (data/items/items.json). */
  readonly items: BalanceConfig['items'] & { readonly catalog: readonly ItemDef[] }
  /** Who may enter each borough (open, a clout level, or expanding soon). */
  readonly boroughs: BalanceConfig['boroughs']
  /** Whole in-game dollars a new player starts with. */
  readonly startCash: number
  /** The home a new player starts in. */
  readonly startHome: HomeId
  /** Place actions, club doors, landmark visits and flex multipliers (src/engine/placeActions.ts). */
  readonly place: BalanceConfig['place']
  /** Event tuning plus the event catalog (data/events, validated by EventsFileSchema). */
  readonly events: BalanceConfig['events'] & { readonly catalog: readonly GameEvent[] }
  /**
   * The category of every known place (landmark category or venue type), by id. The engine
   * judges place rules (memorials, government buildings) on this, never on what a caller says.
   */
  readonly places: ReadonlyMap<string, LocationCategory>
  /** Goals and their rewards (src/engine/goals.ts), in display order. */
  readonly goals: readonly GoalDef[]
  /** How grants are capped and how many records the save keeps (src/engine/grants.ts). */
  readonly grants: ProgressionConfig['grants']
  /** What prestige requires, earns, resets and keeps (src/engine/prestige.ts). */
  readonly prestige: ProgressionConfig['prestige']
}

/**
 * Built from whatever landmarks and venues the data holds (validated by LandmarksFileSchema and
 * VenuesFileSchema in data.test.ts), so new or renamed places need no code change.
 */
export function placeCategories(
  landmarks: readonly { readonly id: string; readonly category: string }[],
  venues: readonly { readonly id: string; readonly type: string }[],
): ReadonlyMap<string, LocationCategory> {
  return new Map<string, LocationCategory>([
    ...landmarks.map((place) => [place.id, place.category as LocationCategory] as const),
    ...venues.map((place) => [place.id, place.type as LocationCategory] as const),
  ])
}

export function isHomeId(id: unknown, config: EngineConfig): id is HomeId {
  return typeof id === 'string' && Object.hasOwn(config.rentPerWeek, id)
}

const rentPerWeek: BalanceConfig['rentPerWeek'] = balanceJson.rentPerWeek

function startHome(id: string): HomeId {
  if (!Object.hasOwn(rentPerWeek, id)) {
    throw new Error(`config/balance.json: start.home "${id}" is not a key of rentPerWeek`)
  }
  return id as HomeId
}

/**
 * JSON imports widen `access` to string, so the rules are narrowed here. A bad rule throws at
 * load (fail fast); BalanceConfigSchema checks the same file in data.test.ts.
 */
function boroughRules(json: Readonly<Record<Borough, { access: string; level?: string }>>) {
  const rule = (id: Borough): BoroughAccessRule => {
    const entry = json[id]
    if (entry.access === 'open' || entry.access === 'expanding-soon')
      return { access: entry.access }
    if (entry.access === 'clout' && entry.level !== undefined) {
      return { access: 'clout', level: entry.level }
    }
    throw new Error(`config/balance.json: boroughs.${id} has an invalid access rule`)
  }
  return {
    queens: rule('queens'),
    brooklyn: rule('brooklyn'),
    manhattan: rule('manhattan'),
    bronx: rule('bronx'),
    'staten-island': rule('staten-island'),
  } satisfies BalanceConfig['boroughs']
}

/**
 * JSON imports widen `style.appliesTo` to string[], so it is narrowed here; a source the
 * style may not multiply throws at load (fail fast). CloutConfigSchema checks the same file.
 */
function cloutRules(json: typeof balanceJson.clout): BalanceConfig['clout'] {
  const isStyled = (id: string): id is StyledSourceId =>
    (STYLED_SOURCES as readonly string[]).includes(id)
  const appliesTo = json.style.appliesTo.map((id) => {
    if (!isStyled(id)) throw new Error(`config/balance.json: clout.style.appliesTo has "${id}"`)
    return id
  })
  return { ...json, style: { ...json.style, appliesTo } }
}

/**
 * JSON imports widen string unions (`fact`, prestige parts) and literals (`victory`, `badge`), so
 * the progression rules are narrowed here; anything else throws at load (fail fast).
 * createProgressionConfigSchema checks the same file in data.test.ts.
 */
function progressionRules(json: typeof progressionJson) {
  const where = 'config/progression.json'
  const fact = (id: string, value: string): GoalFact => {
    if (!(GOAL_FACTS as readonly string[]).includes(value)) {
      throw new Error(`${where}: goal "${id}" has an unknown fact "${value}"`)
    }
    return value as GoalFact
  }
  const parts = (list: readonly string[]): PrestigePart[] =>
    list.map((part) => {
      if (!(PRESTIGE_PARTS as readonly string[]).includes(part)) {
        throw new Error(`${where}: unknown prestige part "${part}"`)
      }
      return part as PrestigePart
    })
  const goals: GoalDef[] = json.goals.map((raw) => {
    const entry = raw as {
      id: string
      fact: string
      level?: string
      available?: boolean
      victory?: boolean
      reward: { cash?: number; clout?: number; badge?: boolean }
    }
    const { cash, clout, badge } = entry.reward
    if (entry.victory === false || badge === false) {
      throw new Error(`${where}: goal "${entry.id}" sets victory or badge to false`)
    }
    return {
      id: entry.id,
      fact: fact(entry.id, entry.fact),
      ...(entry.level === undefined ? {} : { level: entry.level }),
      ...(entry.available === undefined ? {} : { available: entry.available }),
      ...(entry.victory === true ? { victory: true as const } : {}),
      reward: {
        ...(cash === undefined ? {} : { cash }),
        ...(clout === undefined ? {} : { clout }),
        ...(badge === true ? { badge: true as const } : {}),
      },
    }
  })
  return {
    goals,
    grants: json.grants,
    prestige: {
      ...json.prestige,
      resets: parts(json.prestige.resets),
      keeps: parts(json.prestige.keeps),
    },
  }
}

const progression = progressionRules(progressionJson)

/**
 * Each home's decor slots from data/homes/interiors.json (validated by HomeInteriorsFileSchema in
 * data.test.ts). JSON imports widen `kind` to string, so it is narrowed here; anything else
 * throws at load (fail fast).
 */
function homeSlots(json: typeof interiorsJson): Readonly<Record<HomeId, readonly SlotDef[]>> {
  const slots = (id: HomeId): SlotDef[] =>
    json.homes[id].slots.map((slot) => {
      if (!(DECOR_FITS as readonly string[]).includes(slot.kind)) {
        throw new Error(`homes/interiors.json: ${id} slot "${slot.id}" has an unknown kind`)
      }
      return { id: slot.id, kind: slot.kind as DecorFit }
    })
  return {
    'queens-room': slots('queens-room'),
    'brooklyn-1br': slots('brooklyn-1br'),
    'manhattan-loft': slots('manhattan-loft'),
  }
}

/**
 * balance.json `transit` plus the subway fare, for src/engine/transit/config.ts. Built here so
 * the balance file has one importer in the client graph: the bundler then keeps one copy of it
 * instead of copying the JSON into the lazy travel chunk and the boot islands (PERF-3).
 */
export const transitBalance = {
  ...balanceJson.transit,
  subwayFare: balanceJson.costs.subwayFare,
}

export const engineConfig: EngineConfig = {
  time: balanceJson.time,
  stats: balanceJson.stats,
  actions: balanceJson.actions,
  jobs: balanceJson.jobs,
  rentPerWeek,
  rent: balanceJson.rent,
  housing: balanceJson.housing,
  home: { ...balanceJson.home, slots: homeSlots(interiorsJson) },
  costs: balanceJson.costs,
  clout: cloutRules(balanceJson.clout),
  items: { ...balanceJson.items, catalog: catalogFromJson(itemsJson.items) },
  boroughs: boroughRules(balanceJson.boroughs),
  startCash: balanceJson.start.cash,
  startHome: startHome(balanceJson.start.home),
  // JSON imports widen string unions to `string`; data.test.ts validates the file itself.
  events: { ...balanceJson.events, catalog: eventsJson.events as readonly GameEvent[] },
  places: placeCategories(landmarksJson.landmarks, venuesJson.venues),
  place: balanceJson.place,
  goals: progression.goals,
  grants: progression.grants,
  prestige: progression.prestige,
}
