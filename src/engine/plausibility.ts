/**
 * Save plausibility (S18c): the server's check of an uploaded save against the last save it
 * accepted. Pure: the server passes the previous save, real time, the
 * account's age, the grant keys and entitlements the server holds, and the ceilings.
 *
 * `checkUpload` runs every check, in this order, and returns one verdict:
 *
 * 1. structural: the upload must parse as a current save (`createSaveSchema`), else reject.
 * 2. goals vs facts (SEC-9): a goal newly reached must have its fact in the save (the first
 *    paycheck paid, an outfit bought, a landmark visited, a club night, goal clout that reached
 *    the level), else the goal is dropped (repair).
 * 3. prestige and badges: the run history must be whole (runs 1..n, each with its badge, the
 *    current run n + 1), else reject; a badge needs a finished run or this run's victory claim,
 *    else it is dropped (repair).
 * 4. kept items (SEC-10): a wearable bought before the last prestige, or kept in the previous
 *    save, is a look only (`prestigeKept`), else it is marked again (repair).
 * 5. peak level: never above what the run could have reached, never Icon without goal clout for
 *    it (DEC-13; at Icon now, the save schema already refuses it), never below the current level
 *    (NOTE-7); else it is set (repair).
 * 6. premium: premium clout needs a server entitlement for its item, else it is dropped (repair).
 * 7. grants: every record the server has not accepted is re-validated (its key, goal, run,
 *    configured reward, caps, eligibility) and the clout ledger's grant clout must match the
 *    records; a re-claimed, forged or mismatched grant rejects. Valid new records are returned
 *    to insert (`grantsToInsert`).
 * 8. monotonic fields: the clock, run, sequence numbers, prestige history and badges never go
 *    back; within a run neither do the action count, the first paycheck, club nights, today's
 *    flexes, visits or event cooldowns; else reject.
 * 9. pace (DEC-19): the taps the window counted (`SaveState.actions`, and the clout entries it
 *    wrote) fit the real time at the tap rate, and the clock moved no further than passive time
 *    at the fastest speed plus the longest action per counted tap; else reject.
 * 10. clout rate: per source, what the window added is within the per-entry and per-game-day
 *    ceilings and at most one entry's worth per counted tap; else reject.
 * 11. cash flow: cash is at most the previous cash plus the income ceilings (per game day, and
 *    one action's worth per counted tap), valid grants and what was sold, less what was bought
 *    (items, a move); else reject.
 * 12. public level: the level others see is capped by what the account's age allows at
 *    `publicCloutPerRealMinute`. A public level behind the save's is only a delay.
 * 13. honest pace: what play brought in since the last accept (cash and clout) fits the counted
 *    taps at the most one tap can earn under config (the best wage the reached level unlocks or
 *    event cash; the best single-action clout), plus a per-player credit the server carries
 *    (`checkHonestPace`); else reject.
 *
 * Real time only ever tightens a check of an upload that has a previous save: the first upload
 * (which may carry offline play from before the account existed) is never rejected for real-time
 * reasons; its public level is capped by the account's age instead. The real time a window may
 * use is the time since the last accept plus a burst credit the server carries from upload to
 * upload (a token bucket of at most `burstRealMinutes`): what one upload's slack did not use is
 * all the next one gets, so uploading often never adds slack.
 *
 * Ceilings are `max(fixture x margin, theoretical)` (`plausibilityCeilings`); the honest-pace
 * terms are derived from config alone (H-1R), with the fixture's measured pace as a regression
 * guard that must sit below them. The economy bot's
 * fixture (data/sim, passed in as data) shows what normal play reaches, the theoretical ceilings
 * (src/engine/clout.ts `cloutCeilings`, `cashCeilings` below) bound what any play can. Ledger
 * detail older than the ledger keeps is folded into sums (ECON-2), so the checks work from sums
 * and entry counts, never from a full history.
 */
import type { CloutSourceId } from '@/lib/data/cloutSources'
import type { SyncConfig } from '@/lib/data/schemas/config'
import { calendar, minutesPerDay } from './clock'
import {
  cloutCeilings,
  cloutLevel,
  cloutSums,
  earnedOnlyLevel,
  eventFiresPerGameDay,
  findCloutLevel,
  goalClout,
  playerLevel,
  totalClout,
  type CloutState,
} from './clout'
import { transitBalance, type EngineConfig, type GoalDef } from './config'
import { victoryGoal } from './goals'
import {
  goalGrantKey,
  goalReward,
  grantCeilings,
  prestigeBadge,
  type GrantCeilings,
  type GrantRecord,
} from './grants'
import { moveInCost } from './housing'
import { homeClout } from './home'
import { emptyInventory, findItem, isDecor, isPrestigeKept, type Inventory } from './items'
import { jobIds, shiftWage } from './jobs'
import { rentFor } from './rent'
import { applyRepairs, type Repair } from './repairs'
import { createSaveSchema, type SaveState } from './save'

export { applyRepairs, type Repair } from './repairs'

const MINUTES_PER_HOUR = 60

/** What one source can give: per action (a counted tap) and per game day. */
export interface RateCeiling {
  readonly perAction: number
  readonly perGameDay: number
}

/** Clout sources earned by play, checked against rate ceilings. */
export const RATED_SOURCES = ['paycheck', 'flex', 'club', 'event'] as const
export type RatedSource = (typeof RATED_SOURCES)[number]

/** Cash ceilings from config alone. */
export interface CashCeilings {
  /** The best-paid job's shift, and as many shifts as fit in a game day. */
  readonly shift: { readonly perAction: number; readonly perGameDay: number }
  /** The best cash any event choice pays, and every event at its cooldown for a day. */
  readonly event: { readonly perAction: number; readonly perGameDay: number }
  /** The most cash one grant can pay. */
  readonly grant: { readonly perGrant: number }
}

/** The clout level index a job needs (0 for an entry job). */
function jobLevelIndex(jobId: string, config: EngineConfig): number {
  const required = (config.jobs.requiredCloutLevel as Readonly<Record<string, string>>)[jobId]
  if (required === undefined) return 0
  const index = config.clout.levels.findIndex((level) => level.id === required)
  return index < 0 ? 0 : index
}

/**
 * The most cash play can bring in, from config alone: the top shift wage (every job, locked ones
 * included) times the shifts a game day holds, the best event cash times the times each event can
 * fire in a day, and the largest grant.
 */
