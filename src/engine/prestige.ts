/**
 * Prestige (S15): after reaching Icon, the player may start over from zero to earn a prestige
 * badge. The rules live in data/config/progression.json `prestige`:
 *
 * - It needs `requiresGoal` (the victory goal) reached this run, and no event open.
 * - The run's badge is granted through the one grant function (it is the victory goal's
 *   reward, so a player who already claimed it gets a replay, never a second badge), then the
 *   parts in `prestige.resets` start over. Clout always resets except premium (real-money)
 *   clout, which is kept, folded into the ledger's compacted totals; the ledger's `seq` carries
 *   on so entries stay unique across runs. The flex, event and transit-delay generators keep
 *   their state, so a new run cannot replay the same rolls. The new run starts at home. Goals always reset, to the next run (`run + 1`), so
 *   every goal can be reached and (with `rewardsRepeat`) rewarded again.
 * - The parts in `prestige.keeps` carry over: the personal clock and speed, the grant log (the
 *   audit trail), prestige itself (count, badges, history) and premium clout. The shipped config
 *   also keeps the inventory (user ruling Q-8): owned wearables, the outfit and decor carry over
 *   as looks only (`keptInventory`: no clout, style, home score or resale value), and gifts start
 *   over. The apartment follows the run's home: kept decor stays in the slots the new run's
 *   home also has (src/engine/home.ts `placementsAfterMove`); the move log (the audit trail for
 *   save plausibility) is kept.
 *
 * It is atomic: either everything above happens or nothing does.
 */
import type { PrestigePart } from '@/lib/data/goalFacts'
import { cloutSums, playerLevel, type CloutState } from './clout'
import type { EngineConfig } from './config'
import { initialEventsState, type EventsState } from './events'
import { initialSnapshot, type PlayerState } from './game'
import { initialGoalsState, victoryGoal, type GoalsState } from './goals'
import { grant, type GrantRecord, type GrantSnapshot } from './grants'
import { placementsAfterMove } from './home'
import { emptyInventory, type Inventory } from './items'
import { initialRent } from './rent'

export interface PrestigeRun {
  /** The run that ended. */
  readonly run: number
  /** Personal-clock minute it ended. */
  readonly endedAt: number
  /** Real time the player chose to prestige (ms since the epoch), injected by the caller. */
  readonly issuedAtMs: number
  /** The badge the run earned. */
  readonly badge: string
}

export interface PrestigeState {
  /** Runs finished by prestiging. */
  readonly count: number
  /** Badges earned, in the order earned (prestige.badgeIds), never repeated. */
  readonly badges: readonly string[]
  readonly history: readonly PrestigeRun[]
}

export const initialPrestigeState: PrestigeState = { count: 0, badges: [], history: [] }

/** What prestige reads and writes: the whole save except its speed. */
export interface PrestigeSnapshot extends GrantSnapshot {
  readonly events: EventsState
}

export type PrestigeError =
  /** The run has not reached `prestige.requiresGoal` yet. */
  | { readonly code: 'NOT_YET' }
  /** An event is open: resolve it first. */
  | { readonly code: 'EVENT_OPEN' }

export type PrestigeResult<S extends PrestigeSnapshot> =
  | {
      readonly ok: true
      readonly save: S
      /** The badge grant (a replay when the victory reward was already claimed). */
      readonly grant: GrantRecord
      readonly badge: string
    }
  | { readonly ok: false; readonly error: PrestigeError }

/** Why the player cannot prestige right now, or null when they can. */
export function canPrestige(save: PrestigeSnapshot, config: EngineConfig): PrestigeError | null {
  if (!Object.hasOwn(save.goals.achieved, config.prestige.requiresGoal)) return { code: 'NOT_YET' }
  if (save.events.active !== null) return { code: 'EVENT_OPEN' }
  return null
}

function resets(part: PrestigePart, config: EngineConfig): boolean {
  return config.prestige.resets.includes(part)
}

/**
 * The clout ledger of a new run: empty, with premium clout carried as a folded total when
 * `premium` is kept, `seq` carrying on, and the first paycheck still to come.
 */
