/**
 * The versioned save format: what the store persists (src/state/store.ts) and, later, what
 * syncs to the server. Saves are untrusted and validated on every load.
 *
 * Bump SAVE_VERSION on any breaking change to the schema and add the step from the previous
 * version to `migrateSave`, with a test.
 *
 * History:
 * - v1 (S02): `{ player: { cash } }`.
 * - v2 (S03): adds the personal clock, stats and the clock speed.
 * - v3 (S11): adds `player.clout`, `player.home` and `player.rent` (owed, missed).
 * - v4 (S10): adds `player.inventory` (owned wearables, gift stacks, outfit).
 * - v5 (S14): adds `events` (open event, cooldown history, pending clout/item effects, random
 *   generator state).
 * - v6 (S09): adds `player.clubNights` (the night each club last paid out clout).
 * - v7 (S13): `player.clout` becomes the clout ledger (src/engine/clout.ts) and `player.flex`
 *   is added; event clout no longer waits in `events.pending` (it lands at once).
 * - v8 (S15): adds `player.visited` (first visit per landmark), `goals` (run, goals reached,
 *   the Icon moment), `grants` (the grant log) and `prestige` (count, badges, history), and
 *   `prestigeKept` on wearables kept through prestige. An older save's goals are derived from
 *   what it holds at load (`syncGoals`).
 * - v9 (S16): adds `player.inventory.decor` (owned decor, its colour variant, `prestigeKept`)
 *   and `player.apartment` (decor placed in the current home's slots, and the move log). An
 *   older save starts with no decor, nothing placed and an empty move log.
 * - v10 (S08): adds `player.location` (at home, or at a place by id) and `player.transit` (the
 *   delay roll's generator state). An older save starts at home with a fresh generator.
 * - v11 (S18c): adds `actions`, the taps that changed the game this run (DEC-19): the server's
 *   save plausibility bounds how far the clock and the earnings can move per tap. An older save
 *   starts counting at 0.
 */
import * as z from 'zod/mini'
import { CLOUT_SOURCES, type CloutSourceId } from '@/lib/data/cloutSources'
import { calendar, isSpeed, realMsPerGameMinute } from './clock'
import {
  appendClout,
  cloutSums,
  currencyOf,
  earnedOnlyLevel,
  goalClout,
  initialCloutState,
  legacyCloutState,
  playerLevel,
  type CloutEntry,
  type CloutPlayer,
  type CloutState,
} from './clout'
import { isHomeId, type EngineConfig, type HomeId } from './config'
import { initialEventsState, type EventsState, type PendingEffect } from './events'
import {
  initialFlexState,
  initialSnapshot,
  HOME_LOCATION,
  initialTransitState,
  type ClubNights,
  type FlexState,
  type GameSnapshot,
  type PlayerLocation,
  type TransitState,
  type Visited,
} from './game'
import { initialGoalsState, syncGoals, victoryGoal, type GoalsState } from './goals'
import {
  initialApartment,
  slotsFor,
  type ApartmentState,
  type MoveRecord,
  type Placements,
} from './home'
import {
  goalGrantKey,
  initialGrantsState,
  parseGoalGrantKey,
  type GrantRecord,
  type GrantsState,
} from './grants'
import {
  ITEM_SLOTS,
  emptyInventory,
  findItem,
  isDecor,
  isGift,
  isWearable,
  type DecorDef,
  type GiftStack,
  type Inventory,
  type OwnedDecor,
  type OwnedWearable,
} from './items'
import { initialPrestigeState, type PrestigeRun, type PrestigeState } from './prestige'
import { initialRent } from './rent'

export const SAVE_VERSION = 11

export interface SaveState extends GameSnapshot {
  /** Passive clock speed, one of `time.speeds`. */
  readonly speed: number
  readonly events: EventsState
  /** Goals reached this run and the Icon moment (src/engine/goals.ts). */
  readonly goals: GoalsState
  /** The grant log (src/engine/grants.ts). */
  readonly grants: GrantsState
  /** Prestige runs and badges (src/engine/prestige.ts). */
  readonly prestige: PrestigeState
  /**
   * Taps that changed the game this run (an action, shift, buy, sale, event choice or claim;
   * `countAction`). Starts at 0 and again at each prestige. Only ever counts up within a run.
   */
  readonly actions: number
}

/** The save after one more counted tap (see `SaveState.actions`). */
export function countAction<S extends Pick<SaveState, 'actions'>>(save: S): S {
  return { ...save, actions: save.actions + 1 }
}

const CashSchema = z.int().check(z.gte(0))
/** A v3 to v6 save's clout: one whole number. */
const LegacyCloutSchema = z.int().check(z.gte(0))
const WholeSchema = z.int().check(z.gte(0))
const Uint32Schema = z.int().check(z.gte(0), z.lte(0xffffffff))

const EffectSourceSchema = z.strictObject({
  type: z.literal('event'),
  eventId: z.string(),
  choiceId: z.string(),
})

const ItemPendingEffectSchema = z.strictObject({
  kind: z.literal('item'),
  itemId: z.string(),
  op: z.enum(['grant', 'consume']),
  source: EffectSourceSchema,
})

/** v5 and v6 kept event clout pending too; v7 applies it at once. */
const PendingEffectV6Schema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('clout'), amount: z.int(), source: EffectSourceSchema }),
  ItemPendingEffectSchema,
])

const CLOUT_REF_SCHEMAS = {
  paycheck: z.strictObject({ jobId: z.string() }),
  flex: z.strictObject({
    placeId: z.string(),
    viral: z.boolean(),
    placeMultiplier: z.number().check(z.gt(0)),
    styleScore: WholeSchema,
    base: z.int().check(z.gte(1)),
  }),
  club: z.strictObject({ venueId: z.string(), night: WholeSchema }),
  event: z.strictObject({ eventId: z.string(), choiceId: z.string() }),
  grant: z.strictObject({ grantKey: z.string() }),
  legacy: z.strictObject({}),
  repair: z.strictObject({}),
  item: z.strictObject({ itemId: z.string(), op: z.enum(['buy', 'sell', 'grant', 'consume']) }),
  premium: z.strictObject({ itemId: z.string(), op: z.enum(['grant', 'revoke']) }),
} as const satisfies Record<CloutSourceId, z.ZodMiniType>

function cloutEntrySchema<S extends CloutSourceId>(source: S) {
  return z.strictObject({
    seq: z.int().check(z.gte(1)),
    at: WholeSchema,
    amount: z.int(),
    currency: z.literal(currencyOf(source)),
    source: z.literal(source),
    ref: CLOUT_REF_SCHEMAS[source],
  })
}

/** One clout ledger entry; the currency must be the one its source uses. */
const CloutEntrySchema = z.discriminatedUnion('source', [
  cloutEntrySchema('paycheck'),
  cloutEntrySchema('flex'),
  cloutEntrySchema('club'),
  cloutEntrySchema('event'),
  cloutEntrySchema('grant'),
  cloutEntrySchema('legacy'),
  cloutEntrySchema('repair'),
  cloutEntrySchema('item'),
  cloutEntrySchema('premium'),
])

const CompactedSchema = z.strictObject({
  entries: WholeSchema,
  bySource: z.partialRecord(z.enum(CLOUT_SOURCES), z.int()),
})

/** The structure of `player.clout`; cross-field rules are in `cloutIssue`. */
function cloutStateSchema(config: EngineConfig) {
  return z.strictObject({
    ledger: z.array(CloutEntrySchema).check(z.maxLength(config.clout.ledger.maxEntries)),
    compacted: CompactedSchema,
    nextSeq: z.int().check(z.gte(1)),
    peakLevel: z.int().check(z.gte(0), z.lte(config.clout.levels.length - 1)),
    firstPaycheckPaid: z.boolean(),
  })
}

/**
 * Why a structurally valid clout state is inconsistent, or null: entries out of order or not
 * below `nextSeq`, an entry recorded after `nowMinute`, a sum that is not a safe integer, or
 * earned or premium clout below 0.
 */