export function cashCeilings(config: EngineConfig): CashCeilings {
  const topWage = Math.max(0, ...jobIds(config).map((id) => shiftWage(id, config)))
  const shiftsPerDay = Math.floor(
    minutesPerDay(config) / (config.jobs.shiftHours * MINUTES_PER_HOUR),
  )
  let eventPerAction = 0
  let eventPerDay = 0
  for (const event of config.events.catalog) {
    const best = Math.max(
      0,
      ...event.choices.map((choice) =>
        choice.effects.reduce(
          (sum, effect) => (effect.kind === 'cash' ? sum + effect.amount : sum),
          0,
        ),
      ),
    )
    eventPerAction = Math.max(eventPerAction, best)
    eventPerDay += best * eventFiresPerGameDay(event, config)
  }
  return {
    shift: { perAction: topWage, perGameDay: topWage * shiftsPerDay },
    event: { perAction: eventPerAction, perGameDay: eventPerDay },
    grant: { perGrant: grantCeilings(config).perGrant.cash },
  }
}

/**
 * The parts of the economy fixture (data/sim/economy-baseline.derived.json, `EconomyBaseline`)
 * the ceilings read. The server passes the validated file in; the engine never imports data/sim.
 */
export interface PlausibilityFixture {
  readonly cash: { readonly maxGainPerAction: number; readonly maxGainPerGameDay: number }
  readonly clout: {
    readonly maxGainPerGameDay: number
    readonly sources: Readonly<Record<string, number>>
  }
  /** Gain per tap over a whole bot run, the highest bot's (honest pace, DEC-19). */
  readonly pace: { readonly cashPerTap: number; readonly cloutPerTap: number }
}

/** Cash and clout amounts, for the honest-pace terms. */
export interface CashClout {
  readonly cash: number
  readonly clout: number
}

export interface PlausibilityCeilings {
  readonly clout: Readonly<Record<RatedSource, RateCeiling>>
  /** Cash from play (shifts and events). Grants are re-validated one by one instead. */
  readonly cash: RateCeiling
  readonly grants: GrantCeilings
  /** Every wearable's clout at once. */
  readonly itemCloutMax: number
  /** Premium clout as it counts, at most. */
  readonly premiumCap: number
  /** Taps per real minute; each writes at most one clout ledger entry. */
  readonly actionsPerRealMinute: number
  /** The most burst credit (real minutes) a window can carry (an upload lags the play it carries). */
  readonly burstRealMinutes: number
  /** Game minutes passive time adds per real minute at the fastest clock speed. */
  readonly passiveGameMinutesPerRealMinute: number
  /** The most game minutes one counted tap can move the clock (`maxActionGameMinutes`). */
  readonly maxActionGameMinutes: number
  /**
   * Honest pace (DEC-19, H-1R): the most one counted tap can earn, derived from config so honest
   * play cannot exceed it by construction: cash, the best shift wage of any job or the best event
   * cash; clout, the best single action of any rated source (a viral flex at the top multiplier, a
   * club night, an event). Earnings since the last accept must fit the taps at this pace plus the
   * pace credit. Sales and grants are accounted apart (the cash-flow trade path, grant records).
   * The economy fixture's measured pace (`PlausibilityFixture.pace`) must sit below it.
   */
  readonly pacePerTap: CashClout
  /**
   * The cash part of `pacePerTap` at each clout level (by index): only the jobs that level has
   * unlocked count, so a player below a job's gate is held to the jobs it can work.
   */
  readonly cashPerTapByLevel: readonly number[]
  /**
   * The most pace credit a player can carry (a token bucket per player, kept by the server): one
   * game day's worth at the per-game-day ceilings, so a lucky day (viral flexes, a club night)
   * never waits for credit; past it, only counted taps at the honest pace refill it.
   */
  readonly paceCreditCap: CashClout
  /**
   * Clout honest play can show other players per real minute of account age (the public level
   * cap). Set apart from the upload pace on purpose (`sync.plausibility.publicCloutPerRealMinute`).
   */
  readonly publicCloutPerRealMinute: number
}

/**
 * The most game minutes one counted tap can move the personal clock, from config: the longest
 * duration any action, place action, shift or event choice has, at the worst stat penalties
 * (every stat at 0 slows actions down), or the longest trip with its longest delay (S08).
 */
export function maxActionGameMinutes(config: EngineConfig): number {
  let longest = config.jobs.shiftHours * MINUTES_PER_HOUR
  const seen = new Set<unknown>()
  const visit = (value: unknown): void => {
    if (typeof value !== 'object' || value === null || seen.has(value)) return
    seen.add(value)
    for (const [key, child] of Object.entries(value)) {
      if (key === 'durationMin' && typeof child === 'number') longest = Math.max(longest, child)
      else visit(child)
    }
  }
  visit(config.actions)
  visit(config.place)
  visit(config.clout)
  for (const event of config.events.catalog) {
    for (const choice of event.choices) {
      const minutes = choice.effects.reduce(
        (sum, effect) => (effect.kind === 'time' ? sum + effect.minutes : sum),
        0,
      )
      longest = Math.max(longest, minutes)
    }
  }
  const slowest = Object.values(config.stats.atZero).reduce(
    (product, rule) => product * rule.durationMultiplier,
    1,
  )
  // A trip (S08) is one tap too: the trip itself is capped at `actions.maxDurationMin` with the
  // slowdown already applied (src/engine/transit/travel.ts `tripTooLong`), and a delay adds to it.
  const trip = config.actions.maxDurationMin + transitBalance.delay.minutes.max
  return Math.max(Math.ceil(longest * slowest), trip)
}

/**
 * The ceilings `checkUpload` uses: for each term, max(fixture x margin, theoretical). Real time
 * bounds the taps (`actionsPerRealMinute`) and passive time; earnings follow from the taps.
 */
export function plausibilityCeilings(
  config: EngineConfig,
  fixture: PlausibilityFixture,
  sync: Pick<SyncConfig, 'plausibility'>,
): PlausibilityCeilings {
  const { margin, maxActionsPerRealMinute, burstRealMinutes, publicCloutPerRealMinute } =
    sync.plausibility
  const theory = cloutCeilings(config)
  const cash = cashCeilings(config)
  const rate = (perAction: number, perGameDay: number): RateCeiling => ({ perAction, perGameDay })
  const cloutRate = (source: RatedSource): RateCeiling => {
    const ceiling = theory.bySource[source] ?? { perAction: 0, perGameDay: 0 }
    const seen = fixture.clout.sources[source]
    return rate(
      Math.max(ceiling.perAction, (seen ?? 0) * margin),
      Math.max(
        ceiling.perGameDay,
        seen === undefined ? 0 : fixture.clout.maxGainPerGameDay * margin,
      ),
    )
  }
  const clout = {
    paycheck: cloutRate('paycheck'),
    flex: cloutRate('flex'),
    club: cloutRate('club'),
    event: cloutRate('event'),
  }
  const cashPerAction = Math.max(
    fixture.cash.maxGainPerAction * margin,
    cash.shift.perAction,
    cash.event.perAction,
  )
  const cashPerGameDay = Math.max(
    fixture.cash.maxGainPerGameDay * margin,
    cash.shift.perGameDay + cash.event.perGameDay,
  )
  return {
    clout,
    cash: rate(cashPerAction, cashPerGameDay),
    grants: grantCeilings(config),
    itemCloutMax: theory.itemCloutMax,
    premiumCap: theory.premiumCap,
    actionsPerRealMinute: maxActionsPerRealMinute,
    burstRealMinutes,
    passiveGameMinutesPerRealMinute:
      config.time.gameMinutesPerRealMinute * Math.max(...config.time.speeds),
    maxActionGameMinutes: maxActionGameMinutes(config),
    pacePerTap: {
      cash: Math.max(cash.shift.perAction, cash.event.perAction),
      clout: Math.max(...RATED_SOURCES.map((source) => theory.bySource[source]?.perAction ?? 0)),
    },
    cashPerTapByLevel: config.clout.levels.map((_level, index) =>
      Math.max(
        cash.event.perAction,
        ...jobIds(config)
          .filter((id) => jobLevelIndex(id, config) <= index)
          .map((id) => shiftWage(id, config)),
      ),
    ),
    paceCreditCap: {
      cash: cashPerGameDay,
      clout: RATED_SOURCES.reduce((sum, source) => sum + clout[source].perGameDay, 0),
    },
    publicCloutPerRealMinute,
  }
}

