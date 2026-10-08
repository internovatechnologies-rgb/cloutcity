/**
 * Clout (S13): levels, the clout ledger, item clout, style and level-ups.
 *
 * A player's total clout is derived, never stored as one number:
 *
 *   total = earned + item clout + home clout + min(premium, clout.caps.byCurrency.usd)
 *
 * Levels read the total, except Icon (the victory goal's level), which also needs goal clout
 * (earned minus granted, plus items and home, never premium) at its threshold: `levelClout`.
 *
 * - `earned` is the sum of the ledger's in-game sources (paycheck, flex, club, event, grant,
 *   legacy, repair). It never drops below 0.
 * - Item clout is the `cloutValue` of every wearable owned right now (gifts excluded). It is
 *   computed, never accumulated, so a buy/sell loop cannot farm it: selling takes the clout
 *   away again. Buying and selling still write `item` ledger entries, as an audit trail only.
 * - Home clout (S16) is the home's score (its base score plus placed decor) capped at
 *   `home.maxClout`, computed from the save like item clout (src/engine/home.ts `homeClout`).
 * - Premium clout (S25, real-money items, currency `usd`) counts only up to the cap, which
 *   the balance schema keeps below the top level: premium clout alone never reaches Icon.
 *
 * Every clout change goes through `recordClout`, which writes one typed entry (source, amount,
 * currency, and a reference to what earned it) so later systems (premium items in S25, grants
 * in S15, save plausibility in S18c) plug in without engine changes. The outfit's style score
 * multiplies positive gains from the sources in `clout.style.appliesTo`.
 *
 * Levels can drop (selling an item, a bad event); `peakLevel` remembers the highest level
 * reached, and a level-up is reported only when a change lifts the player above it, so
 * selling and rebuying can never replay one.
 */
import { CLOUT_SOURCES, type CloutSourceId } from '@/lib/data/cloutSources'
import type { Borough } from '@/lib/data/schemas/content'
import type { EngineConfig, JobId } from './config'
import type { GameSnapshot, PlayerState } from './game'
import { homeClout } from './home'

export { CLOUT_SOURCES }
export type { CloutSourceId }

export interface CloutLevel {
  /** A `clout.levels` id, e.g. `nobody`. */
  readonly id: string
  /** 0-based position in `clout.levels` (0 is the lowest level). */
  readonly index: number
  readonly minClout: number
}

/** The highest level whose `minClout` the player holds (the lowest level for 0 clout). */
export function cloutLevel(clout: number, config: EngineConfig): CloutLevel {
  const { levels } = config.clout
  let index = 0
  levels.forEach((level, i) => {
    if (clout >= level.minClout) index = i
  })
  const level = levels[index]
  if (level === undefined) throw new Error('clout.levels is empty')
  return { id: level.id, index, minClout: level.minClout }
}

/** The level with id `levelId`, or undefined when config has no such level. */
export function findCloutLevel(levelId: string, config: EngineConfig): CloutLevel | undefined {
  const index = config.clout.levels.findIndex((level) => level.id === levelId)
  const level = config.clout.levels[index]
  return level === undefined ? undefined : { id: level.id, index, minClout: level.minClout }
}

/** `usd` is premium (real-money) clout; everything earned in play is `cash`. */
export type CloutCurrency = 'cash' | 'usd'

/** What each source records about the change it made. */
export interface CloutRefs {
  readonly paycheck: { readonly jobId: string }
  readonly flex: {
    readonly placeId: string
    readonly viral: boolean
    /** The place's flex multiplier the gain was scaled by. */
    readonly placeMultiplier: number
    /** The outfit's style score at the time. */
    readonly styleScore: number
    /** The gain before the place and style multipliers. */
    readonly base: number
  }
  readonly club: { readonly venueId: string; readonly night: number }
  readonly event: { readonly eventId: string; readonly choiceId: string }
  /** The grant's idempotency key (src/engine/grants.ts); goal clout subtracts grant clout. */
  readonly grant: { readonly grantKey: string }
  readonly legacy: Readonly<Record<string, never>>
  readonly repair: Readonly<Record<string, never>>
  /** Audit only: item clout is computed from what is owned. */
  readonly item: { readonly itemId: string; readonly op: 'buy' | 'sell' | 'grant' | 'consume' }
  readonly premium: { readonly itemId: string; readonly op: 'grant' | 'revoke' }
}