function cloutIssue(state: CloutState, nowMinute: number) {
  let lastSeq = 0
  for (const entry of state.ledger) {
    if (entry.seq <= lastSeq) return 'ledger out of order'
    if (entry.at > nowMinute) return 'clout recorded in the future'
    lastSeq = entry.seq
  }
  if (state.nextSeq <= lastSeq) return 'nextSeq behind the ledger'
  const sums = cloutSums(state)
  const values = [sums.earned, sums.premium, ...Object.values(sums.bySource)]
  if (!values.every(Number.isSafeInteger)) return 'clout sum out of range'
  if (sums.earned < 0 || sums.premium < 0) return 'negative clout'
  return null
}

/** Places the config knows, each flexed on a day no later than today. */
function flexStateSchema(config: EngineConfig) {
  return z.strictObject({
    rngState: Uint32Schema,
    byPlace: z
      .record(z.string(), WholeSchema)
      .check(
        z.refine(
          (byPlace) => Object.keys(byPlace).every((id) => config.places.has(id)),
          'Unknown place',
        ),
      ),
  })
}

/** A club's night key: the game day the night opened on (0 for day 1 before the club opens). */
const NightKeySchema = z.int().check(z.gte(0))

/** Only configured clubs, each with a night that opened no later than today. */
function clubNightsSchema(config: EngineConfig) {
  return z
    .record(z.string(), NightKeySchema)
    .check(
      z.refine(
        (nights) => Object.keys(nights).every((id) => Object.hasOwn(config.place.clubs, id)),
        'Unknown club',
      ),
    )
}

function eventsStateSchema(config: EngineConfig) {
  return z.strictObject({
    active: z.nullable(z.string()),
    history: z.record(z.string(), z.int().check(z.gte(0))),
    pending: z.array(ItemPendingEffectSchema).check(z.maxLength(config.events.maxPendingEffects)),
    rngState: Uint32Schema,
  })
}

/** v5 and v6 event state: pending effects may still hold clout. */
function eventsStateV6Schema(config: EngineConfig) {
  return z.strictObject({
    active: z.nullable(z.string()),
    history: z.record(z.string(), z.int().check(z.gte(0))),
    pending: z.array(PendingEffectV6Schema).check(z.maxLength(config.events.maxPendingEffects)),
    rngState: Uint32Schema,
  })
}

const knownWearable = (config: EngineConfig) => (id: string) => {
  const item = findItem(id, config)
  return item !== undefined && isWearable(item)
}
const knownGift = (config: EngineConfig) => (id: string) => {
  const item = findItem(id, config)
  return item !== undefined && isGift(item)
}
function decorItem(id: string, config: EngineConfig): DecorDef | undefined {
  const item = findItem(id, config)
  return item !== undefined && isDecor(item) ? item : undefined
}
const knownDecor = (config: EngineConfig) => (id: string) => decorItem(id, config) !== undefined

/** What a player's level and goal clout add up from, besides the ledger. */
type Holdings = Omit<CloutPlayer, 'clout'>

/** The structure of `player.inventory`; cross-field rules are in `inventoryIssue`. */
function inventorySchema(config: EngineConfig) {
  return z.strictObject({
    wearables: z.array(
      z.strictObject({
        itemId: z.string().check(z.refine(knownWearable(config), 'Unknown wearable')),
        acquiredMinute: z.int().check(z.gte(0)),
        worn: z.boolean(),
        // Kept through prestige (S15, Q-8): a look only.
        prestigeKept: z.optional(z.literal(true)),
      }),
    ),
    gifts: z.array(
      z.strictObject({
        itemId: z.string().check(z.refine(knownGift(config), 'Unknown gift')),
        count: z.int().check(z.gte(1), z.lte(config.items.maxGiftStack)),
      }),
    ),
    outfit: z.strictObject(
      Object.fromEntries(ITEM_SLOTS.map((slot) => [slot, z.optional(z.string())])) as Record<
        (typeof ITEM_SLOTS)[number],
        z.ZodMiniOptional<z.ZodMiniString>
      >,
    ),
    decor: z.array(
      z.strictObject({
        itemId: z.string().check(z.refine(knownDecor(config), 'Unknown decor')),
        acquiredMinute: z.int().check(z.gte(0)),
        variant: z.string(),
        // Kept through prestige: a look only.
        prestigeKept: z.optional(z.literal(true)),
      }),
    ),
  })
}

/**
 * Why a structurally valid inventory is inconsistent, or null: a duplicate wearable, gift or
 * decor item, a wearable or decor bought after `nowMinute`, decor showing a colour it does not
 * come in, or an outfit slot holding something not owned or not for that slot.
 */
function inventoryIssue(inventory: Inventory, nowMinute: number, config: EngineConfig) {
  const decorIds = inventory.decor.map((owned) => owned.itemId)
  if (new Set(decorIds).size !== decorIds.length) return 'duplicate decor'
  if (inventory.decor.some((owned) => owned.acquiredMinute > nowMinute)) {
    return 'decor bought in the future'
  }
  const variantKnown = (owned: OwnedDecor) =>
    decorItem(owned.itemId, config)?.decor.variants.some((v) => v.id === owned.variant) === true
  if (!inventory.decor.every(variantKnown)) return 'unknown decor variant'
  const wearableIds = inventory.wearables.map((owned) => owned.itemId)
  if (new Set(wearableIds).size !== wearableIds.length) return 'duplicate wearable'
  const giftIds = inventory.gifts.map((stack) => stack.itemId)
  if (new Set(giftIds).size !== giftIds.length) return 'duplicate gift'
  if (inventory.wearables.some((owned) => owned.acquiredMinute > nowMinute)) {
    return 'wearable bought in the future'
  }
  for (const slot of ITEM_SLOTS) {
    const itemId = inventory.outfit[slot]
    if (itemId === undefined) continue
    const item = findItem(itemId, config)
    if (!wearableIds.includes(itemId) || item === undefined || !isWearable(item)) {
      return 'outfit holds an item not owned'
    }
    if (item.slot !== slot) return 'outfit item in the wrong slot'
  }
  return null
}

const homeIdSchema = (config: EngineConfig) =>
  z.string().check(z.refine((home) => isHomeId(home, config), 'Unknown home'))

function moveRecordSchema(config: EngineConfig) {
  return z.strictObject({
    from: homeIdSchema(config),
    to: homeIdSchema(config),
    at: WholeSchema,
    cost: WholeSchema,
  })
}

/** The structure of `player.apartment`; cross-field rules are in `apartmentIssue`. */
function apartmentSchema(config: EngineConfig) {
  return z.strictObject({
    placed: z.record(z.string(), z.string()),
    moveLog: z.array(moveRecordSchema(config)).check(z.maxLength(config.home.moveLogMax)),
  })
}

/** Why one placement does not fit `home` and `inventory`, or null. */
function placementIssue(
  slotId: string,
  itemId: string,
  home: HomeId,
  inventory: Inventory,
  config: EngineConfig,
) {
  const slot = slotsFor(home, config).find((entry) => entry.id === slotId)
  if (slot === undefined) return 'decor in a slot this home does not have'
  const item = decorItem(itemId, config)
  if (item === undefined || !inventory.decor.some((owned) => owned.itemId === itemId)) {
    return 'placed decor not owned'
  }
  if (item.decor.fits !== slot.kind) return 'decor in the wrong kind of slot'
  return null
}

/** Why one move log entry cannot follow `previous` or happened after `nowMinute`, or null. */
function moveIssue(move: MoveRecord, previous: MoveRecord | undefined, nowMinute: number) {
  if (move.at > nowMinute) return 'move in the future'
  if (move.from === move.to) return 'move to the same home'
  if (previous !== undefined && move.at < previous.at) return 'move log out of order'
  return null
}

/**
 * Why a structurally valid apartment is inconsistent, or null: a placement that does not fit the
 * home or the inventory (see `placementIssue`), one item in two slots, or a bad move log entry.
 */
function apartmentIssue(
  apartment: ApartmentState,
  home: HomeId,
  inventory: Inventory,
  nowMinute: number,
  config: EngineConfig,
) {
  const placedIds = Object.values(apartment.placed)
  if (new Set(placedIds).size !== placedIds.length) return 'decor placed twice'
  for (const [slotId, itemId] of Object.entries(apartment.placed)) {
    const issue = placementIssue(slotId, itemId, home, inventory, config)
    if (issue !== null) return issue
  }
  for (const [i, move] of apartment.moveLog.entries()) {
    const issue = moveIssue(move, apartment.moveLog[i - 1], nowMinute)
    if (issue !== null) return issue
  }
  return null
}