/** What the server knows beyond the two saves. */
export interface UploadContext {
  /** Real minutes since the server accepted the previous save. */
  readonly realMinutesSinceAccept: number
  /**
   * Burst credit (real minutes) the server carried from the last accept (`Verdict`'s
   * `burstCreditMinutes`); clamped to 0..`burstRealMinutes`.
   */
  readonly burstCreditMinutes: number
  /** Real minutes since the account was created. */
  readonly accountAgeMinutes: number
  /** Grant keys the server already holds for this player (`goal:<id>:r<run>`). */
  readonly serverGrantKeys: readonly string[]
  /** Premium item ids the server holds an entitlement for. */
  readonly entitledItemIds: readonly string[]
  /** True for the player's first upload: never rejected for real-time reasons. */
  readonly firstUpload: boolean
  /**
   * The honest-pace credit the server carried from the last accept (`Verdict`'s `paceCredit`),
   * or null for a full bucket.
   */
  readonly paceCredit?: CashClout | null
  /**
   * True when the player keeps this device's game over another device's (a conflict settled as
   * "keep this device"): `prev` is the save both branched from, and grants the server holds that
   * the upload also carries are the other branch's claim of the same reward, not a replay.
   */
  readonly branch?: boolean
  /**
   * The account's current save, when `prev` is not it: a "keep this device" branch whose shared
   * save the history no longer keeps (`prev` null). The upload is then checked as a whole run
   * against the real time since this save was accepted plus the burst credit carried, the pace
   * credit carried, and its forward-only fields (prestige, run) against this save; the
   * prestige-run clout check counts from this save too.
   */
  readonly head?: SaveState
  /**
   * For a branch without its shared save: the shared revision's tap count and clock minute (the
   * revision ledger), when the upload is in that revision's run. The taps and clock window then
   * start there instead of at the run's start.
   */
  readonly baseline?: { readonly actions: number; readonly minute: number }
}

/** Why a verdict is what it is. Reject codes are listed in `REJECTING`. */
export type Finding =
  | 'structural'
  | 'goal-without-fact'
  | 'prestige-history'
  | 'badge-without-run'
  | 'kept-item-unmarked'
  | 'peak-above-reachable'
  | 'peak-below-level'
  | 'premium-without-entitlement'
  | 'grant-invalid'
  | 'grant-replayed'
  | 'grant-ledger-mismatch'
  | 'regressed'
  | 'clout-rate'
  | 'action-rate'
  | 'clock-advance'
  | 'honest-pace'
  | 'cash-flow'
  | 'public-level-capped'

const REJECTING: ReadonlySet<Finding> = new Set<Finding>([
  'structural',
  'prestige-history',
  'grant-invalid',
  'grant-replayed',
  'grant-ledger-mismatch',
  'regressed',
  'clout-rate',
  'action-rate',
  'clock-advance',
  'honest-pace',
  'cash-flow',
])

/** What other players may see (INT-10: S18a's profile columns, written only by commit_save). */
export interface PublicView {
  readonly level_id: string
  readonly level_index: number
  /**
   * The career path the player chose, or null: always null until S16a adds it to the save
   * (DEC-20). commit_save keeps the stored path when this is null within the same run (DEC-19).
   */
  readonly career_path: string | null
  /** Worn wearables and the premium items the server holds an entitlement for, sorted. */
  readonly cosmetics: readonly string[]
}

export interface Verdict {
  readonly outcome: 'accept' | 'repair' | 'reject'
  readonly repairs: readonly Repair[]
  /** Every finding, in check order, without repeats. */
  readonly findings: readonly Finding[]
  /** The save to store: the upload with every repair applied, or null when rejected. */
  readonly save: SaveState | null
  readonly publicView: PublicView | null
  /** New grant records to insert (`toServerGrantRow`), or none when rejected. */
  readonly grantsToInsert: readonly GrantRecord[]
  /** True when the upload is in the same run as the previous save. */
  readonly sameRun: boolean
  /**
   * The burst credit to carry to the next upload (see the module comment), or null when the
   * upload is rejected: nothing is stored, so the credit stays as it was.
   */
  readonly burstCreditMinutes: number | null
  /** The honest-pace credit to carry to the next upload, or null when rejected. */
  readonly paceCredit: CashClout | null
}

/** The window an upload covers, and what it is compared against. */
interface Window {
  readonly prev: SaveState | null
  /** The previous save when it is in the same run as the upload, else null (a fresh run). */
  readonly base: SaveState | null
  /** Personal-clock minute the compared span starts: the base's minute or the run's start. */
  readonly fromMinute: number
  /** True when real time may reject: there is a previous save and this is not the first upload. */
  readonly realTime: boolean
  /** Real minutes the window may hold, burst credit included. */
  readonly realMinutes: number
  /** Taps counted since `base` (same run), or null for a fresh run. */
  readonly actions: number | null
  /** What finished runs count from: `prev`, or the account's save for a branch without it. */
  readonly runsFrom: SaveState | null
  /** Where taps and the clock count from when there is no `prev` (`UploadContext.baseline`). */
  readonly baseline: { readonly actions: number; readonly minute: number } | null
  /**
   * The counted taps the window's earnings must fit: `actions`, or for a run that started inside
   * a real-time window (a prestige since `prev`) every tap of that run; null when nothing bounds
   * them per tap (the first upload, which only game time checks).
   */
  readonly earningTaps: number | null
}

/** Game days the span from `from` to `to` touches (a part day counts as a whole one). */
function daysSpanned(from: number, to: number, config: EngineConfig): number {
  return Math.max(1, calendar(to, config).day - calendar(Math.min(from, to), config).day + 1)
}

/** Where the current run started: the last prestige's minute, or 0 for the first run. */
function runStart(save: SaveState): number {
  return save.prestige.history.at(-1)?.endedAt ?? 0
}