/** A clout change to record: whole points (signed) before any multiplier or clamp. */
export type CloutChange = {
  readonly [S in CloutSourceId]: {
    readonly source: S
    readonly amount: number
    readonly ref: CloutRefs[S]
  }
}[CloutSourceId]

/** One ledger entry: what a change actually did. */
export type CloutEntry = {
  readonly [S in CloutSourceId]: {
    /** Increases by one per entry, never reused. */
    readonly seq: number
    /** Personal-clock minute it was recorded. */
    readonly at: number
    /** The signed whole points actually applied (after multipliers and clamping). */
    readonly amount: number
    readonly currency: CloutCurrency
    readonly source: S
    readonly ref: CloutRefs[S]
  }
}[CloutSourceId]

export interface CloutState {
  /** Newest last, at most `clout.ledger.maxEntries`; older entries fold into `compacted`. */
  readonly ledger: readonly CloutEntry[]
  /** Entries folded out of the ledger: how many, and their amounts summed by source. */
  readonly compacted: {
    readonly entries: number
    readonly bySource: Readonly<Partial<Record<CloutSourceId, number>>>
  }
  /** The `seq` the next entry gets. */
  readonly nextSeq: number
  /** Index of the highest level ever reached (level-ups are reported only above it). */
  readonly peakLevel: number
  /** True once the first paycheck's clout has been paid. */
  readonly firstPaycheckPaid: boolean
}

export const initialCloutState: CloutState = {
  ledger: [],
  compacted: { entries: 0, bySource: {} },
  nextSeq: 1,
  peakLevel: 0,
  firstPaycheckPaid: false,
}

/**
 * A clout state holding `earned` points carried over as one folded `legacy` entry (a save
 * from before the ledger), with `peakLevel` as given.
 */
export function legacyCloutState(earned: number, peakLevel: number): CloutState {
  if (!Number.isSafeInteger(earned) || earned < 0) {
    throw new RangeError(`Legacy clout must be a whole, non-negative number: ${earned}`)
  }
  return {
    ...initialCloutState,
    compacted:
      earned > 0 ? { entries: 1, bySource: { legacy: earned } } : initialCloutState.compacted,
    peakLevel,
  }
}

export function currencyOf(source: CloutSourceId): CloutCurrency {
  return source === 'premium' ? 'usd' : 'cash'
}

/** Sources whose entries are an audit trail only and never count toward the total. */
const AUDIT_ONLY: ReadonlySet<CloutSourceId> = new Set(['item'])

export interface CloutSums {
  /** In-game sources (`cash` currency, item audit excluded). Never below 0. */
  readonly earned: number
  /** Premium (`usd`) clout before the cap. */
  readonly premium: number
  /** Every entry ever recorded, summed by source (item audit included). */
  readonly bySource: Readonly<Partial<Record<CloutSourceId, number>>>
}

/** The ledger summed: compacted totals plus every kept entry. */
export function cloutSums(state: CloutState): CloutSums {
  const bySource: Partial<Record<CloutSourceId, number>> = { ...state.compacted.bySource }
  for (const entry of state.ledger) {
    bySource[entry.source] = (bySource[entry.source] ?? 0) + entry.amount
  }
  let earned = 0
  let premium = 0
  for (const source of CLOUT_SOURCES) {
    const amount = bySource[source] ?? 0
    if (currencyOf(source) === 'usd') premium += amount
    else if (!AUDIT_ONLY.has(source)) earned += amount
  }
  return { earned, premium, bySource }
}

function catalogItem(itemId: string, config: EngineConfig) {
  return config.items.catalog.find((item) => item.id === itemId)
}

/**
 * The `cloutValue` of every wearable the player owns (worn or not). Gifts never count, nor do
 * wearables kept through prestige (looks only).
 */
export function itemClout(player: Pick<PlayerState, 'inventory'>, config: EngineConfig): number {
  return player.inventory.wearables.reduce(
    (sum, owned) =>
      owned.prestigeKept === true
        ? sum
        : sum + (catalogItem(owned.itemId, config)?.cloutValue ?? 0),
    0,
  )
}