/** Home, or a place the config knows (any venue or landmark, memorials included). */
function locationSchema(config: EngineConfig) {
  return z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('home') }),
    z.strictObject({
      kind: z.literal('place'),
      placeId: z.string().check(z.refine((id) => config.places.has(id), 'Unknown place')),
    }),
  ])
}

const TransitStateSchema = z.strictObject({ rngState: Uint32Schema })

/** Landmarks the config knows (memorials have no Visit), each first visited at a whole minute. */
function isVisitablePlace(id: string, config: EngineConfig): boolean {
  const category = config.places.get(id)
  return category !== undefined && category !== 'memorial'
}

function visitedSchema(config: EngineConfig) {
  return z
    .record(z.string(), WholeSchema)
    .check(
      z.refine(
        (visited) => Object.keys(visited).every((id) => isVisitablePlace(id, config)),
        'Unknown place',
      ),
    )
}

const GrantAmountsSchema = z.strictObject({
  cash: WholeSchema,
  clout: WholeSchema,
  badge: z.nullable(z.string()),
})

/** One grant record; its key must be the one its eligibility names, and it applied no more than asked or capped. */
const GrantRecordSchema = z
  .strictObject({
    seq: z.int().check(z.gte(1)),
    key: z.string(),
    kind: z.literal('goal_reward'),
    eligibility: z.strictObject({
      rule: z.literal('goal-achieved'),
      goalId: z.string(),
      run: z.int().check(z.gte(1)),
    }),
    reason: z.string().check(z.minLength(1)),
    requested: GrantAmountsSchema,
    cap: z.strictObject({ cash: WholeSchema, clout: WholeSchema }),
    applied: GrantAmountsSchema,
    at: WholeSchema,
    issuedAtMs: WholeSchema,
    issuedBy: z.literal('system'),
    campaignId: z.null(),
    sync: z.enum(['local', 'synced']),
  })
  .check(
    z.refine(
      (record) =>
        record.key === goalGrantKey(record.eligibility.goalId, record.eligibility.run) &&
        record.applied.cash <= Math.min(record.requested.cash, record.cap.cash) &&
        record.applied.clout <= Math.min(record.requested.clout, record.cap.clout) &&
        record.applied.badge === record.requested.badge,
      'Inconsistent grant record',
    ),
  )

function grantsStateSchema(config: EngineConfig) {
  return z.strictObject({
    log: z.array(GrantRecordSchema).check(z.maxLength(config.grants.log.maxEntries)),
    nextSeq: z.int().check(z.gte(1)),
  })
}

/**
 * Why a structurally valid grant log is inconsistent, or null: records out of order or not
 * below `nextSeq`, a record granted after `nowMinute`, or a key granted twice.
 */
function grantsIssue(grants: GrantsState, nowMinute: number) {
  let lastSeq = 0
  const keys = new Set<string>()
  for (const record of grants.log) {
    if (record.seq <= lastSeq) return 'grant log out of order'
    if (record.at > nowMinute) return 'grant recorded in the future'
    if (keys.has(record.key)) return 'grant key repeated'
    keys.add(record.key)
    lastSeq = record.seq
  }
  if (grants.nextSeq <= lastSeq) return 'nextSeq behind the grant log'
  return null
}

function goalsStateSchema(config: EngineConfig) {
  const known = (id: string) => config.goals.some((goal) => goal.id === id)
  return z.strictObject({
    run: z.int().check(z.gte(1)),
    achieved: z
      .record(z.string(), WholeSchema)
      .check(z.refine((achieved) => Object.keys(achieved).every(known), 'Unknown goal')),
    icon: z.strictObject({ reachedAt: z.nullable(WholeSchema), acknowledged: z.boolean() }),
  })
}

/** The highest run any claimed key names (the log's and the clout ledger's), at least 1. */
function highestClaimedRun(grants: GrantsState, clout: CloutState): number {
  const keys = [
    ...grants.log.map((record) => record.key),
    ...clout.ledger.flatMap((entry) => (entry.source === 'grant' ? [entry.ref.grantKey] : [])),
  ]
  return Math.max(1, ...keys.map((key) => parseGoalGrantKey(key)?.run ?? 1))
}

/**
 * Why structurally valid goals are inconsistent, or null: a goal reached after `nowMinute`, a
 * run behind a claimed key, or an Icon moment that does not match the victory goal.
 */
function goalsIssue(
  goals: GoalsState,
  grants: GrantsState,
  clout: CloutState,
  nowMinute: number,
  config: EngineConfig,
) {
  if (Object.values(goals.achieved).some((minute) => minute > nowMinute)) {
    return 'goal reached in the future'
  }
  if (goals.run < highestClaimedRun(grants, clout)) return 'run behind a claimed grant'
  const victory = victoryGoal(config).id
  const reachedAt = Object.hasOwn(goals.achieved, victory) ? goals.achieved[victory] : undefined
  if ((goals.icon.reachedAt ?? undefined) !== reachedAt) return 'Icon moment out of step'
  return null
}

function badgeSchema(config: EngineConfig) {
  return z.string().check(z.refine((id) => config.prestige.badgeIds.includes(id), 'Unknown badge'))
}

function prestigeRunSchema(config: EngineConfig) {
  return z.strictObject({
    run: z.int().check(z.gte(1)),
    endedAt: WholeSchema,
    issuedAtMs: WholeSchema,
    badge: badgeSchema(config),
  })
}

function prestigeStateSchema(config: EngineConfig) {
  return z.strictObject({
    count: WholeSchema,
    badges: z
      .array(badgeSchema(config))
      .check(z.refine((badges) => new Set(badges).size === badges.length, 'Repeated badge')),
    history: z.array(prestigeRunSchema(config)),
  })
}

/** Why a structurally valid prestige state is inconsistent, or null. */
function prestigeIssue(prestige: PrestigeState, nowMinute: number) {
  if (prestige.history.some((entry) => entry.endedAt > nowMinute)) return 'run ended in the future'
  if (prestige.count < prestige.history.length) return 'count behind the history'
  return null
}

export function createSaveSchema(config: EngineConfig) {
  const stat = z.int().check(z.gte(0), z.lte(config.stats.max))
  const save = z.strictObject({
    clock: z.strictObject({
      minute: z.int().check(z.gte(0)),
      remainderMs: z.number().check(z.gte(0), z.lt(realMsPerGameMinute(config))),
    }),
    player: z.strictObject({
      cash: CashSchema,
      stats: z.strictObject({ energy: stat, hunger: stat, mood: stat }),
      clout: cloutStateSchema(config),
      flex: flexStateSchema(config),
      home: z.string().check(z.refine((home) => isHomeId(home, config), 'Unknown home')),
      rent: z.strictObject({
        owed: CashSchema,
        missed: z.int().check(z.gte(0), z.lt(config.rent.evictAfterMissed)),
      }),
      inventory: inventorySchema(config),
      clubNights: clubNightsSchema(config),
      visited: visitedSchema(config),
      apartment: apartmentSchema(config),
      location: locationSchema(config),
      transit: TransitStateSchema,
    }),
    speed: z.number().check(z.refine((speed) => isSpeed(speed, config), 'Unsupported speed')),
    events: eventsStateSchema(config),
    goals: goalsStateSchema(config),
    grants: grantsStateSchema(config),
    prestige: prestigeStateSchema(config),
    actions: WholeSchema,
  })
  return save.check(
    z.refine(
      (value) => inventoryIssue(value.player.inventory, value.clock.minute, config) === null,
      { message: 'Inconsistent inventory', path: ['player', 'inventory'] },
    ),
    z.refine(
      (value) =>
        apartmentIssue(
          value.player.apartment as ApartmentState,
          value.player.home as HomeId,
          value.player.inventory as Inventory,
          value.clock.minute,
          config,
        ) === null,
      { message: 'Inconsistent apartment', path: ['player', 'apartment'] },
    ),
    z.refine(
      (value) =>
        Object.values(value.player.clubNights).every(
          (night) => night <= calendar(value.clock.minute, config).day,
        ),
      { message: 'A club night in the future', path: ['player', 'clubNights'] },
    ),
    z.refine(
      (value) =>
        !peakAboveEarned(
          value.player.clout as CloutState,
          {
            inventory: value.player.inventory as Inventory,
            home: value.player.home as HomeId,
            apartment: value.player.apartment as ApartmentState,
          },
          config,
        ),
      { message: 'Peak level above earned clout', path: ['player', 'clout', 'peakLevel'] },
    ),
    z.refine((value) => cloutIssue(value.player.clout as CloutState, value.clock.minute) === null, {
      message: 'Inconsistent clout ledger',
      path: ['player', 'clout'],
    }),
    z.refine(
      (value) =>
        Object.values(value.player.flex.byPlace).every(
          (day) => day <= calendar(value.clock.minute, config).day,
        ),
      { message: 'A flex in the future', path: ['player', 'flex'] },
    ),
    z.refine(
      (value) =>
        Object.values(value.player.visited).every((minute) => minute <= value.clock.minute),
      { message: 'A visit in the future', path: ['player', 'visited'] },
    ),
    z.refine((value) => grantsIssue(value.grants as GrantsState, value.clock.minute) === null, {
      message: 'Inconsistent grant log',
      path: ['grants'],
    }),
    z.refine(
      (value) =>
        goalsIssue(
          value.goals,
          value.grants as GrantsState,
          value.player.clout as CloutState,
          value.clock.minute,
          config,
        ) === null,
      { message: 'Inconsistent goals', path: ['goals'] },
    ),
    z.refine((value) => prestigeIssue(value.prestige, value.clock.minute) === null, {
      message: 'Inconsistent prestige',
      path: ['prestige'],
    }),
  )
}