/**
 * The save schema per config, built once: a server checks every upload with the same config, and
 * building the schema costs twenty times what a parse does.
 */
const saveSchemas = new WeakMap<EngineConfig, ReturnType<typeof createSaveSchema>>()
function saveSchema(config: EngineConfig): ReturnType<typeof createSaveSchema> {
  const known = saveSchemas.get(config)
  if (known !== undefined) return known
  const schema = createSaveSchema(config)
  saveSchemas.set(config, schema)
  return schema
}

/**
 * Checks an uploaded save against the last accepted one (see the module comment). `next` is
 * untrusted (parsed here); `prev` is what the server stored, or null for the first upload.
 */
export function checkUpload(
  prev: SaveState | null,
  next: unknown,
  ctx: UploadContext,
  ceilings: PlausibilityCeilings,
  config: EngineConfig,
): Verdict {
  const parsed = saveSchema(config).safeParse(next)
  if (!parsed.success) return rejected(['structural'])

  const findings: Finding[] = []
  const repairs: Repair[] = []
  const find = (finding: Finding) => {
    if (!findings.includes(finding)) findings.push(finding)
  }
  // Each check sees the repairs of the checks before it.
  let save = parsed.data as SaveState
  const repair = (fixes: readonly Repair[], finding: Finding) => {
    if (fixes.length === 0) return
    find(finding)
    repairs.push(...fixes)
    save = applyRepairs(save, fixes)
  }

  const sameRun = prev !== null && prev.prestige.history.length === save.prestige.history.length
  const base = sameRun ? prev : null
  const credit = Math.min(ceilings.burstRealMinutes, Math.max(0, ctx.burstCreditMinutes))
  const window: Window = {
    prev,
    base,
    fromMinute: base === null ? runStart(save) : base.clock.minute,
    realTime: !ctx.firstUpload,
    realMinutes: Math.max(0, ctx.realMinutesSinceAccept) + credit,
    actions: base === null ? null : save.actions - base.actions,
    runsFrom: prev ?? ctx.head ?? null,
    baseline: prev === null ? (ctx.baseline ?? null) : null,
    earningTaps:
      base !== null ? save.actions - base.actions : !ctx.firstUpload ? save.actions : null,
  }

  repair(checkGoals(save, base, ceilings, config), 'goal-without-fact')
  if (!historyWhole(save, config)) find('prestige-history')
  repair(checkBadges(save, ctx, config), 'badge-without-run')
  repair(checkKept(save, prev), 'kept-item-unmarked')
  const peak = checkPeak(save, base, ceilings, config)
  for (const finding of peak.findings) find(finding)
  if (peak.fix !== null) {
    repairs.push(peak.fix)
    save = applyRepairs(save, [peak.fix])
  }
  repair(checkPremium(save, ctx), 'premium-without-entitlement')

  const grants = checkGrants(save, window, ctx, ceilings, config)
  for (const finding of grants.findings) find(finding)
  if (prev !== null && regressed(prev, save, sameRun, config)) find('regressed')
  if (ctx.head !== undefined && forwardRegressed(ctx.head, save)) find('regressed')
  const pace = checkPace(save, window, ceilings)
  for (const finding of pace.findings) find(finding)
  for (const finding of checkCloutRate(save, window, ceilings, config)) find(finding)
  const cashFlow = cashFlows(save, window, grants.cash, ceilings, config)
  if (!cashFlow.ok) find('cash-flow')
  // The jobs the window can have worked: those unlocked at the highest level it reached.
  const reached = Math.max(save.player.clout.peakLevel, window.base?.player.clout.peakLevel ?? 0)
  const honest = checkHonestPace(
    { cash: cashFlow.income, clout: ratedGain(save, window.base) },
    window,
    ctx.paceCredit ?? ceilings.paceCreditCap,
    {
      cash: ceilings.cashPerTapByLevel[reached] ?? ceilings.pacePerTap.cash,
      clout: ceilings.pacePerTap.clout,
    },
    ceilings,
  )
  if (!honest.ok) find('honest-pace')

  if (findings.some((finding) => REJECTING.has(finding))) return rejected(findings, repairs)

  const level = playerLevel(save.player, config)
  const cap = publicLevelCap(save, ctx.accountAgeMinutes, ceilings, config)
  if (cap < level.index) find('public-level-capped')
  const shown = config.clout.levels[Math.min(level.index, cap)]
  return {
    outcome: repairs.length > 0 ? 'repair' : 'accept',
    repairs,
    findings,
    save,
    publicView: {
      level_id: shown?.id ?? level.id,
      level_index: Math.min(level.index, cap),
      career_path: null,
      cosmetics: publicCosmetics(save, ctx),
    },
    grantsToInsert: grants.insert,
    sameRun,
    burstCreditMinutes: window.realTime
      ? Math.min(ceilings.burstRealMinutes, Math.max(0, window.realMinutes - pace.usedMinutes))
      : ceilings.burstRealMinutes,
    paceCredit: honest.credit,
  }
}

function rejected(findings: readonly Finding[], repairs: readonly Repair[] = []): Verdict {
  return {
    outcome: 'reject',
    repairs,
    findings,
    save: null,
    publicView: null,
    grantsToInsert: [],
    sameRun: false,
    burstCreditMinutes: null,
    paceCredit: null,
  }
}

/**
 * The cosmetics other players may see: the worn wearables (cash-shop items the save owns, kept
 * looks included) and the premium items the server holds a live entitlement for. Premium comes
 * from the server alone: the save's ledger folds old premium entries into a total that names no
 * item, so it cannot say which premium items the player holds.
 */
function publicCosmetics(save: SaveState, ctx: UploadContext): string[] {
  return [
    ...new Set([...Object.values(save.player.inventory.outfit), ...ctx.entitledItemIds]),
  ].sort()
}

/** Ledger entries written after `base` (the whole ledger for a fresh run). */
function newEntries(save: SaveState, base: SaveState | null) {
  const from = base?.player.clout.nextSeq ?? 0
  return save.player.clout.ledger.filter((entry) => entry.seq >= from)
}

/**
 * Entries the ledger has folded away since `base` without showing them (any source): the seq
 * numbers spent since then less the new entries still in the ledger.
 */
function unseenEntries(save: SaveState, base: SaveState | null): number {
  if (base === null) return save.player.clout.compacted.entries
  const spent = save.player.clout.nextSeq - base.player.clout.nextSeq
  return Math.max(0, spent - newEntries(save, base).length)
}

/** Clout the window took away (losses still in the ledger; item audit and premium aside). */
function lossesSince(save: SaveState, base: SaveState | null): number {
  return newEntries(save, base).reduce(
    (sum, entry) =>
      entry.amount < 0 && entry.source !== 'item' && entry.source !== 'premium'
        ? sum - entry.amount
        : sum,
    0,
  )
}