/** The outfit's style score: the `styleValue` of every item worn right now (kept looks add 0). */
export function styleScore(player: Pick<PlayerState, 'inventory'>, config: EngineConfig): number {
  const kept = new Set(
    player.inventory.wearables.filter((owned) => owned.prestigeKept === true).map((o) => o.itemId),
  )
  return Object.values(player.inventory.outfit).reduce(
    (sum, itemId) =>
      sum +
      (itemId === undefined || kept.has(itemId)
        ? 0
        : (catalogItem(itemId, config)?.styleValue ?? 0)),
    0,
  )
}

/** Whole percent a style score multiplies gains by: 100 plus the capped bonus. */
export function styleMultiplierPct(score: number, config: EngineConfig): number {
  const { pctPerPoint, maxBonusPct } = config.clout.style
  return 100 + Math.min(maxBonusPct, Math.max(0, score) * pctPerPoint)
}

/** What the level and goal measures read: the ledger, the inventory and the home. */
export type CloutPlayer = Pick<PlayerState, 'clout' | 'inventory' | 'home' | 'apartment'>

export interface CloutBreakdown {
  readonly earned: number
  readonly items: number
  /** Home clout (capped; src/engine/home.ts). */
  readonly home: number
  /** Premium clout as it counts (capped). */
  readonly premium: number
  /** Premium clout before the cap. */
  readonly premiumRaw: number
  readonly total: number
}

export function cloutBreakdown(player: PlayerState, config: EngineConfig): CloutBreakdown {
  const sums = cloutSums(player.clout)
  const items = itemClout(player, config)
  const home = homeClout(player, config)
  const premium = Math.min(sums.premium, config.clout.caps.byCurrency.usd)
  return {
    earned: sums.earned,
    items,
    home,
    premium,
    premiumRaw: sums.premium,
    total: sums.earned + items + home + premium,
  }
}

/** The player's clout: what the HUD counts and what event conditions read. */
export function totalClout(player: PlayerState, config: EngineConfig): number {
  return cloutBreakdown(player, config).total
}

/**
 * The clout goals measure (S15, ECON-1): earned clout without what grants added, plus item and
 * home clout, never premium. Never below 0 (a loss can eat into granted clout).
 */
export function goalClout(player: CloutPlayer, config: EngineConfig): number {
  const sums = cloutSums(player.clout)
  return (
    Math.max(0, sums.earned - (sums.bySource.grant ?? 0)) +
    itemClout(player, config) +
    homeClout(player, config)
  )
}

/**
 * The level only earned clout opens ("Icon is earned", S15 fix cycle 1): the level of the
 * victory goal (data/config/progression.json), or null when this config has none of its levels.
 */
export function earnedOnlyLevel(config: EngineConfig): CloutLevel | null {
  const victory = config.goals.find((goal) => goal.victory === true)
  return victory?.level === undefined ? null : (findCloutLevel(victory.level, config) ?? null)
}

/**
 * The clout a player's level is judged on. Every level up to the one below Icon reads the total
 * (earned, items, home, capped premium and grants); Icon also needs goal clout (`goalClout`) at its
 * threshold, so grants and premium can carry a player to the edge of Icon but never over it.
 * Below that, this is the total held just under Icon. Gates read it, so `cloutLevel` of it is
 * always `playerLevel`.
 */
export function levelClout(player: CloutPlayer, config: EngineConfig): number {
  const sums = cloutSums(player.clout)
  const total =
    sums.earned +
    itemClout(player, config) +
    homeClout(player, config) +
    Math.min(sums.premium, config.clout.caps.byCurrency.usd)
  const earnedOnly = earnedOnlyLevel(config)
  if (earnedOnly === null || total < earnedOnly.minClout) return total
  return goalClout(player, config) >= earnedOnly.minClout ? total : earnedOnly.minClout - 1
}

/** The player's current clout level (Icon only on earned clout: see `levelClout`). */
export function playerLevel(player: CloutPlayer, config: EngineConfig): CloutLevel {
  return cloutLevel(levelClout(player, config), config)
}