/** Own keys of a plain object, or an empty object for anything else. */
function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/**
 * The clout ledger from an untrusted save, keeping everything usable: entries that do not fit
 * their source's shape, were recorded after `nowMinute` or break the `seq` order are dropped;
 * folded totals keep the known sources with whole values; `nextSeq` moves past the last entry;
 * a `peakLevel` outside the levels is clamped (a non-number becomes the current level, so no
 * level-up replays); a non-boolean `firstPaycheckPaid` becomes true (never paid twice). Earned
 * clout below 0 gets a `repair` entry back to 0; premium clout below 0 is folded back to 0.
 * Totals that sum past a safe integer keep no entries or folded totals at all.
 * `repaired` is false when the state was already valid.
 */
function repairClout(
  raw: unknown,
  nowMinute: number,
  holdings: Holdings,
  config: EngineConfig,
): { readonly clout: CloutState; readonly repaired: boolean } {
  const parsed = cloutStateSchema(config).safeParse(raw)
  if (parsed.success && cloutIssue(parsed.data as CloutState, nowMinute) === null) {
    return { clout: parsed.data as CloutState, repaired: false }
  }
  const source = recordOf(raw)

  const kept: CloutEntry[] = []
  for (const value of Array.isArray(source.ledger) ? source.ledger : []) {
    const entry = CloutEntrySchema.safeParse(value)
    if (!entry.success || entry.data.at > nowMinute) continue
    // T-1: a sequence number at the safe-integer limit leaves no room for the next one.
    if (entry.data.seq <= (kept.at(-1)?.seq ?? 0) || entry.data.seq >= Number.MAX_SAFE_INTEGER) {
      continue
    }
    kept.push(entry.data as CloutEntry)
  }
  const overflow = Math.max(0, kept.length - config.clout.ledger.maxEntries)

  const rawCompacted = recordOf(source.compacted)
  const rawBySource = recordOf(rawCompacted.bySource)
  const bySource: Partial<Record<CloutSourceId, number>> = {}
  for (const id of CLOUT_SOURCES) {
    const value = Object.hasOwn(rawBySource, id) ? rawBySource[id] : undefined
    if (typeof value === 'number' && Number.isSafeInteger(value)) bySource[id] = value
  }
  for (const entry of kept.slice(0, overflow)) {
    bySource[entry.source] = (bySource[entry.source] ?? 0) + entry.amount
  }
  const rawEntries = rawCompacted.entries
  const entries =
    (typeof rawEntries === 'number' && Number.isSafeInteger(rawEntries) && rawEntries >= 0
      ? rawEntries
      : 0) + overflow

  const ledger = kept.slice(overflow)
  const lastSeq = kept.at(-1)?.seq ?? 0
  const rawNext = source.nextSeq
  const nextSeq =
    typeof rawNext === 'number' &&
    Number.isSafeInteger(rawNext) &&
    rawNext > lastSeq &&
    rawNext < Number.MAX_SAFE_INTEGER
      ? rawNext
      : lastSeq + 1

  let clout: CloutState = {
    ledger,
    compacted: { entries, bySource },
    nextSeq,
    peakLevel: 0,
    firstPaycheckPaid:
      typeof source.firstPaycheckPaid === 'boolean' ? source.firstPaycheckPaid : true,
  }
  let sums = cloutSums(clout)
  // Each kept value is a safe integer, but tampered totals can still sum past one: such a
  // ledger is unusable, so nothing of it is kept (and no repair entry can overflow either).
  if (![sums.earned, sums.premium, ...Object.values(sums.bySource)].every(Number.isSafeInteger)) {
    clout = { ...clout, ledger: [], compacted: initialCloutState.compacted }
    sums = cloutSums(clout)
  }
  if (sums.premium < 0) {
    const premium = (clout.compacted.bySource.premium ?? 0) - sums.premium
    clout = {
      ...clout,
      compacted: { ...clout.compacted, bySource: { ...clout.compacted.bySource, premium } },
    }
  }
  if (sums.earned < 0) {
    const change = { source: 'repair', amount: -sums.earned, ref: {} } as const
    clout = appendClout(clout, change, nowMinute, config).state
  }

  const top = config.clout.levels.length - 1
  const rawPeak = source.peakLevel
  const peakLevel =
    typeof rawPeak === 'number' && Number.isFinite(rawPeak)
      ? Math.min(top, Math.max(0, Math.round(rawPeak)))
      : currentLevelIndex(clout, holdings, config)
  return { clout: { ...clout, peakLevel }, repaired: true }
}

/** The level a clout state, inventory and home add up to (premium capped, Icon earned only). */
function currentLevelIndex(clout: CloutState, holdings: Holdings, config: EngineConfig) {
  return playerLevel({ ...holdings, clout }, config).index
}

/**
 * True when `peakLevel` claims the earned-only level (Icon) that goal clout has never held:
 * a save from before "Icon is earned" (S15 fix cycle 1), or a tampered one.
 */
function peakAboveEarned(clout: CloutState, holdings: Holdings, config: EngineConfig) {
  const earnedOnly = earnedOnlyLevel(config)
  return (
    earnedOnly !== null &&
    clout.peakLevel >= earnedOnly.index &&
    goalClout({ ...holdings, clout }, config) < earnedOnly.minClout
  )
}

/**
 * Lowers a peak level that claims Icon without the earned clout for it to the level below, so
 * no level-up replays below it and Icon still lands (with the Icon moment) once it is earned.
 */
function capPeakToEarned(clout: CloutState, holdings: Holdings, config: EngineConfig) {
  const earnedOnly = earnedOnlyLevel(config)
  if (earnedOnly === null || !peakAboveEarned(clout, holdings, config)) return clout
  return { ...clout, peakLevel: earnedOnly.index - 1 }
}

/**
 * Flex state from an untrusted save: flexes at places the config does not know or on a day
 * after today are dropped, and a generator state that is not a uint32 starts over at 0.
 */
function repairFlex(
  raw: unknown,
  nowMinute: number,
  config: EngineConfig,
): { readonly flex: FlexState; readonly repaired: boolean } {
  const today = calendar(nowMinute, config).day
  const parsed = flexStateSchema(config).safeParse(raw)
  if (parsed.success && Object.values(parsed.data.byPlace).every((day) => day <= today)) {
    return { flex: parsed.data, repaired: false }
  }
  const source = recordOf(raw)
  const rngState = Uint32Schema.safeParse(source.rngState)
  const entries = Object.entries(recordOf(source.byPlace))
  const kept = entries.filter(
    (entry): entry is [string, number] =>
      config.places.has(entry[0]) &&
      Number.isSafeInteger(entry[1]) &&
      (entry[1] as number) >= 0 &&
      (entry[1] as number) <= today,
  )
  return {
    flex: { rngState: rngState.success ? rngState.data : 0, byPlace: Object.fromEntries(kept) },
    repaired: true,
  }
}