/** Item clout that may have been held in the window but is gone now (sold since `base`). */
function itemCloutGone(
  save: SaveState,
  base: SaveState | null,
  ceilings: PlausibilityCeilings,
  config: EngineConfig,
): number {
  if (base === null) return ceilings.itemCloutMax
  const owned = new Set(save.player.inventory.wearables.map((entry) => entry.itemId))
  return base.player.inventory.wearables
    .filter((entry) => !isPrestigeKept(entry) && !owned.has(entry.itemId))
    .reduce((sum, entry) => sum + (findItem(entry.itemId, config)?.cloutValue ?? 0), 0)
}

/**
 * Home clout that may have been held in the window but is gone now (H-2): what the home lost
 * since `base` (a move to a cheaper home, decor taken down, sold or evicted), plus the score of
 * counting decor the player owns but has not placed or sold since `base`, and at least what
 * would fill the home to `home.maxClout` (decor bought, placed and sold within the window shows
 * nowhere); at most `home.maxClout`, the whole cap for a fresh run or a first upload. Private
 * checks only (goal facts, the peak level): earnings checks never read it.
 */
function homeCloutGone(save: SaveState, base: SaveState | null, config: EngineConfig): number {
  const cap = config.home.maxClout
  if (base === null) return cap
  const score = (itemId: string) => {
    const item = findItem(itemId, config)
    return item !== undefined && isDecor(item) ? item.decor.homeScore : 0
  }
  const placed = new Set(Object.values(save.player.apartment.placed))
  const owned = new Set(save.player.inventory.decor.map((entry) => entry.itemId))
  const unplaced = save.player.inventory.decor
    .filter((entry) => !isPrestigeKept(entry) && !placed.has(entry.itemId))
    .reduce((sum, entry) => sum + score(entry.itemId), 0)
  const sold = base.player.inventory.decor
    .filter((entry) => !isPrestigeKept(entry) && !owned.has(entry.itemId))
    .reduce((sum, entry) => sum + score(entry.itemId), 0)
  const lost = Math.max(0, homeClout(base.player, config) - homeClout(save.player, config))
  // Decor bought, placed and sold inside one window leaves no trace (no ledger entry): the
  // window may always have held the home up to the cap. This is slack of at most
  // `home.maxClout` in every window (SEC-18, accepted: private checks only, goals pay once).
  return Math.min(cap, Math.max(lost + unplaced + sold, cap - homeClout(save.player, config)))
}

/**
 * The most goal clout the run can have held since `base`: now, plus what it lost or sold, and
 * the home clout it may have lost.
 */
function goalCloutEver(
  save: SaveState,
  base: SaveState | null,
  ceilings: PlausibilityCeilings,
  config: EngineConfig,
): number {
  return (
    goalClout(save.player, config) +
    lossesSince(save, base) +
    itemCloutGone(save, base, ceilings, config) +
    homeCloutGone(save, base, config)
  )
}

/** True when the save shows the fact behind `goal` (see the module comment, check 2). */
function factHolds(
  goal: GoalDef,
  save: SaveState,
  base: SaveState | null,
  ceilings: PlausibilityCeilings,
  config: EngineConfig,
): boolean {
  const { player } = save
  switch (goal.fact) {
    case 'first-paycheck':
      return player.clout.firstPaycheckPaid
    case 'first-outfit':
      // Bought this run: owned now, or a purchase the ledger still shows (in full or folded).
      return (
        player.inventory.wearables.some((owned) => !isPrestigeKept(owned)) ||
        player.clout.ledger.some((entry) => entry.source === 'item' && entry.ref.op === 'buy') ||
        Object.hasOwn(player.clout.compacted.bySource, 'item')
      )
    case 'first-landmark-visit':
      return Object.keys(player.visited).length > 0
    case 'first-club-night':
      return Object.keys(player.clubNights).length > 0
    case 'first-friend':
      return false
    case 'clout-level': {
      const level = goal.level === undefined ? undefined : findCloutLevel(goal.level, config)
      return (
        level !== undefined &&
        player.clout.peakLevel >= level.index &&
        goalCloutEver(save, base, ceilings, config) >= level.minClout
      )
    }
  }
}

/** Check 2 (SEC-9): goals reached since `base` whose fact the save does not show. */
function checkGoals(
  save: SaveState,
  base: SaveState | null,
  ceilings: PlausibilityCeilings,
  config: EngineConfig,
): Repair[] {
  const victory = victoryGoal(config).id
  return config.goals
    .filter(
      (goal) =>
        Object.hasOwn(save.goals.achieved, goal.id) &&
        !(base !== null && Object.hasOwn(base.goals.achieved, goal.id)) &&
        (goal.available === false || !factHolds(goal, save, base, ceilings, config)),
    )
    .map((goal) => ({ kind: 'drop-goal', goalId: goal.id, victory: goal.id === victory }))
}

/** Check 3: runs 1..n in order, each with its own badge, and the current run n + 1. */
function historyWhole(save: SaveState, config: EngineConfig): boolean {
  const { history, count } = save.prestige
  let ended = 0
  for (const [index, entry] of history.entries()) {
    if (entry.run !== index + 1 || entry.badge !== prestigeBadge(entry.run, config)) return false
    if (entry.endedAt < ended) return false
    ended = entry.endedAt
  }
  return count === history.length && save.goals.run === history.length + 1
}

/** Check 3: badges with neither a finished run nor this run's victory claim behind them. */
function checkBadges(save: SaveState, ctx: UploadContext, config: EngineConfig): Repair[] {
  const allowed = new Set(save.prestige.history.map((entry) => entry.badge))
  const victoryKey = goalGrantKey(victoryGoal(config).id, save.goals.run)
  if (
    save.grants.log.some((record) => record.key === victoryKey) ||
    ctx.serverGrantKeys.includes(victoryKey)
  ) {
    allowed.add(prestigeBadge(save.goals.run, config))
  }
  return save.prestige.badges
    .filter((badge) => !allowed.has(badge))
    .map((badge) => ({ kind: 'drop-badge', badge }))
}

/** Check 4 (SEC-10): wearables and decor (H-4) from an earlier run that lost their look-only mark. */
function checkKept(save: SaveState, prev: SaveState | null): Repair[] {
  const lastEnded = save.prestige.history.at(-1)?.endedAt
  const prestiged = prev !== null && prev.prestige.history.length < save.prestige.history.length
  const held = (inventory: Inventory) => [...inventory.wearables, ...inventory.decor]
  const before = new Map(
    (prev === null ? [] : held(prev.player.inventory)).map((entry) => [entry.itemId, entry]),
  )
  return held(save.player.inventory)
    .filter((owned) => {
      if (isPrestigeKept(owned)) return false
      if (lastEnded !== undefined && owned.acquiredMinute < lastEnded) return true
      // The same copy as in the previous save (not sold and bought again since).
      const earlier = before.get(owned.itemId)
      return (
        earlier !== undefined &&
        earlier.acquiredMinute === owned.acquiredMinute &&
        (isPrestigeKept(earlier) || prestiged)
      )
    })
    .map((owned) => ({ kind: 'mark-kept', itemId: owned.itemId }))
}