export interface CloutProgress {
  readonly total: number
  /**
   * The clout the meter counts toward `next`: the total, except when the total has reached the
   * earned-only level (Icon) but goal clout has not, where it is goal clout, so the bar shows
   * how far earned clout still has to go instead of sitting full.
   */
  readonly counted: number
  readonly level: CloutLevel
  /** The next level up, or null at the top level. */
  readonly next: CloutLevel | null
  /** Counted clout above the current level's threshold (0 when goal clout is below it). */
  readonly intoLevel: number
  /** Clout between the current level's threshold and the next one's (0 at the top). */
  readonly levelSpan: number
  /** Whole percent of the way to the next level, 0..100 (100 at the top). */
  readonly pct: number
  readonly atMax: boolean
}

/**
 * How far the player is toward the next level (the HUD meter). Toward Icon, once the total holds
 * Icon's threshold, progress counts goal clout: grants and premium never fill the Icon bar.
 */
export function cloutProgress(player: PlayerState, config: EngineConfig): CloutProgress {
  const total = totalClout(player, config)
  const level = playerLevel(player, config)
  const nextDef = config.clout.levels[level.index + 1]
  if (nextDef === undefined) {
    const intoLevel = total - level.minClout
    return {
      total,
      counted: total,
      level,
      next: null,
      intoLevel,
      levelSpan: 0,
      pct: 100,
      atMax: true,
    }
  }
  const next = { id: nextDef.id, index: level.index + 1, minClout: nextDef.minClout }
  const counted = total >= next.minClout ? goalClout(player, config) : total
  const intoLevel = Math.max(0, counted - level.minClout)
  const levelSpan = next.minClout - level.minClout
  const pct = Math.min(100, Math.max(0, Math.floor((intoLevel * 100) / levelSpan)))
  return { total, counted, level, next, intoLevel, levelSpan, pct, atMax: false }
}

/** What reaching a level opens up, from config. */
export interface LevelUnlocks {
  readonly boroughs: readonly Borough[]
  readonly jobs: readonly JobId[]
  readonly clubs: readonly string[]
}

/**
 * What caused a level-up: a clout source, or `home` for a change to the home score (placing
 * decor, moving home), which writes no ledger entry (src/engine/home.ts).
 */
export type LevelUpSource = CloutSourceId | 'home'

export interface LevelUp {
  /**
   * The highest level reached before this change (the old peak). It can be above the level
   * the player held just before the change, when they had dropped back since.
   */
  readonly fromPeak: string
  readonly to: string
  readonly toIndex: number
  /** Personal-clock minute of the change. */
  readonly at: number
  readonly source: LevelUpSource
  /** Everything gated on any level newly reached (above the old peak, up to `to`). */
  readonly unlocks: LevelUnlocks
}

function unlocksBetween(fromIndex: number, toIndex: number, config: EngineConfig): LevelUnlocks {
  const reached = new Set(config.clout.levels.slice(fromIndex + 1, toIndex + 1).map((l) => l.id))
  const boroughs = (Object.keys(config.boroughs) as Borough[]).filter((id) => {
    const rule = config.boroughs[id]
    return rule.access === 'clout' && reached.has(rule.level)
  })
  const jobs = (Object.keys(config.jobs.requiredCloutLevel) as JobId[]).filter((id) => {
    const level = config.jobs.requiredCloutLevel[id]
    return level !== undefined && reached.has(level)
  })
  const clubs = Object.entries(config.place.clubs)
    .filter(([, rule]) => reached.has(rule.minCloutLevel))
    .map(([id]) => id)
  return { boroughs, jobs, clubs }
}

/** The whole percent a place multiplier scales a gain by (1.25 → 125). */
function multiplierPct(multiplier: number): number {
  return Math.round(multiplier * 100)
}

function placeMultiplierOf(change: CloutChange): number {
  return change.source === 'flex' ? change.ref.placeMultiplier : 1
}

/**
 * The gain a positive `base` turns into: max(1, floor(base x place multiplier x style
 * percent / 100)), the style percent applying only to sources in `clout.style.appliesTo`.
 * Integer maths on whole percentages, so the floor is exact. Shared by `recordClout` and the
 * place sheet's preview (GR-11: what the sheet promises is what lands).
 */