/**
 * Club nights from an untrusted save: entries for clubs the config does not have, keys that
 * are not own string keys, and nights that are not whole numbers in 0..today are dropped (so
 * a damaged entry can only let a club pay out once more, never block it for good).
 */
function repairClubNights(
  raw: unknown,
  nowMinute: number,
  config: EngineConfig,
): { readonly clubNights: ClubNights; readonly repaired: boolean } {
  const today = calendar(nowMinute, config).day
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { clubNights: {}, repaired: true }
  }
  const entries = Object.entries(raw as Record<string, unknown>)
  const kept = entries.filter(
    (entry): entry is [string, number] =>
      Object.hasOwn(config.place.clubs, entry[0]) &&
      Number.isSafeInteger(entry[1]) &&
      (entry[1] as number) >= 0 &&
      (entry[1] as number) <= today,
  )
  return { clubNights: Object.fromEntries(kept), repaired: kept.length !== entries.length }
}

/**
 * The player's inventory from an untrusted save, keeping everything usable: unknown or
 * duplicate items are dropped, a purchase minute that is not a whole number in
 * 0..`nowMinute` is clamped (a non-number becomes `nowMinute`), a non-boolean `worn` becomes
 * true (so stat effects never land twice), any `prestigeKept` mark becomes `true` (a kept look
 * never regains value), gift counts are rounded and clamped to
 * 1..maxGiftStack (0 drops the stack), outfit slots that do not hold an owned item for that
 * slot are emptied, and decor showing a colour it does not come in shows its first one.
 * `repaired` is false when the inventory was already valid.
 */
function repairInventory(
  raw: unknown,
  nowMinute: number,
  config: EngineConfig,
): { readonly inventory: Inventory; readonly repaired: boolean } {
  const parsed = inventorySchema(config).safeParse(raw)
  if (parsed.success && inventoryIssue(parsed.data, nowMinute, config) === null) {
    return { inventory: parsed.data, repaired: false }
  }

  const record = (value: unknown): Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  const list = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : [])
  const source = record(raw)

  const purchaseMinute = (acquiredMinute: unknown) =>
    typeof acquiredMinute === 'number' && Number.isFinite(acquiredMinute)
      ? Math.min(nowMinute, Math.max(0, Math.round(acquiredMinute)))
      : nowMinute

  const wearables: OwnedWearable[] = []
  for (const entry of list(source.wearables).map(record)) {
    const { itemId, acquiredMinute, worn, prestigeKept } = entry
    if (typeof itemId !== 'string' || !knownWearable(config)(itemId)) continue
    if (wearables.some((owned) => owned.itemId === itemId)) continue
    const minute = purchaseMinute(acquiredMinute)
    wearables.push({
      itemId,
      acquiredMinute: minute,
      worn: typeof worn === 'boolean' ? worn : true,
      // Any mark at all keeps it a look only: a damaged mark never turns value back on.
      ...(prestigeKept === undefined ? {} : { prestigeKept: true as const }),
    })
  }

  const gifts: GiftStack[] = []
  for (const entry of list(source.gifts).map(record)) {
    const { itemId, count } = entry
    if (typeof itemId !== 'string' || !knownGift(config)(itemId)) continue
    if (gifts.some((stack) => stack.itemId === itemId)) continue
    if (typeof count !== 'number' || !Number.isFinite(count)) continue
    const fixed = Math.min(config.items.maxGiftStack, Math.round(count))
    if (fixed >= 1) gifts.push({ itemId, count: fixed })
  }

  const rawOutfit = record(source.outfit)
  const outfit: Partial<Record<(typeof ITEM_SLOTS)[number], string>> = {}
  for (const slot of ITEM_SLOTS) {
    const itemId = Object.hasOwn(rawOutfit, slot) ? rawOutfit[slot] : undefined
    if (typeof itemId !== 'string') continue
    const item = findItem(itemId, config)
    const owned = wearables.some((entry) => entry.itemId === itemId)
    if (owned && item !== undefined && isWearable(item) && item.slot === slot) outfit[slot] = itemId
  }

  const decor: OwnedDecor[] = []
  for (const entry of list(source.decor).map(record)) {
    const { itemId, acquiredMinute, variant, prestigeKept } = entry
    const item = typeof itemId === 'string' ? decorItem(itemId, config) : undefined
    if (item === undefined || decor.some((owned) => owned.itemId === item.id)) continue
    const known = item.decor.variants.some((option) => option.id === variant)
    decor.push({
      itemId: item.id,
      acquiredMinute: purchaseMinute(acquiredMinute),
      variant: known ? (variant as string) : (item.decor.variants[0]?.id ?? ''),
      // Any mark at all keeps it a look only: a damaged mark never turns value back on.
      ...(prestigeKept === undefined ? {} : { prestigeKept: true as const }),
    })
  }
  return { inventory: { wearables, gifts, outfit, decor }, repaired: true }
}

/**
 * The apartment from an untrusted save, keeping everything usable: placements in a slot the
 * home does not have, of decor not owned or not of the slot's kind, or of an item already placed
 * are dropped (the item goes back to storage); move log entries that are malformed, in the
 * future, to the same home or out of order are dropped, and the newest `home.moveLogMax` kept.
 * `repaired` is false when the apartment was already valid.
 */
function repairApartment(
  raw: unknown,
  home: HomeId,
  inventory: Inventory,
  nowMinute: number,
  config: EngineConfig,
): { readonly apartment: ApartmentState; readonly repaired: boolean } {
  const parsed = apartmentSchema(config).safeParse(raw)
  if (
    parsed.success &&
    apartmentIssue(parsed.data as ApartmentState, home, inventory, nowMinute, config) === null
  ) {
    return { apartment: parsed.data as ApartmentState, repaired: false }
  }
  const source = recordOf(raw)
  const kept: [string, string][] = []
  for (const [slotId, itemId] of Object.entries(recordOf(source.placed))) {
    if (typeof itemId !== 'string' || kept.some(([, keptId]) => keptId === itemId)) continue
    if (placementIssue(slotId, itemId, home, inventory, config) === null) {
      kept.push([slotId, itemId])
    }
  }
  const placed: Placements = Object.fromEntries(kept)
  const entrySchema = moveRecordSchema(config)
  const moveLog: MoveRecord[] = []
  for (const value of Array.isArray(source.moveLog) ? source.moveLog : []) {
    const move = entrySchema.safeParse(value)
    if (!move.success) continue
    const entry = move.data as MoveRecord
    if (moveIssue(entry, moveLog.at(-1), nowMinute) === null) moveLog.push(entry)
  }
  return {
    apartment: { placed, moveLog: moveLog.slice(-config.home.moveLogMax) },
    repaired: true,
  }
}

/**
 * The player's location from an untrusted save: anything that is not home or a place the config
 * knows (a place removed between builds, a tampered id) puts the player at home.
 */
function repairLocation(
  raw: unknown,
  config: EngineConfig,
): { readonly location: PlayerLocation; readonly repaired: boolean } {
  const parsed = locationSchema(config).safeParse(raw)
  return parsed.success
    ? { location: parsed.data, repaired: false }
    : { location: HOME_LOCATION, repaired: true }
}

/** Transit state from an untrusted save: a generator state that is not a uint32 starts over. */
function repairTransit(raw: unknown): {
  readonly transit: TransitState
  readonly repaired: boolean
} {
  const parsed = TransitStateSchema.safeParse(raw)
  if (parsed.success) return { transit: parsed.data, repaired: false }
  const rngState = Uint32Schema.safeParse(recordOf(raw).rngState)
  return { transit: { rngState: rngState.success ? rngState.data : 0 }, repaired: true }
}

/** First visits from an untrusted save: unknown places, memorials and bad minutes are dropped. */
function repairVisited(
  raw: unknown,
  nowMinute: number,
  config: EngineConfig,
): { readonly visited: Visited; readonly repaired: boolean } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { visited: {}, repaired: true }
  }
  const entries = Object.entries(raw as Record<string, unknown>)
  const kept = entries.filter(
    (entry): entry is [string, number] =>
      isVisitablePlace(entry[0], config) &&
      Number.isSafeInteger(entry[1]) &&
      (entry[1] as number) >= 0 &&
      (entry[1] as number) <= nowMinute,
  )
  return { visited: Object.fromEntries(kept), repaired: kept.length !== entries.length }
}

