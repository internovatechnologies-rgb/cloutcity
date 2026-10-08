/**
 * The /mod console's calls to its server routes (S18b part 2), each answer checked with
 * zod/mini. The access token comes from the console's own session (src/lib/supabase/modAuth.ts)
 * and goes only to this origin's /api/mod/* routes.
 */
import * as z from 'zod/mini'
import { REPORT_REASONS } from '@/lib/safety/reports'

const CaseSummarySchema = z.object({
  case_id: z.string(),
  handle: z.nullable(z.string()),
  priority: z.number(),
  reports: z.number(),
  reporters: z.number(),
  trusted_reporters: z.number(),
  brigade: z.boolean(),
  legal_hold: z.boolean(),
  reasons: z.array(z.string()),
  oldest_at: z.string(),
  held: z.boolean(),
  standing: z.string(),
})
export type CaseSummary = z.infer<typeof CaseSummarySchema>

const AppealSchema = z.object({
  appeal_id: z.string(),
  user_id: z.string(),
  handle: z.nullable(z.string()),
  sanction_kind: z.string(),
  sanction_reason: z.string(),
  ends_at: z.nullable(z.string()),
  body: z.string(),
  created_at: z.string(),
})
export type PendingAppeal = z.infer<typeof AppealSchema>

export const QueueSchema = z.object({
  cases: z.array(CaseSummarySchema),
  appeals: z.array(AppealSchema),
})
export type Queue = z.infer<typeof QueueSchema>

const ReportSchema = z.object({
  report_id: z.string(),
  reporter_id: z.nullable(z.string()),
  kind: z.string(),
  reason: z.string(),
  note: z.nullable(z.string()),
  snapshot: z.record(z.string(), z.unknown()),
  trusted: z.boolean(),
  brigade: z.boolean(),
  priority: z.number(),
  legal_hold: z.boolean(),
  status: z.string(),
  created_at: z.string(),
})
export type CaseReport = z.infer<typeof ReportSchema>

export const CaseSchema = z.object({
  case_id: z.string(),
  profile: z.nullable(
    z.object({
      handle: z.nullable(z.string()),
      public_level: z.string(),
      career_path: z.nullable(z.string()),
      created_at: z.string(),
    }),
  ),
  standing: z.string(),
  reports: z.array(ReportSchema),
  holds: z.array(
    z.object({ kind: z.string(), status: z.string(), source: z.string(), created_at: z.string() }),
  ),
  sanctions: z.array(
    z.object({
      kind: z.string(),
      reason: z.string(),
      starts_at: z.string(),
      ends_at: z.nullable(z.string()),
      revoked_at: z.nullable(z.string()),
    }),
  ),
  audit: z.array(
    z.object({ action: z.string(), reason: z.nullable(z.string()), created_at: z.string() }),
  ),
})
export type CaseDetail = z.infer<typeof CaseSchema>

export const MOD_ACTIONS = [
  'dismiss',
  'warn',
  'reset_handle',
  'restrict',
  'suspend',
  'ban',
] as const
export type ModActionName = (typeof MOD_ACTIONS)[number]
export const TIMED_ACTIONS: ReadonlySet<ModActionName> = new Set(['restrict', 'suspend'])
export const REASONED_ACTIONS: ReadonlySet<ModActionName> = new Set([
  'warn',
  'reset_handle',
  'restrict',
  'suspend',
  'ban',
])
export { REPORT_REASONS }

export type ModResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly status: number; readonly code: string }

const ErrorBodySchema = z.object({ code: z.string() })
const OkBodySchema = z.object({ ok: z.literal(true), data: z.unknown() })

async function call<S extends z.ZodMiniType>(
  path: string,
  token: string,
  schema: S,
  init: { readonly method: 'GET' | 'POST'; readonly body?: unknown } = { method: 'GET' },
): Promise<ModResult<z.infer<S>>> {
  let response: Response
  try {
    response = await fetch(path, {
      method: init.method,
      cache: 'no-store',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    })
  } catch {
    return { ok: false, status: 0, code: 'network' }
  }
  const json: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const parsed = ErrorBodySchema.safeParse(json)
    return {
      ok: false,
      status: response.status,
      code: parsed.success ? parsed.data.code : 'unknown',
    }
  }
  const body = OkBodySchema.safeParse(json)
  const data = body.success ? schema.safeParse(body.data.data) : null
  if (data === null || !data.success) return { ok: false, status: response.status, code: 'unknown' }
  return { ok: true, data: data.data }
}

export const fetchQueue = (token: string) => call('/api/mod/queue', token, QueueSchema)

export const fetchCase = (token: string, caseId: string) =>
  call(`/api/mod/case/${encodeURIComponent(caseId)}`, token, CaseSchema)

export const postAction = (token: string, body: Readonly<Record<string, unknown>>) =>
  call('/api/mod/action', token, z.record(z.string(), z.unknown()), { method: 'POST', body })

/** One key per moderator decision: a retry of the same click replays instead of acting twice. */
export function newActionKey(): string {
  return crypto.randomUUID()
}
