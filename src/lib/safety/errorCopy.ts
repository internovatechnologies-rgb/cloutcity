/**
 * Copy keys for the safety vocabulary, built from the database's snake_case values (copy keys
 * are camelCase): every machine code an RPC can fail with (RPC_ERRORS, S18–S18b, plus `unknown`
 * for no network or an unexpected answer), report reasons and notice kinds. The key types below
 * fail to compile if any value has no string in data/copy/safety.
 */
import { copy, type CopyKey } from '@/lib/copy'
import { snakeToCamel, type SnakeToCamel } from '@/lib/copy/camel'
import type { ApiErrorCode } from '@/lib/supabase/rpc'
import type { NoticeKind, ReportReason } from './reports'
// Copy namespaces this module renders (DEC-11: they load with this module's chunk).
import '@/lib/copy/ns/safety'

/** The copy key for an RPC failure: plain words that say what to do next. */
export function rpcErrorKey(code: ApiErrorCode): CopyKey {
  const key: `safety.rpc.${SnakeToCamel<ApiErrorCode>}` & CopyKey =
    `safety.rpc.${snakeToCamel(code)}`
  return key
}

/** The text for an RPC failure. */
export function rpcErrorText(code: ApiErrorCode): string {
  return copy(rpcErrorKey(code))
}

/** A report reason's label. */
export function reportReasonKey(reason: ReportReason): CopyKey {
  const key: `safety.report.reason.${SnakeToCamel<ReportReason>}` & CopyKey =
    `safety.report.reason.${snakeToCamel(reason)}`
  return key
}

/** What a moderator notice tells the player. */
export function noticeKey(kind: NoticeKind): CopyKey {
  const key: `safety.notice.${SnakeToCamel<NoticeKind>}` & CopyKey =
    `safety.notice.${snakeToCamel(kind)}`
  return key
}
