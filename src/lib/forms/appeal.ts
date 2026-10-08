/**
 * The appeal form (S18b): one zod/mini schema for the shared form pattern (GR-1, GR-2), whose
 * messages are copy keys. It mirrors what `public.submit_appeal` refuses (a blank body, one over
 * `moderation.appealMaxChars`); the server checks again and decides.
 */
import * as z from 'zod/mini'
import type { CopyKey } from '@/lib/copy'
import type { NoticeKind } from '@/lib/safety/reports'
import { moderationConfig } from './report'
// The error keys below are rendered by fieldErrors, which needs their namespace loaded.
import '@/lib/copy/ns/safety'

export const APPEAL_FIELDS = ['body'] as const
export type AppealField = (typeof APPEAL_FIELDS)[number]

const ERROR = {
  empty: 'safety.notice.appealEmpty',
  tooLong: 'safety.notice.appealTooLong',
} as const satisfies Record<string, CopyKey>

/** The body as the server stores it: whitespace trimmed from both ends (SQL `btrim` of spaces). */
const trimBody = (body: string) => body.replace(/^ +| +$/g, '')

export function createAppealSchema(maxChars: number = moderationConfig.appealMaxChars) {
  return z.object({
    body: z.string().check(
      z.refine((value) => trimBody(value).trim() !== '', ERROR.empty),
      z.refine((value) => [...trimBody(value)].length <= maxChars, ERROR.tooLong),
    ),
  })
}

/** Notices about a sanction a player can appeal (handle resets cannot be; S18b submit_appeal). */
const APPEALABLE: ReadonlySet<NoticeKind> = new Set(['warning', 'restriction', 'suspension', 'ban'])

export function isAppealable(notice: { kind: NoticeKind; sanctionId: string | null }): boolean {
  return notice.sanctionId !== null && APPEALABLE.has(notice.kind)
}