/**
 * Check 5: the peak level within what the run can have reached (the base's peak, or the level
 * the clout now plus what was lost or sold adds up to; Icon only on goal clout that can have
 * reached it, DEC-13), and never below the current level (NOTE-7). At most one `set-peak`
 * repair. A peak at Icon without goal clout for it now never gets here: the save schema refuses
 * it (structural), as `loadSave` lowers it on the device first.
 */
function checkPeak(
  save: SaveState,
  base: SaveState | null,
  ceilings: PlausibilityCeilings,
  config: EngineConfig,
): { readonly findings: Finding[]; readonly fix: Repair | null } {
  const { clout } = save.player
  const level = playerLevel(save.player, config).index
  const findings: Finding[] = []
  let reachable = Math.max(
    base?.player.clout.peakLevel ?? 0,
    cloutLevel(
      totalClout(save.player, config) +
        lossesSince(save, base) +
        itemCloutGone(save, base, ceilings, config) +
        homeCloutGone(save, base, config),
      config,
    ).index,
  )
  const earnedOnly = earnedOnlyLevel(config)
  let peak = clout.peakLevel
  if (earnedOnly !== null && reachable >= earnedOnly.index) {
    if (goalCloutEver(save, base, ceilings, config) < earnedOnly.minClout) {
      reachable = earnedOnly.index - 1
    }
  }
  if (peak > reachable) {
    findings.push('peak-above-reachable')
    peak = Math.max(level, reachable)
  }
  if (peak < level) {
    findings.push('peak-below-level')
    peak = level
  }
  return {
    findings,
    fix: peak === clout.peakLevel ? null : { kind: 'set-peak', peakLevel: peak },
  }
}

/** Check 6: premium clout of items the server holds no entitlement for. */
function checkPremium(save: SaveState, ctx: UploadContext): Repair[] {
  const entitled = new Set(ctx.entitledItemIds)
  const { clout } = save.player
  const items = new Set<string>()
  for (const entry of clout.ledger) {
    if (entry.source === 'premium' && !entitled.has(entry.ref.itemId)) items.add(entry.ref.itemId)
  }
  const fixes: Repair[] = [...items].sort().map((itemId) => ({ kind: 'drop-premium', itemId }))
  // Premium folded in from earlier runs names no item: it needs some entitlement at least.
  if ((clout.compacted.bySource.premium ?? 0) !== 0 && entitled.size === 0) {
    fixes.push({ kind: 'drop-premium', itemId: null })
  }
  return fixes
}

/**
 * Deep equality of two JSON values, whatever their key order (a save read back from jsonb has
 * its keys reordered).
 */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left)
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && sameJson(left[key], right[key]))
  )
}

/** Why a grant record the server has not seen is not one the grant function could write. */
function grantInvalid(
  record: GrantRecord,
  save: SaveState,
  window: Window,
  ceilings: PlausibilityCeilings,
  config: EngineConfig,
): boolean {
  const { goalId, run } = record.eligibility
  const goal = config.goals.find((entry) => entry.id === goalId)
  if (goal === undefined || goal.available === false || run > save.goals.run) return true
  if (window.prev !== null && record.seq < window.prev.grants.nextSeq) return true
  const reward = goalReward(goal, run, config)
  const { perGrant } = ceilings.grants
  if (
    record.requested.cash !== reward.cash ||
    record.requested.clout !== reward.clout ||
    record.requested.badge !== reward.badge ||
    record.cap.cash > perGrant.cash ||
    record.cap.clout > perGrant.clout ||
    record.applied.cash > Math.min(record.requested.cash, record.cap.cash) ||
    record.applied.clout > Math.min(record.requested.clout, record.cap.clout)
  ) {
    return true
  }
  if (run === save.goals.run) return !Object.hasOwn(save.goals.achieved, goal.id)
  // An earlier run's claim is new only when made just before a prestige in this window: its
  // goals are gone with the run, and the clout-rate check covers reaching its Icon.
  return window.prev !== null && run < window.prev.goals.run
}

/** Check 7: the grant log and the ledger's grant clout against what the server holds. */
function checkGrants(
  save: SaveState,
  window: Window,
  ctx: UploadContext,
  ceilings: PlausibilityCeilings,
  config: EngineConfig,
): { readonly findings: Finding[]; readonly insert: GrantRecord[]; readonly cash: number } {
  const findings: Finding[] = []
  const insert: GrantRecord[] = []
  const server = new Set(ctx.serverGrantKeys)
  const before = new Map(window.prev?.grants.log.map((record) => [record.key, record]))
  const { run } = save.goals
  let newRunClout = 0
  let cash = 0
  for (const record of save.grants.log) {
    const earlier = before.get(record.key)
    if (earlier !== undefined) {
      // `sync` is the device's bookkeeping (markGrantsSynced), not part of the grant.
      if (!sameJson({ ...earlier, sync: null }, { ...record, sync: null })) {
        findings.push('grant-invalid')
      }
      continue
    }
    const held = server.has(record.key)
    if (held && ctx.branch !== true) {
      // Accepted once already and gone from the previous save: claimed again.
      findings.push('grant-replayed')
      continue
    }
    if (grantInvalid(record, save, window, ceilings, config)) {
      findings.push('grant-invalid')
      continue
    }
    // A kept branch's claim of a reward the other branch claimed too: valid, and counted below,
    // but the server keeps the row it already holds (the other branch's, as audit).
    if (!held) insert.push(record)
    if (record.eligibility.run === run) {
      newRunClout += record.applied.clout
      cash += record.applied.cash
    }
  }

  const records = new Map(save.grants.log.map((record) => [record.key, record]))
  for (const entry of save.player.clout.ledger) {
    if (entry.source !== 'grant') continue
    const record = records.get(entry.ref.grantKey)
    if (
      record === undefined ? !server.has(entry.ref.grantKey) : entry.amount !== record.applied.clout
    ) {
      findings.push('grant-ledger-mismatch')
    }
  }
  // This run's grant clout is exactly what this run's records applied.
  const grantClout = (state: CloutState) => cloutSums(state).bySource.grant ?? 0
  const added =
    grantClout(save.player.clout) -
    (window.base === null ? 0 : grantClout(window.base.player.clout))
  if (added !== newRunClout) findings.push('grant-ledger-mismatch')
  return { findings, insert, cash }
}

/**
 * Check 8 for a branch checked without its shared save: the fields that only move forward on
 * every device (prestige and the run) are not behind the account's save.
 */