/**
 * The grant log from an untrusted save, keeping every usable record: malformed records,
 * records granted after `nowMinute`, records that break the `seq` order and repeats of a key
 * already kept are dropped; the newest `grants.log.maxEntries` are kept; `nextSeq` moves past
 * the last record.
 */
function repairGrants(
  raw: unknown,
  nowMinute: number,
  config: EngineConfig,
): { readonly grants: GrantsState; readonly repaired: boolean } {
  const parsed = grantsStateSchema(config).safeParse(raw)
  if (parsed.success && grantsIssue(parsed.data as GrantsState, nowMinute) === null) {
    return { grants: parsed.data as GrantsState, repaired: false }
  }
  const source = recordOf(raw)
  const kept: GrantRecord[] = []
  const keys = new Set<string>()
  for (const value of Array.isArray(source.log) ? source.log : []) {
    const record = GrantRecordSchema.safeParse(value)
    if (!record.success || record.data.at > nowMinute || keys.has(record.data.key)) continue
    // T-1: a sequence number at the safe-integer limit leaves no room for the next one.
    if (record.data.seq <= (kept.at(-1)?.seq ?? 0) || record.data.seq >= Number.MAX_SAFE_INTEGER) {
      continue
    }
    keys.add(record.data.key)
    kept.push(record.data as GrantRecord)
  }
  const log = kept.slice(-config.grants.log.maxEntries)
  const lastSeq = kept.at(-1)?.seq ?? 0
  const rawNext = source.nextSeq
  const nextSeq =
    typeof rawNext === 'number' &&
    Number.isSafeInteger(rawNext) &&
    rawNext > lastSeq &&
    rawNext < Number.MAX_SAFE_INTEGER
      ? rawNext
      : lastSeq + 1
  return { grants: { log, nextSeq }, repaired: true }
}

/**
 * Goals from an untrusted save: goals the config does not know (or that are coming soon) and
 * minutes that are not whole numbers in 0..`nowMinute` are dropped; the run is at least 1 and
 * never behind a claimed key (so a claimed reward can never be claimed again); the Icon moment
 * follows the victory goal (reached at its minute, shown again if it was damaged).
 */
function repairGoals(
  raw: unknown,
  nowMinute: number,
  grants: GrantsState,
  clout: CloutState,
  config: EngineConfig,
): { readonly goals: GoalsState; readonly repaired: boolean } {
  const parsed = goalsStateSchema(config).safeParse(raw)
  if (
    parsed.success &&
    goalsIssue(parsed.data, grants, clout, nowMinute, config) === null &&
    Object.keys(parsed.data.achieved).every(
      (id) => config.goals.find((goal) => goal.id === id)?.available !== false,
    )
  ) {
    return { goals: parsed.data, repaired: false }
  }
  const source = recordOf(raw)
  const rawRun = source.run
  const run = Math.max(
    typeof rawRun === 'number' && Number.isSafeInteger(rawRun) && rawRun >= 1 ? rawRun : 1,
    highestClaimedRun(grants, clout),
  )
  const achieved = Object.fromEntries(
    Object.entries(recordOf(source.achieved)).filter(
      (entry): entry is [string, number] =>
        config.goals.some((goal) => goal.id === entry[0] && goal.available !== false) &&
        Number.isSafeInteger(entry[1]) &&
        (entry[1] as number) >= 0 &&
        (entry[1] as number) <= nowMinute,
    ),
  )
  const victory = victoryGoal(config).id
  const reachedAt = Object.hasOwn(achieved, victory) ? (achieved[victory] ?? null) : null
  const rawIcon = recordOf(source.icon)
  const icon =
    reachedAt === null
      ? initialGoalsState.icon
      : {
          reachedAt,
          acknowledged:
            rawIcon.reachedAt === reachedAt && typeof rawIcon.acknowledged === 'boolean'
              ? rawIcon.acknowledged
              : false,
        }
  return { goals: { run, achieved, icon }, repaired: true }
}

/**
 * Prestige from an untrusted save: badges the config does not know (and repeats) are dropped,
 * as are malformed or future history entries; the count is at least the history's length.
 */
function repairPrestige(
  raw: unknown,
  nowMinute: number,
  config: EngineConfig,
): { readonly prestige: PrestigeState; readonly repaired: boolean } {
  const parsed = prestigeStateSchema(config).safeParse(raw)
  if (parsed.success && prestigeIssue(parsed.data, nowMinute) === null) {
    return { prestige: parsed.data, repaired: false }
  }
  const source = recordOf(raw)
  const badges: string[] = []
  for (const badge of Array.isArray(source.badges) ? source.badges : []) {
    if (typeof badge === 'string' && config.prestige.badgeIds.includes(badge)) {
      if (!badges.includes(badge)) badges.push(badge)
    }
  }
  const entrySchema = prestigeRunSchema(config)
  const history: PrestigeRun[] = []
  for (const value of Array.isArray(source.history) ? source.history : []) {
    const entry = entrySchema.safeParse(value)
    if (entry.success && entry.data.endedAt <= nowMinute) history.push(entry.data)
  }
  const rawCount = source.count
  const count = Math.max(
    typeof rawCount === 'number' && Number.isSafeInteger(rawCount) && rawCount >= 0 ? rawCount : 0,
    history.length,
  )
  return { prestige: { count, badges, history }, repaired: true }
}

/**
 * The structure a current-version save must have to be usable at all. Fields that can be
 * repaired one by one (see `loadSave`) are only type-checked loosely here.
 */
const LoadableSaveSchema = z.strictObject({
  clock: z.strictObject({ minute: z.int().check(z.gte(0)), remainderMs: z.unknown() }),
  player: z.strictObject({
    cash: CashSchema,
    stats: z.strictObject({ energy: z.number(), hunger: z.number(), mood: z.number() }),
    // Repairable: unusable entries are dropped (`repairClout`).
    clout: z.unknown(),
    // Repairable: unusable flexes are dropped (`repairFlex`).
    flex: z.optional(z.unknown()),
    home: z.unknown(),
    rent: z.strictObject({ owed: CashSchema, missed: z.unknown() }),
    inventory: z.unknown(),
    // Repairable: unusable entries are dropped (`repairClubNights`).
    clubNights: z.optional(z.unknown()),
    // Repairable: unusable entries are dropped (`repairVisited`); a v7 save has none.
    visited: z.optional(z.unknown()),
    // Repairable: unusable placements and moves are dropped (`repairApartment`); a v8 save has none.
    apartment: z.optional(z.unknown()),
    // Repairable: an unknown place means home (`repairLocation`); a v9 save has none.
    location: z.optional(z.unknown()),
    // Repairable: a generator state that is not a uint32 starts over; a v9 save has none.
    transit: z.optional(z.unknown()),
  }),
  speed: z.unknown(),
  // Repairable: a missing or unusable event state starts over (`repairEvents`).
  events: z.optional(z.unknown()),
  // Repairable (`repairGoals`, `repairGrants`, `repairPrestige`); a v7 save has none.
  goals: z.optional(z.unknown()),
  grants: z.optional(z.unknown()),
  prestige: z.optional(z.unknown()),
  // Repairable: a v10 or older save has none (0); anything but a whole number becomes 0.
  actions: z.optional(z.unknown()),
})

/** A v6 save's structure (S09): clout is one number, no flex state yet. */
const LoadableSaveV6Schema = z.strictObject({
  clock: z.strictObject({ minute: z.int().check(z.gte(0)), remainderMs: z.unknown() }),
  player: z.strictObject({
    cash: CashSchema,
    stats: z.strictObject({ energy: z.number(), hunger: z.number(), mood: z.number() }),
    clout: LegacyCloutSchema,
    home: z.unknown(),
    rent: z.strictObject({ owed: CashSchema, missed: z.unknown() }),
    inventory: z.unknown(),
    clubNights: z.optional(z.unknown()),
  }),
  speed: z.unknown(),
  events: z.optional(z.unknown()),
})
type LoadableSaveV6 = z.infer<typeof LoadableSaveV6Schema>

