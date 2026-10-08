/**
 * What can change a player's clout, shared by the balance schema (schemas/config.ts, which
 * checks `clout.style.appliesTo`) and the engine's clout ledger (src/engine/clout.ts). No
 * imports: Node loads this file directly from scripts/ through schemas/config.ts.
 *
 * - `paycheck`: the first paycheck; `flex`: a flex at a landmark or venue; `club`: a club
 *   night; `event`: an event choice.
 * - `grant`: goal, referral and operator grants (S15); never counts toward goal progress.
 * - `legacy`: clout carried over from a save written before the ledger; `repair`: a correction
 *   made while loading a damaged save.
 * - `item`: an audit record of a wearable bought or sold (item clout is computed from what is
 *   owned, never accumulated, so these entries do not count toward the total).
 * - `premium`: real-money items (S25), counted only up to `clout.caps.byCurrency.usd`.
 */
export const CLOUT_SOURCES = [
  'paycheck',
  'flex',
  'club',
  'event',
  'grant',
  'legacy',
  'repair',
  'item',
  'premium',
] as const
export type CloutSourceId = (typeof CLOUT_SOURCES)[number]

/**
 * Sources the outfit's style may multiply (`clout.style.appliesTo` must stay within these).
 * Never `club`: nightlife is flavour only and never rewarded beyond the configured club clout
 * (user rule, S13 fix cycle 1).
 */
export const STYLED_SOURCES = ['paycheck', 'flex', 'event'] as const
export type StyledSourceId = (typeof STYLED_SOURCES)[number]