function forwardRegressed(head: SaveState, save: SaveState): boolean {
  // Not the grant sequence: each device numbers its own claims, and the server's grant keys stop
  // a reward the account already received from being claimed again.
  return (
    save.prestige.count < head.prestige.count ||
    head.prestige.history.some((entry, i) => !sameJson(entry, save.prestige.history[i])) ||
    save.goals.run < head.goals.run
  )
}

/** Check 8: anything that only moves forward, moved back. */
function regressed(prev: SaveState, save: SaveState, sameRun: boolean, config: EngineConfig) {
  const before = prev.player
  const now = save.player
  if (
    save.clock.minute < prev.clock.minute ||
    save.goals.run < prev.goals.run ||
    now.clout.nextSeq < before.clout.nextSeq ||
    save.grants.nextSeq < prev.grants.nextSeq ||
    save.prestige.count < prev.prestige.count ||
    prev.prestige.history.some((entry, i) => !sameJson(entry, save.prestige.history[i])) ||
    prev.prestige.badges.some((badge) => !save.prestige.badges.includes(badge))
  ) {
    return true
  }
  if (!sameRun) return false
  if (save.actions < prev.actions) return true
  const today = calendar(save.clock.minute, config).day
  // Entries for places or events a newer build no longer has are dropped on load: only what the
  // config still knows must carry over.
  const kept = (
    earlier: Readonly<Record<string, number>>,
    later: Readonly<Record<string, number>>,
    known: (id: string) => boolean,
  ) =>
    Object.entries(earlier).every(
      ([id, value]) => !known(id) || (Object.hasOwn(later, id) && (later[id] ?? -1) >= value),
    )
  const isClub = (id: string) => Object.hasOwn(config.place.clubs, id)
  const isPlace = (id: string) => config.places.has(id)
  const isEvent = (id: string) => config.events.catalog.some((event) => event.id === id)
  return (
    (before.clout.firstPaycheckPaid && !now.clout.firstPaycheckPaid) ||
    !kept(before.clubNights, now.clubNights, isClub) ||
    !kept(before.visited, now.visited, isPlace) ||
    !kept(prev.events.history, save.events.history, isEvent) ||
    // Only today's flexes are kept, so only they must still be there.
    Object.entries(before.flex.byPlace).some(
      ([id, day]) => isPlace(id) && day === today && now.flex.byPlace[id] !== day,
    )
  )
}

/**
 * Check 9 (DEC-19): the taps and clock movement the window claims, against its real time. Returns
 * the real minutes the upload needed (at least), for the burst credit.
 */
function checkPace(
  save: SaveState,
  window: Window,
  ceilings: PlausibilityCeilings,
): { readonly findings: Finding[]; readonly usedMinutes: number } {
  const { prev } = window
  if (!window.realTime) return { findings: [], usedMinutes: 0 }
  const findings: Finding[] = []
  const tapRate = ceilings.actionsPerRealMinute
  // With no previous save (a branch the history no longer keeps), the whole run is the window.
  const entries = prev === null ? 0 : save.player.clout.nextSeq - prev.player.clout.nextSeq
  const { baseline } = window
  const counted =
    window.actions ?? (baseline === null ? save.actions : save.actions - baseline.actions)
  // Behind the shared revision's taps or clock: the save went back.
  if (baseline !== null && (counted < 0 || save.clock.minute < baseline.minute)) {
    findings.push('regressed')
  }
  const tapMinutes = Math.max(0, counted, entries) / tapRate
  if (tapMinutes > window.realMinutes) findings.push('action-rate')
  // A fresh run in the window: the taps the previous run made after `prev` are counted nowhere,
  // so they are allowed for at the tap rate over the whole window.
  const clockTaps =
    prev === null
      ? Math.max(0, counted)
      : window.actions === null
        ? save.actions + tapRate * window.realMinutes
        : Math.max(0, window.actions)
  const from = prev !== null ? prev.clock.minute : (baseline?.minute ?? window.fromMinute)
  const passive = Math.max(0, save.clock.minute - from - clockTaps * ceilings.maxActionGameMinutes)
  const clockMinutes = passive / ceilings.passiveGameMinutesPerRealMinute
  if (clockMinutes > window.realMinutes) findings.push('clock-advance')
  return { findings, usedMinutes: Math.max(tapMinutes, clockMinutes) }
}

/** Check 10: what each source added in the window, against the ceilings. */
function checkCloutRate(
  save: SaveState,
  window: Window,
  ceilings: PlausibilityCeilings,
  config: EngineConfig,
): Finding[] {
  const { base, prev } = window
  const findings: Finding[] = []
  const now = cloutSums(save.player.clout).bySource
  const was = base === null ? {} : cloutSums(base.player.clout).bySource
  const gain = (source: CloutSourceId) => (now[source] ?? 0) - (was[source] ?? 0)
  const days = daysSpanned(window.fromMinute, save.clock.minute, config)
  const fresh = newEntries(save, base)
  const unseen = unseenEntries(save, base)

  let dayBudget = 0
  for (const source of RATED_SOURCES) {
    const ceiling = ceilings.clout[source]
    dayBudget += ceiling.perGameDay * days
    const entries = fresh.filter((entry) => entry.source === source).length + unseen
    let bound = Math.min(ceiling.perGameDay * days, ceiling.perAction * entries)
    // The first paycheck pays once a run.
    if (source === 'paycheck') {
      bound = base?.player.clout.firstPaycheckPaid === true ? 0 : Math.min(bound, ceiling.perAction)
    }
    // Each counted tap writes at most one entry of a source.
    if (window.earningTaps !== null) {
      bound = Math.min(bound, ceiling.perAction * Math.max(0, window.earningTaps))
    }
    if (gain(source) > bound) findings.push('clout-rate')
  }
  // ...and one entry in all: folded entries cannot pay every source at once.
  if (window.earningTaps !== null) {
    const perTap = Math.max(...RATED_SOURCES.map((source) => ceilings.clout[source].perAction))
    const rated = RATED_SOURCES.reduce((sum, source) => sum + Math.max(0, gain(source)), 0)
    if (rated > perTap * Math.max(0, window.earningTaps)) findings.push('clout-rate')
  }
  // Legacy and repair clout come only from loading an old or damaged save, never from play: a
  // run that started after the previous save starts without them.
  const carried = gain('legacy') + gain('repair')
  if (carried > (prev === null ? dayBudget : 0)) findings.push('clout-rate')

  const from = window.runsFrom
  if (window.realTime && from !== null) {
    const taps = ceilings.actionsPerRealMinute * window.realMinutes
    const runs = save.prestige.history.length - from.prestige.history.length
    const earnedOnly = earnedOnlyLevel(config)
    if (runs > 0 && earnedOnly !== null) {
      // Each finished run reached Icon on earned clout: from where the previous save stood for
      // the first, from nothing for the others.
      const needed =
        Math.max(0, earnedOnly.minClout - goalClout(from.player, config)) +
        (runs - 1) * earnedOnly.minClout
      const perTap = Math.max(...RATED_SOURCES.map((source) => ceilings.clout[source].perAction))
      if (needed > perTap * taps) findings.push('clout-rate')
    }
  }
  return findings
}