/** A v5 save's structure (S14): no club nights yet. */
const LoadableSaveV5Schema = z.strictObject({
  clock: z.strictObject({ minute: z.int().check(z.gte(0)), remainderMs: z.unknown() }),
  player: z.strictObject({
    cash: CashSchema,
    stats: z.strictObject({ energy: z.number(), hunger: z.number(), mood: z.number() }),
    clout: LegacyCloutSchema,
    home: z.unknown(),
    rent: z.strictObject({ owed: CashSchema, missed: z.unknown() }),
    inventory: z.unknown(),
  }),
  speed: z.unknown(),
  events: z.optional(z.unknown()),
})

/** A v4 save's structure (S10): no event state yet. */
const LoadableSaveV4Schema = z.strictObject({
  clock: z.strictObject({ minute: z.int().check(z.gte(0)), remainderMs: z.unknown() }),
  player: z.strictObject({
    cash: CashSchema,
    stats: z.strictObject({ energy: z.number(), hunger: z.number(), mood: z.number() }),
    clout: LegacyCloutSchema,
    home: z.unknown(),
    rent: z.strictObject({ owed: CashSchema, missed: z.unknown() }),
    inventory: z.unknown(),
  }),
  speed: z.unknown(),
})

/** A v3 save's structure (S11): no inventory yet. */
const LoadableSaveV3Schema = z.strictObject({
  clock: z.strictObject({ minute: z.int().check(z.gte(0)), remainderMs: z.unknown() }),
  player: z.strictObject({
    cash: CashSchema,
    stats: z.strictObject({ energy: z.number(), hunger: z.number(), mood: z.number() }),
    clout: LegacyCloutSchema,
    home: z.unknown(),
    rent: z.strictObject({ owed: CashSchema, missed: z.unknown() }),
  }),
  speed: z.unknown(),
})

/** A v2 save's structure (S03): no clout, home or rent yet. */
const LoadableSaveV2Schema = z.strictObject({
  clock: z.strictObject({ minute: z.int().check(z.gte(0)), remainderMs: z.unknown() }),
  player: z.strictObject({
    cash: CashSchema,
    stats: z.strictObject({ energy: z.number(), hunger: z.number(), mood: z.number() }),
  }),
  speed: z.unknown(),
})

export type LoadResult =
  | {
      readonly ok: true
      readonly save: SaveState
      /** Dotted paths of the fields that were out of range and were repaired. */
      readonly repaired: readonly string[]
    }
  | { readonly ok: false; readonly issues: readonly string[] }

/**
 * Loads a current-version save, repairing individually invalid fields instead of discarding
 * the player's progress:
 * - a speed the config does not offer becomes 1x;
 * - a remainder outside [0, one game minute) or not a finite number becomes 0;
 * - a stat outside 0..stats.max is clamped, and a fractional stat is rounded;
 * - a home the config does not offer becomes the start home;
 * - a missed-rent count that is not a whole number in 0..evictAfterMissed-1 is clamped
 *   (a non-number becomes 0);
 * - an inconsistent or malformed inventory keeps what is usable (see `repairInventory`);
 * - an inconsistent apartment keeps what is usable (see `repairApartment`);
 * - unusable event state starts over (see `repairEvents`);
 * - unusable club-night entries are dropped (see `repairClubNights`);
 * - an inconsistent clout ledger keeps what is usable (see `repairClout`), and a peak level at
 *   Icon without the earned clout for it drops to the level below (`capPeakToEarned`);
 * - unusable flexes are dropped (see `repairFlex`);
 * - unusable first visits are dropped (see `repairVisited`);
 * - a location that is not home or a known place becomes home (see `repairLocation`), and a
 *   transit generator state that is not a uint32 starts over (see `repairTransit`);
 * - an inconsistent grant log, goals or prestige keep what is usable (see `repairGrants`,
 *   `repairGoals`, `repairPrestige`). Which rewards were claimed is never stored on its own:
 *   it is the grant log's keys plus the clout ledger's grant references, so no repair can
 *   unclaim one;
 * - an action count that is not a whole number becomes 0.
 * Only a structurally unusable save (missing objects, unknown keys, cash or minute of the wrong
 * type or range) fails, and the caller starts fresh.
 */
export function loadSave(persisted: unknown, config: EngineConfig): LoadResult {
  const parsed = LoadableSaveSchema.safeParse(persisted)
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map((issue) => issue.path.join('.')) }
  }
  const { clock, player, speed, events } = parsed.data
  const repaired: string[] = []
  // Fields a v7 to v9 save does not have yet are filled in, not reported as repairs.
  const present = (value: unknown) => value !== undefined
  const orFresh = (value: unknown, fresh: unknown) => (value === undefined ? fresh : value)

  const inRange = (value: unknown): value is number =>
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value < realMsPerGameMinute(config)
  const remainderMs = inRange(clock.remainderMs) ? clock.remainderMs : 0
  if (remainderMs !== clock.remainderMs) repaired.push('clock.remainderMs')

  const offered = (value: unknown): value is number =>
    typeof value === 'number' && isSpeed(value, config)
  const validSpeed = offered(speed) ? speed : (config.time.speeds[0] ?? 1)
  if (validSpeed !== speed) repaired.push('speed')

  const stat = (key: 'energy' | 'hunger' | 'mood') => {
    const value = player.stats[key]
    const fixed = Math.min(config.stats.max, Math.max(0, Math.round(value)))
    if (fixed !== value) repaired.push(`player.stats.${key}`)
    return fixed
  }
  const stats = { energy: stat('energy'), hunger: stat('hunger'), mood: stat('mood') }

  const home = isHomeId(player.home, config) ? player.home : config.startHome
  if (home !== player.home) repaired.push('player.home')

  const rawMissed = player.rent.missed
  const missed =
    typeof rawMissed === 'number' && Number.isFinite(rawMissed)
      ? Math.min(config.rent.evictAfterMissed - 1, Math.max(0, Math.round(rawMissed)))
      : 0
  if (missed !== rawMissed) repaired.push('player.rent.missed')

  const { inventory, repaired: inventoryRepaired } = repairInventory(
    withDecorList(player.inventory),
    clock.minute,
    config,
  )
  if (inventoryRepaired) repaired.push('player.inventory')

  const { apartment, repaired: apartmentRepaired } = repairApartment(
    orFresh(player.apartment, initialApartment),
    home,
    inventory,
    clock.minute,
    config,
  )
  if (apartmentRepaired && present(player.apartment)) repaired.push('player.apartment')
  const holdings: Holdings = { inventory, home, apartment }

  const { clubNights, repaired: nightsRepaired } = repairClubNights(
    player.clubNights,
    clock.minute,
    config,
  )
  if (nightsRepaired) repaired.push('player.clubNights')

  const { clout: repairedClout, repaired: cloutRepaired } = repairClout(
    player.clout,
    clock.minute,
    holdings,
    config,
  )
  if (cloutRepaired) repaired.push('player.clout')
  const clout = capPeakToEarned(repairedClout, holdings, config)
  if (clout !== repairedClout) repaired.push('player.clout.peakLevel')

  const { flex, repaired: flexRepaired } = repairFlex(player.flex, clock.minute, config)
  if (flexRepaired) repaired.push('player.flex')

  const { visited, repaired: visitedRepaired } = repairVisited(
    orFresh(player.visited, {}),
    clock.minute,
    config,
  )
  if (visitedRepaired && present(player.visited)) repaired.push('player.visited')

  const { location, repaired: locationRepaired } = repairLocation(
    orFresh(player.location, HOME_LOCATION),
    config,
  )
  if (locationRepaired && present(player.location)) repaired.push('player.location')

  const { transit, repaired: transitRepaired } = repairTransit(
    orFresh(player.transit, initialTransitState),
  )
  if (transitRepaired && present(player.transit)) repaired.push('player.transit')

  const raw = parsed.data
  const { grants, repaired: grantsRepaired } = repairGrants(
    orFresh(raw.grants, initialGrantsState),
    clock.minute,
    config,
  )
  if (grantsRepaired && present(raw.grants)) repaired.push('grants')

  const { goals, repaired: goalsRepaired } = repairGoals(
    orFresh(raw.goals, initialGoalsState),
    clock.minute,
    grants,
    clout,
    config,
  )
  if (goalsRepaired && present(raw.goals)) repaired.push('goals')

  const { prestige, repaired: prestigeRepaired } = repairPrestige(
    orFresh(raw.prestige, initialPrestigeState),
    clock.minute,
    config,
  )
  if (prestigeRepaired && present(raw.prestige)) repaired.push('prestige')

  const actions = orFresh(raw.actions, 0)
  const validActions = typeof actions === 'number' && Number.isSafeInteger(actions) && actions >= 0
  if (!validActions) repaired.push('actions')

  return {
    ok: true,
    save: {
      clock: { minute: clock.minute, remainderMs },
      player: {
        cash: player.cash,
        stats,
        clout,
        flex,
        home,
        rent: { owed: player.rent.owed, missed },
        inventory,
        clubNights,
        visited,
        apartment,
        location,
        transit,
      },
      speed: validSpeed,
      events: repairEvents(events, config, repaired),
      goals,
      grants,
      prestige,
      actions: validActions ? actions : 0,
    },
    repaired,
  }
}