export function scaledGain(
  base: number,
  source: CloutSourceId,
  placeMultiplier: number,
  player: PlayerState,
  config: EngineConfig,
): number {
  if (base <= 0) return base
  const styled = (config.clout.style.appliesTo as readonly string[]).includes(source)
  const stylePct = styled ? styleMultiplierPct(styleScore(player, config), config) : 100
  return Math.max(1, Math.floor((base * multiplierPct(placeMultiplier) * stylePct) / 10_000))
}

export interface CloutRecord {
  readonly player: PlayerState
  /** The entry written, or null when the change applied nothing (0, or clamped to 0). */
  readonly entry: CloutEntry | null
  /** Set when the player passed their highest level so far. */
  readonly levelUp: LevelUp | null
}

/** Folds the oldest entries past `maxEntries` into the per-source totals. */
function compact(state: CloutState, maxEntries: number): CloutState {
  const excess = state.ledger.length - maxEntries
  if (excess <= 0) return state
  const bySource: Partial<Record<CloutSourceId, number>> = { ...state.compacted.bySource }
  for (const entry of state.ledger.slice(0, excess)) {
    bySource[entry.source] = (bySource[entry.source] ?? 0) + entry.amount
  }
  return {
    ...state,
    ledger: state.ledger.slice(excess),
    compacted: { entries: state.compacted.entries + excess, bySource },
  }
}

/**
 * Lifts `peakLevel` to the player's current level and reports a level-up when that is above
 * the old peak. The player must already hold every change (ledger and inventory).
 */
export function settleLevel(
  player: PlayerState,
  at: number,
  source: LevelUpSource,
  config: EngineConfig,
): { readonly player: PlayerState; readonly levelUp: LevelUp | null } {
  const level = playerLevel(player, config)
  const peak = player.clout.peakLevel
  if (level.index <= peak) return { player, levelUp: null }
  const before = config.clout.levels[Math.min(peak, config.clout.levels.length - 1)]
  return {
    player: { ...player, clout: { ...player.clout, peakLevel: level.index } },
    levelUp: {
      fromPeak: before?.id ?? level.id,
      to: level.id,
      toIndex: level.index,
      at,
      source,
      unlocks: unlocksBetween(peak, level.index, config),
    },
  }
}

/**
 * Records one clout change and returns the player with it applied. Positive changes are
 * scaled (`scaledGain`); negative ones are clamped so earned and premium clout never drop
 * below 0. The entry stores what was actually applied. The snapshot's clock gives the
 * entry's minute; its player must already hold any inventory change the entry audits.
 */
export function recordClout(
  snapshot: GameSnapshot,
  change: CloutChange,
  config: EngineConfig,
): CloutRecord {
  if (!Number.isSafeInteger(change.amount)) {
    throw new RangeError(`A clout change must be a whole number: ${change.amount}`)
  }
  const { player } = snapshot
  const amount = scaledGain(change.amount, change.source, placeMultiplierOf(change), player, config)
  const appended = appendClout(
    player.clout,
    { ...change, amount } as CloutChange,
    snapshot.clock.minute,
    config,
  )
  const next = appended.entry === null ? player : { ...player, clout: appended.state }
  const settled = settleLevel(next, snapshot.clock.minute, change.source, config)
  return { player: settled.player, entry: appended.entry, levelUp: settled.levelUp }
}

/**
 * Appends `change` to the ledger at face value (no multiplier): the low-level step under
 * `recordClout`, also used to carry old saves over. A loss is clamped so earned and premium
 * clout never drop below 0; nothing is written when the amount applied is 0. Levels are not
 * checked (see `settleLevel`).
 */
export function appendClout(
  state: CloutState,
  change: CloutChange,
  at: number,
  config: EngineConfig,
): { readonly state: CloutState; readonly entry: CloutEntry | null } {
  if (!Number.isSafeInteger(change.amount)) {
    throw new RangeError(`A clout change must be a whole number: ${change.amount}`)
  }
  let amount = change.amount
  if (amount < 0 && !AUDIT_ONLY.has(change.source)) {
    const sums = cloutSums(state)
    const floor = currencyOf(change.source) === 'usd' ? sums.premium : sums.earned
    amount = Math.max(amount, -floor)
  }
  if (amount === 0) return { state, entry: null }
  const entry = {
    seq: state.nextSeq,
    at,
    amount,
    currency: currencyOf(change.source),
    source: change.source,
    ref: change.ref,
  } as CloutEntry
  const appended = { ...state, ledger: [...state.ledger, entry], nextSeq: state.nextSeq + 1 }
  return { state: compact(appended, config.clout.ledger.maxEntries), entry }
}

