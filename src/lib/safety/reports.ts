/**
 * Report and moderation vocabulary shared with the database (S18b). Each list is the exact set a
 * check constraint or RPC in supabase/migrations/*_s18b_safety.sql allows;
 * src/lib/safety/parity.test.ts fails when the two drift apart.
 */

/** Why a player reports another player (submit_report's p_reason). */
export const REPORT_REASONS = [
  'harassment',
  'hate',
  'threats',
  'sexual_content',
  'self_harm',
  'child_safety',
  'spam',
  'scam',
  'impersonation',
  'offensive_name',
  'personal_info',
  'other',
] as const
export type ReportReason = (typeof REPORT_REASONS)[number]

/** The reasons that make sense for a handle on its own. */
export const HANDLE_REPORT_REASONS = [
  'offensive_name',
  'hate',
  'harassment',
  'sexual_content',
  'impersonation',
  'other',
] as const satisfies readonly ReportReason[]

/** What is reported: the player as a whole, or just their handle (S20a adds `message`). */
export const REPORT_KINDS = ['player', 'handle'] as const
export type ReportKind = (typeof REPORT_KINDS)[number]

/** The reasons offered for a kind of report, in display order. */
export function reportReasonsFor(kind: ReportKind): readonly ReportReason[] {
  return kind === 'handle' ? HANDLE_REPORT_REASONS : REPORT_REASONS
}

/**
 * What other players see instead of a handle under a content hold (`private.public_handle`).
 * `player` is an exact term on the handle blocklist, so no real handle can ever look like it.
 */
export const HELD_HANDLE_PLACEHOLDER = 'Player'

/** What list_my_reports shows a reporter: never the outcome for the other player. */
export const MY_REPORT_STATUSES = ['open', 'reviewed'] as const
export type MyReportStatus = (typeof MY_REPORT_STATUSES)[number]

/** Kinds of account_notices rows. */
export const NOTICE_KINDS = [
  'warning',
  'handle_reset',
  'restriction',
  'suspension',
  'ban',
  'appeal_upheld',
  'appeal_overturned',
] as const
export type NoticeKind = (typeof NOTICE_KINDS)[number]