/**
 * An inventory from before decor (v4 to v8) with an empty decor list, so the missing list is
 * filled in rather than reported as a repair. Anything else is passed on for `repairInventory`.
 */
function withDecorList(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw
  return Object.hasOwn(raw, 'decor') ? raw : { ...raw, decor: [] }
}

/**
 * Event state is replaced by a fresh one when it does not fit the schema. Otherwise an open
 * event or a history entry for an event no longer in the catalog (content changed between
 * builds) is dropped, so a removed event can never be stuck open.
 */
function repairEvents(value: unknown, config: EngineConfig, repaired: string[]): EventsState {
  const parsed = eventsStateSchema(config).safeParse(value)
  if (!parsed.success) {
    repaired.push('events')
    return initialEventsState()
  }
  const known = new Set(config.events.catalog.map((event) => event.id))
  const { active, history, pending, rngState } = parsed.data
  const keptActive = active !== null && known.has(active) ? active : null
  if (keptActive !== active) repaired.push('events.active')
  const keptHistory = Object.fromEntries(Object.entries(history).filter(([id]) => known.has(id)))
  if (Object.keys(keptHistory).length !== Object.keys(history).length) {
    repaired.push('events.history')
  }
  return { active: keptActive, history: keptHistory, pending, rngState }
}

const SaveV1Schema = z.strictObject({ player: z.strictObject({ cash: CashSchema }) })

export function initialSave(config: EngineConfig): SaveState {
  return {
    ...initialSnapshot(config),
    speed: config.time.speeds[0] ?? 1,
    events: initialEventsState(),
    goals: initialGoalsState,
    grants: initialGrantsState,
    prestige: initialPrestigeState,
    actions: 0,
  }
}

/** A save written by a newer build: expected (an older tab or a rollback), not a failure. */
export class NewerSaveError extends Error {
  constructor(readonly version: number) {
    super(`Saved game version ${version} is newer than this build (${SAVE_VERSION})`)
    this.name = 'NewerSaveError'
  }
}

export interface Migration {
  readonly save: SaveState
  /** `carried` when progress came across from the old save, `fresh` when it was not usable. */
  readonly outcome: 'carried' | 'fresh'
}

/**
 * A v6 save's clout and events in v7 form:
 * - its clout number becomes one folded `legacy` entry (`legacyCloutState`);
 * - event clout still pending is drained into the ledger as `event` entries at face value (no
 *   style; a loss is clamped at 0 earned), and only item effects stay pending;
 * - `peakLevel` is the level the result adds up to with the wearables owned, so no level-up
 *   is reported for progress made before the ledger; the first paycheck is still to come;
 * - flex state starts fresh.
 * Event state that does not fit the v6 schema is passed on as is (`repairEvents` resets it).
 */
function upgradeV6(v6: LoadableSaveV6, config: EngineConfig) {
  const { clock, player } = v6
  const { inventory } = repairInventory(withDecorList(player.inventory), clock.minute, config)
  const home = isHomeId(player.home, config) ? player.home : config.startHome
  const holdings: Holdings = { inventory, home, apartment: initialApartment }
  let clout = legacyCloutState(player.clout, 0)
  let events: unknown = v6.events
  const parsedEvents = eventsStateV6Schema(config).safeParse(v6.events)
  if (parsedEvents.success) {
    const items: PendingEffect[] = []
    for (const effect of parsedEvents.data.pending) {
      if (effect.kind === 'item') {
        items.push(effect)
        continue
      }
      const ref = { eventId: effect.source.eventId, choiceId: effect.source.choiceId }
      const change = { source: 'event', amount: effect.amount, ref } as const
      clout = appendClout(clout, change, clock.minute, config).state
    }
    events = { ...parsedEvents.data, pending: items }
  }
  clout = { ...clout, peakLevel: currentLevelIndex(clout, holdings, config) }
  return { ...v6, player: { ...player, clout, flex: initialFlexState, inventory }, events }
}

/** Loads a save in v6 form (v2 to v5 saves are brought to it first) as the current version. */
function loadV6(raw: unknown, config: EngineConfig): LoadResult | null {
  const v6 = LoadableSaveV6Schema.safeParse(raw)
  if (!v6.success) return null
  return loadSave(upgradeV6(v6.data, config), config)
}

/**
 * Upgrades a save written by an older SAVE_VERSION. A v1 save keeps its cash and starts the
 * new clock and stats fresh. A v2 save keeps everything and starts with no clout, the start
 * home and no rent owed. A v3 save keeps everything and starts with no items. A v4 save keeps
 * everything and starts with fresh event state. A v5 save keeps everything and starts with no
 * club nights. A v6 save keeps everything, its clout carried into the ledger (`upgradeV6`).
 * Every step goes through the v6 form, so v2 to v5 saves get the v6 upgrade too. A v7 save keeps
 * everything and starts with no recorded visits, no grants and no prestige. A v7 or v8 save
 * starts with no decor, nothing placed and an empty move log. A v7 to v9 save starts at home
 * with a fresh transit generator. A v7 to v10 save starts counting actions at 0. Every older save
 * then gets its goals derived from what it holds, at its current minute (`syncGoals`): a save
 * already at Icon starts with an unacknowledged Icon moment. Anything older or malformed
 * starts fresh. A save from a newer build throws `NewerSaveError`: it is
 * not loaded, and not overwritten unless the player plays on.
 */
export function migrateSave(persisted: unknown, version: number, config: EngineConfig): Migration {
  if (version > SAVE_VERSION) {
    throw new NewerSaveError(version)
  }
  const fresh = initialSave(config)
  const freshEvents = initialEventsState()
  let loaded: LoadResult | null = null
  if (version === 1) {
    const v1 = SaveV1Schema.safeParse(persisted)
    if (v1.success) {
      return {
        save: { ...fresh, player: { ...fresh.player, cash: v1.data.player.cash } },
        outcome: 'carried',
      }
    }
  }
  if (version === 2) {
    const v2 = LoadableSaveV2Schema.safeParse(persisted)
    if (v2.success) {
      loaded = loadV6(
        {
          ...v2.data,
          player: {
            ...v2.data.player,
            clout: 0,
            home: config.startHome,
            rent: initialRent,
            inventory: emptyInventory,
            clubNights: {},
          },
          events: freshEvents,
        },
        config,
      )
    }
  }
  if (version === 3) {
    const v3 = LoadableSaveV3Schema.safeParse(persisted)
    if (v3.success) {
      loaded = loadV6(
        {
          ...v3.data,
          player: { ...v3.data.player, inventory: emptyInventory, clubNights: {} },
          events: freshEvents,
        },
        config,
      )
    }
  }
  if (version === 4) {
    const v4 = LoadableSaveV4Schema.safeParse(persisted)
    if (v4.success) {
      loaded = loadV6(
        { ...v4.data, player: { ...v4.data.player, clubNights: {} }, events: freshEvents },
        config,
      )
    }
  }
  if (version === 5) {
    const v5 = LoadableSaveV5Schema.safeParse(persisted)
    if (v5.success) {
      loaded = loadV6({ ...v5.data, player: { ...v5.data.player, clubNights: {} } }, config)
    }
  }
  if (version === 6) loaded = loadV6(persisted, config)
  // A v7 to v10 save is the current structure without the S15 (v7), S16 (v8), S08 (v9) or
  // S18c (v10) fields, which `loadSave` fills in.
  if (version >= 7 && version <= 10) loaded = loadSave(persisted, config)
  if (loaded?.ok === true) {
    return { save: syncGoals(loaded.save, config).save, outcome: 'carried' }
  }
  return { save: fresh, outcome: 'fresh' }
}