/** Theoretical clout ceilings for one source. */
export interface CloutCeiling {
  readonly perAction: number
  readonly perGameDay: number
}

export interface CloutCeilings {
  readonly bySource: Readonly<Partial<Record<CloutSourceId, CloutCeiling>>>
  /** The most item clout a player can hold: every wearable owned at once. */
  readonly itemCloutMax: number
  /** The most home clout a player can hold (`home.maxClout`). */
  readonly homeCloutMax: number
  /** Premium clout as it counts, at most. */
  readonly premiumCap: number
}

const MINUTES_PER_DAY = 24 * 60

/**
 * The most times `event` can fire in one game day: once ever when it is `once`, otherwise every
 * cooldown, counting both ends of the day. Shared by the clout and cash ceilings (S18c).
 */
export function eventFiresPerGameDay(
  event: EngineConfig['events']['catalog'][number],
  config: EngineConfig,
): number {
  if (event.once === true) return 1
  const cooldown = Math.max(1, event.cooldownMin ?? config.events.defaultCooldownMin)
  return Math.floor(MINUTES_PER_DAY / cooldown) + 1
}

/**
 * The most clout each source can give in one action and in one game day, from config alone
 * (top style, the highest place multiplier, a viral flex, every club, every event at its
 * cooldown). S18c's save plausibility uses max(fixture x margin, these ceilings): the economy
 * bot's fixture (data/sim) shows what a normal run reaches, these bound what any run can.
 */
export function cloutCeilings(config: EngineConfig): CloutCeilings {
  const { clout, place } = config
  const topStylePct = 100 + clout.style.maxBonusPct
  const styled = (source: CloutSourceId) =>
    (clout.style.appliesTo as readonly string[]).includes(source) ? topStylePct : 100
  const scale = (base: number, source: CloutSourceId, multiplier = 1) =>
    base <= 0
      ? 0
      : Math.max(1, Math.floor((base * multiplierPct(multiplier) * styled(source)) / 10_000))

  const paycheck = scale(clout.sources.firstPaycheck, 'paycheck')
  const topPlace = Math.max(
    place.flexMultiplier.default,
    ...Object.values(place.flexMultiplier.byLandmark),
  )
  const flexBase = clout.flex.baseClout * clout.flex.viral.cloutMultiplier
  const flex = scale(flexBase, 'flex', topPlace)

  const clubGains = Object.values(place.clubs).map((rule) => scale(rule.cloutGain, 'club'))
  // A club night is keyed by the day it opened, so one game day can hold the end of last
  // night and the start of tonight: two paid entries per club.
  const club = {
    perAction: Math.max(0, ...clubGains),
    perGameDay: 2 * clubGains.reduce((a, b) => a + b, 0),
  }

  let eventPerAction = 0
  let eventPerDay = 0
  for (const event of config.events.catalog) {
    const best = Math.max(
      0,
      ...event.choices.map((choice) =>
        choice.effects.reduce(
          (sum, effect) => (effect.kind === 'clout' ? sum + effect.amount : sum),
          0,
        ),
      ),
    )
    const gain = scale(best, 'event')
    eventPerAction = Math.max(eventPerAction, gain)
    eventPerDay += gain * eventFiresPerGameDay(event, config)
  }

  const wearableClout = config.items.catalog
    .filter((item) => item.category === 'clothing' || item.category === 'makeup')
    .map((item) => item.cloutValue)

  return {
    bySource: {
      paycheck: { perAction: paycheck, perGameDay: paycheck },
      flex: { perAction: flex, perGameDay: flex * clout.flex.maxPerGameDay },
      club,
      event: { perAction: eventPerAction, perGameDay: eventPerDay },
    },
    itemCloutMax: wearableClout.reduce((a, b) => a + b, 0),
    homeCloutMax: config.home.maxClout,
    premiumCap: clout.caps.byCurrency.usd,
  }
}