function nextRunClout(clout: CloutState, config: EngineConfig): CloutState {
  const premium = config.prestige.keeps.includes('premium') ? cloutSums(clout).premium : 0
  return {
    ledger: [],
    compacted: premium === 0 ? { entries: 0, bySource: {} } : { entries: 1, bySource: { premium } },
    nextSeq: clout.nextSeq,
    peakLevel: 0,
    firstPaycheckPaid: false,
  }
}

/**
 * What a kept inventory carries into the new run (user ruling Q-8): every owned wearable as a
 * look only (`prestigeKept`: no clout, style or resale; marked worn, so first-wear stat effects
 * never land again) and the outfit as worn; every owned decor item as a look only too (no home
 * score or resale), in its chosen colour. Gifts are consumables and start over.
 */
function keptInventory(inventory: Inventory): Inventory {
  return {
    wearables: inventory.wearables.map((owned) => ({ ...owned, worn: true, prestigeKept: true })),
    gifts: [],
    outfit: inventory.outfit,
    decor: inventory.decor.map((owned) => ({ ...owned, prestigeKept: true })),
  }
}

function nextRunPlayer(player: PlayerState, config: EngineConfig): PlayerState {
  const fresh = initialSnapshot(config).player
  const pick = <K extends keyof PlayerState>(key: K, part: PrestigePart): PlayerState[K] =>
    resets(part, config) ? fresh[key] : player[key]
  const home = pick('home', 'home')
  const keepsInventory = !resets('inventory', config)
  const next: PlayerState = {
    cash: pick('cash', 'cash'),
    stats: pick('stats', 'stats'),
    clout: nextRunClout(player.clout, config),
    flex: resets('flex', config) ? { ...fresh.flex, rngState: player.flex.rngState } : player.flex,
    home,
    rent: resets('rent', config) ? initialRent : player.rent,
    inventory: keepsInventory ? keptInventory(player.inventory) : emptyInventory,
    clubNights: pick('clubNights', 'clubNights'),
    visited: pick('visited', 'visited'),
    apartment: {
      placed: keepsInventory ? placementsAfterMove(player.apartment.placed, home, config) : {},
      moveLog: player.apartment.moveLog,
    },
    // A new run starts at home; the delay roll's generator carries on (no re-rolls).
    location: fresh.location,
    transit: player.transit,
  }
  // The new run's level is where its kept clout lands (premium, and the home's base score): no
  // level-up is reported for clout carried over.
  return { ...next, clout: { ...next.clout, peakLevel: playerLevel(next, config).index } }
}

/** Grants the run's badge, then starts the next run (see the module comment). */
export function prestige<S extends PrestigeSnapshot>(
  save: S,
  issuedAtMs: number,
  config: EngineConfig,
): PrestigeResult<S> {
  const refused = canPrestige(save, config)
  if (refused !== null) return { ok: false, error: refused }
  const goal = victoryGoal(config)
  const granted = grant(
    save,
    { kind: 'goal_reward', goalId: goal.id, reward: goal.reward },
    issuedAtMs,
    config,
  )
  if (!granted.ok) {
    // canPrestige checked the goal and the event; config guarantees the reward matches.
    throw new Error(`prestige: the badge grant was refused (${granted.error.code})`)
  }
  const badge = granted.record.applied.badge
  if (badge === null) throw new Error('prestige: the victory goal granted no badge')

  const base = granted.save
  const run = base.goals.run
  const events: EventsState = resets('events', config)
    ? { ...initialEventsState(), rngState: base.events.rngState }
    : base.events
  const goals: GoalsState = { ...initialGoalsState, run: run + 1 }
  const prestigeState: PrestigeState = {
    count: base.prestige.count + 1,
    badges: base.prestige.badges,
    history: [...base.prestige.history, { run, endedAt: base.clock.minute, issuedAtMs, badge }],
  }
  return {
    ok: true,
    save: {
      ...base,
      player: nextRunPlayer(base.player, config),
      events,
      goals,
      prestige: prestigeState,
    },
    grant: granted.record,
    badge,
  }
}