/** Whole dollars a wearable or gift change between two inventories was bought and sold for. */
function itemTrade(
  before: Inventory,
  after: Inventory,
  config: EngineConfig,
): { readonly bought: number; readonly sold: number; readonly giftsGone: number } {
  const price = (itemId: string) => findItem(itemId, config)?.price ?? 0
  const sellValue = (itemId: string) => findItem(itemId, config)?.sellValue ?? 0
  const copy = (owned: { itemId: string; acquiredMinute: number }) =>
    `${owned.itemId}@${owned.acquiredMinute}`
  const had = new Set(before.wearables.map(copy))
  const has = new Set(after.wearables.map(copy))
  let bought = 0
  let sold = 0
  for (const owned of after.wearables) {
    if (!isPrestigeKept(owned) && !had.has(copy(owned))) bought += price(owned.itemId)
  }
  for (const owned of before.wearables) {
    if (!isPrestigeKept(owned) && !has.has(copy(owned))) sold += sellValue(owned.itemId)
  }
  // Decor (S16) trades like wearables: one copy per purchase, kept-through-prestige ones aside.
  const hadDecor = new Set(before.decor.map(copy))
  const hasDecor = new Set(after.decor.map(copy))
  for (const owned of after.decor) {
    if (!isPrestigeKept(owned) && !hadDecor.has(copy(owned))) bought += price(owned.itemId)
  }
  for (const owned of before.decor) {
    if (!isPrestigeKept(owned) && !hasDecor.has(copy(owned))) sold += sellValue(owned.itemId)
  }
  const count = (inventory: Inventory, itemId: string) =>
    inventory.gifts.find((stack) => stack.itemId === itemId)?.count ?? 0
  // Gifts that are gone were sold or used up (`consumeGift`, H-5): their resale value counts only
  // as far as cash shows it (`cashFlows`).
  let giftsGone = 0
  const giftIds = new Set([...before.gifts, ...after.gifts].map((stack) => stack.itemId))
  for (const itemId of giftIds) {
    const change = count(after, itemId) - count(before, itemId)
    if (change > 0) bought += change * price(itemId)
    else giftsGone += -change * sellValue(itemId)
  }
  return { bought, sold, giftsGone }
}

/**
 * Check 11: cash now is at most the starting cash (the base's, or a fresh run's), plus play
 * income within the ceilings (per game day, and one action's worth per counted tap), plus this
 * window's valid grants and what was sold, less what was bought and any move into a dearer home.
 * Rent and other costs only lower the real figure.
 */
function cashFlows(
  save: SaveState,
  window: Window,
  grantCash: number,
  ceilings: PlausibilityCeilings,
  config: EngineConfig,
): { readonly ok: boolean; readonly income: number } {
  const { base } = window
  const start = base?.player ?? {
    cash: config.startCash,
    home: config.startHome,
    inventory: emptyInventory,
  }
  const days = daysSpanned(window.fromMinute, save.clock.minute, config)
  let income = ceilings.cash.perGameDay * days
  if (window.earningTaps !== null) {
    income = Math.min(income, ceilings.cash.perAction * Math.max(0, window.earningTaps))
  }
  const trade = itemTrade(start.inventory, save.player.inventory, config)
  const home = save.player.home
  const moved =
    home !== start.home && rentFor(home, config) > rentFor(start.home, config)
      ? moveInCost(home, config)
      : 0
  // A gift used up is not a sale: its resale value counts only up to the cash the window gained.
  const giftSales = Math.min(trade.giftsGone, Math.max(0, save.player.cash - start.cash))
  const otherwise = start.cash + grantCash + trade.sold + giftSales - trade.bought - moved
  // What play must have brought in to end at this cash (spending only lowers it).
  const needed = Math.max(0, save.player.cash - otherwise)
  return { ok: needed <= income, income: needed }
}

/** Clout the rated sources (play) added since `base` (the whole run for a fresh run). */
function ratedGain(save: SaveState, base: SaveState | null): number {
  const now = cloutSums(save.player.clout).bySource
  const was = base === null ? {} : cloutSums(base.player.clout).bySource
  return RATED_SOURCES.reduce(
    (sum, source) => sum + Math.max(0, (now[source] ?? 0) - (was[source] ?? 0)),
    0,
  )
}

/**
 * Check 13 (DEC-19): honest pace. The cash play brought in and the clout it earned since the
 * last accept must fit the counted taps at `perTap` (`pacePerTap`, cash at the reached level's
 * jobs) plus the credit carried
 * (a token bucket up to `paceCreditCap`, refilled only by taps). Without per-tap counting (the
 * first upload) the bucket starts full and nothing is checked.
 */
function checkHonestPace(
  gained: CashClout,
  window: Window,
  credit: CashClout,
  perTap: CashClout,
  ceilings: PlausibilityCeilings,
): { readonly ok: boolean; readonly credit: CashClout } {
  if (window.earningTaps === null) return { ok: true, credit: ceilings.paceCreditCap }
  const taps = Math.max(0, window.earningTaps)
  const left = (key: keyof CashClout) =>
    Math.min(ceilings.paceCreditCap[key], Math.max(0, credit[key])) +
    perTap[key] * taps -
    gained[key]
  const cash = left('cash')
  const clout = left('clout')
  return {
    ok: cash >= 0 && clout >= 0,
    credit: {
      cash: Math.min(ceilings.paceCreditCap.cash, Math.max(0, cash)),
      clout: Math.min(ceilings.paceCreditCap.clout, Math.max(0, clout)),
    },
  }
}

/**
 * Check 12: the highest level an account this old can show. Every real minute of its age is
 * worth `publicCloutPerRealMinute` of clout (a display pace, kept apart from the upload pace: a
 * public level lagging behind the save is a delay, never a refusal); this run's grants, every
 * wearable and capped premium come on top; Icon also needs that earned budget to cover it
 * (DEC-13).
 */
function publicLevelCap(
  save: SaveState,
  accountAgeMinutes: number,
  ceilings: PlausibilityCeilings,
  config: EngineConfig,
): number {
  const earned = ceilings.publicCloutPerRealMinute * Math.max(0, accountAgeMinutes)
  // Clout starts over each run (premium aside): only this run's grants count towards the level.
  const budget = earned + ceilings.itemCloutMax + ceilings.grants.perRun.clout + ceilings.premiumCap
  const cap = cloutLevel(budget, config).index
  const earnedOnly = earnedOnlyLevel(config)
  if (earnedOnly !== null && earned + ceilings.itemCloutMax < earnedOnly.minClout) {
    return Math.min(cap, earnedOnly.index - 1)
  }
  return cap
}
