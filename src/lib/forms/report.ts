/**
 * The report form (S18b): one zod/mini schema for the shared form pattern (GR-1, GR-2, GR-8),
 * whose messages are copy keys, and the shapes of the report RPCs' answers.
 *
 * The schema mirrors what `public.submit_report` refuses, so the form shows every error at once
 * before anything is sent; the server checks again and decides (reportFieldForRpcError maps its
 * refusals back onto the fields).
 */
import moderationJson from '@data/config/moderation.json'
import * as z from 'zod/mini'
import type { CopyKey } from '@/lib/copy'
import type { ModerationConfig } from '@/lib/data/schemas/config'
import { HANDLE_REPORT_REASONS, REPORT_REASONS, type ReportKind } from '@/lib/safety/reports'
import { containsContactInfo } from '@/lib/safety/textFilter'
import type { RpcErrorCode } from '@/lib/supabase/attestation'
// The error keys below are rendered by fieldErrors, which needs their namespace loaded.
import '@/lib/copy/ns/safety'

/** data/config/moderation.json, validated by ModerationConfigSchema in src/lib/data/data.test.ts. */
export const moderationConfig: ModerationConfig = moderationJson

/** Fields in DOM order, which is also the order focus moves to the first invalid one. */
export const REPORT_FIELDS = ['reason', 'note'] as const
export type ReportField = (typeof REPORT_FIELDS)[number]

/** What the native controls hold: the checked reason radio ('' for none) and the textarea. */
export interface ReportValues {
  readonly reason: string
  readonly note: string
}

export const EMPTY_REPORT_VALUES: ReportValues = { reason: '', note: '' }

const ERROR = {
  reason: 'safety.report.error.reason',
  noteTooLong: 'safety.report.error.noteTooLong',
  noteContact: 'safety.report.error.noteContact',
} as const satisfies Record<string, CopyKey>

/** The note as the server stores it: spaces trimmed from both ends (SQL `btrim`). */
export function trimNote(note: string): string {
  return note.replace(/^ +| +$/g, '')
}

/** Characters as the database counts them (code points, not UTF-16 units). */
const charLength = (value: string) => [...value].length

/** The report form's schema for one kind of report. */
export function createReportSchema(
  kind: ReportKind,
  config: Pick<ModerationConfig, 'noteMaxChars'> = moderationConfig,
) {
  return z.object({
    reason:
      kind === 'handle'
        ? z.enum(HANDLE_REPORT_REASONS, ERROR.reason)
        : z.enum(REPORT_REASONS, ERROR.reason),
    note: z.string().check(
      z.refine((value) => charLength(trimNote(value)) <= config.noteMaxChars, ERROR.noteTooLong),
      z.refine((value) => !containsContactInfo(trimNote(value)), ERROR.noteContact),
    ),
  })
}

/** The field a submit_report refusal belongs under, or null for a form-level message. */
export function reportFieldForRpcError(code: RpcErrorCode | 'unknown'): ReportField | null {
  switch (code) {
    case 'invalid_reason':
      return 'reason'
    case 'note_too_long':
    case 'note_contact_info':
      return 'note'
    default:
      return null
  }
}

/** One row of `submit_report`. */
export const SubmitReportResultSchema = z.object({
  report_id: z.string(),
  duplicate: z.boolean(),
})
export type SubmitReportResult = z.infer<typeof SubmitReportResultSchema>
