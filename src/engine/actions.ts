/**
 * Actions: things the player does that cost time, money and energy and change stats. Each
 * one fast-forwards the personal clock instantly by its duration; the player never waits.
 *
 * Order of an action:
 * 1. The definition is validated (it may come from data or a save, so it is not trusted).
 * 2. Funds, then energy, are checked against the up-front costs; nothing changes on failure.
 * 3. Cash and energy costs are paid.
 * 4. The clock fast-forwards by the duration (times the at-zero slowdown, rounded up, judged
 *    on the stats before paying), charging passive decay and rent (src/engine/rent.ts) and
 *    crossing day/week boundaries.
 * 5. The stat effects land, clamped to 0..stats.max.
 */
import * as z from 'zod/mini'
import type { Rollovers } from './clock'
import type { EngineConfig } from './config'
import { advanceMinutes, type GameSnapshot } from './game'
import type { RentEvent } from './rent'
import { applyStatChanges, durationMultiplier, type StatChanges, type Stats } from './stats'

export interface ActionDef {
  /** Game minutes the action takes before any slowdown. */
  readonly durationMin: number
  /** Whole dollars paid up front. */
  readonly cashCost: number
  /** Energy points paid up front. */
  readonly energyCost: number
  /** Points added (negative: removed) when the action finishes. */
  readonly statEffects: StatChanges
}

export type ActionError =
  | { readonly code: 'UNKNOWN_ACTION'; readonly actionId: string }
  | { readonly code: 'INVALID_ACTION'; readonly issues: readonly string[] }
  | { readonly code: 'INSUFFICIENT_FUNDS'; readonly required: number; readonly available: number }
  | { readonly code: 'INSUFFICIENT_ENERGY'; readonly required: number; readonly available: number }

export type ActionResult =
  | {
      readonly ok: true
      readonly snapshot: GameSnapshot
      /** Game minutes the clock moved (after any slowdown). */
      readonly durationMin: number
      readonly rollovers: Rollovers
      /** Rent charged, missed or collected while the clock moved. */
      readonly rent: readonly RentEvent[]
      /**
       * The stat effects as they landed: `statEffects` after clamping to 0..stats.max, so a
       * meal eaten nearly full reports the fullness it really added (GR-11).
       */
      readonly applied: StatChanges
    }
  | { readonly ok: false; readonly error: ActionError }

function actionDefSchema(config: EngineConfig) {
  const max = config.stats.max
  const points = z.int().check(z.gte(0), z.lte(max))
  const effect = z.optional(z.int().check(z.gte(-max), z.lte(max)))
  return z.strictObject({
    durationMin: z.int().check(z.gte(0), z.lte(config.actions.maxDurationMin)),
    cashCost: z.int().check(z.gte(0)),
    energyCost: points,
    statEffects: z.strictObject({ energy: effect, hunger: effect, mood: effect }),
  })
}

/** Checks an action definition against the engine's limits. */
export function validateAction(
  def: unknown,
  config: EngineConfig,
): { ok: true; def: ActionDef } | { ok: false; error: ActionError } {
  const result = actionDefSchema(config).safeParse(def)
  if (result.success) return { ok: true, def: result.data }
  const issues = result.error.issues.map((issue) => issue.path.join('.') || issue.message)
  return { ok: false, error: { code: 'INVALID_ACTION', issues } }
}

/** Looks up an action by id in `actions.catalog`. */
export function findAction(actionId: string, config: EngineConfig): ActionDef | undefined {
  return Object.hasOwn(config.actions.catalog, actionId)
    ? config.actions.catalog[actionId]
    : undefined
}

/** Game minutes an action takes for this player right now. */
export function effectiveDuration(
  def: ActionDef,
  snapshot: GameSnapshot,
  config: EngineConfig,
): number {
  return Math.ceil(def.durationMin * durationMultiplier(snapshot.player.stats, config))
}

export function applyAction(
  snapshot: GameSnapshot,
  action: unknown,
  config: EngineConfig,
): ActionResult {
  const validated = validateAction(action, config)
  if (!validated.ok) return validated
  const { def } = validated
  const { cash, stats } = snapshot.player

  if (cash < def.cashCost) {
    return {
      ok: false,
      error: { code: 'INSUFFICIENT_FUNDS', required: def.cashCost, available: cash },
    }
  }
  if (stats.energy < def.energyCost) {
    return {
      ok: false,
      error: { code: 'INSUFFICIENT_ENERGY', required: def.energyCost, available: stats.energy },
    }
  }

  const durationMin = effectiveDuration(def, snapshot, config)
  const paid: GameSnapshot = {
    ...snapshot,
    player: {
      ...snapshot.player,
      cash: cash - def.cashCost,
      stats: applyStatChanges(stats, { energy: -def.energyCost }, config),
    },
  }
  const advanced = advanceMinutes(paid, durationMin, config)
  const finished = advanced.snapshot
  const before = finished.player.stats
  const after = applyStatChanges(before, def.statEffects, config)
  return {
    ok: true,
    snapshot: { ...finished, player: { ...finished.player, stats: after } },
    durationMin,
    rollovers: advanced.rollovers,
    rent: advanced.rent,
    applied: appliedChanges(before, after, def.statEffects),
  }
}

/** What `changes` really did to `before` (only the stats it names). */
function appliedChanges(before: Stats, after: Stats, changes: StatChanges): StatChanges {
  const applied: Partial<Record<keyof Stats, number>> = {}
  for (const key of Object.keys(changes) as (keyof Stats)[]) {
    if (changes[key] !== undefined) applied[key] = after[key] - before[key]
  }
  return applied
}

/** Performs the catalog action `actionId`. */
export function performAction(
  snapshot: GameSnapshot,
  actionId: string,
  config: EngineConfig,
): ActionResult {
  const def = findAction(actionId, config)
  if (def === undefined) return { ok: false, error: { code: 'UNKNOWN_ACTION', actionId } }
  return applyAction(snapshot, def, config)
}
