/**
 * What a goal can be about, and the parts of a run prestige can reset or keep (S15), shared by
 * the progression schema (schemas/config.ts, which checks data/config/progression.json) and the
 * engine (src/engine/goals.ts, src/engine/prestige.ts). No imports: Node loads this file directly
 * from scripts/ through schemas/config.ts.
 *
 * Goal facts, each read from saved state (src/engine/goals.ts `syncGoals`):
 * - `first-paycheck`: the first paycheck's clout has been paid;
 * - `first-outfit`: the player owns at least one wearable bought this run (not a look kept
 *   through prestige);
 * - `first-landmark-visit`: the player has visited a landmark (`player.visited`);
 * - `first-club-night`: a club has paid out a night's clout (`player.clubNights`);
 * - `first-friend`: a friend has accepted (friends arrive in a later task; until then the goal
 *   is configured `available: false` and shows as coming soon);
 * - `clout-level`: the player's goal clout (earned, never granted) holds the goal's level.
 */
export const GOAL_FACTS = [
  'first-paycheck',
  'first-outfit',
  'first-landmark-visit',
  'first-club-night',
  'first-friend',
  'clout-level',
] as const
export type GoalFact = (typeof GOAL_FACTS)[number]

/**
 * The parts of a save prestige can act on. Every part is listed exactly once, in either
 * `prestige.resets` or `prestige.keeps`.
 */
export const PRESTIGE_PARTS = [
  'cash',
  'stats',
  'home',
  'rent',
  'inventory',
  'clout',
  'flex',
  'clubNights',
  'visited',
  'events',
  'goals',
  'clock',
  'speed',
  'grants',
  'prestige',
  'premium',
] as const
export type PrestigePart = (typeof PRESTIGE_PARTS)[number]

/** Parts prestige must reset: a new run starts from zero clout with fresh goals. */
export const PRESTIGE_MUST_RESET = ['clout', 'goals'] as const satisfies readonly PrestigePart[]

/**
 * Parts prestige must keep: the personal clock never runs backwards, the grant log is the audit
 * trail, prestige itself is what is earned, and premium (real-money) clout is the player's.
 */
export const PRESTIGE_MUST_KEEP = [
  'clock',
  'speed',
  'grants',
  'prestige',
  'premium',
] as const satisfies readonly PrestigePart[]
