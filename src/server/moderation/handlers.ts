import 'server-only'
/**
 * The /api/mod/* route handlers (S18b part 2), with every dependency injected so the auth
 * matrix, validation and error mapping are unit-tested (handlers.test.ts). The route files are
 * thin wrappers over these with src/server/moderation/deps.ts.
 *
 * Every response is JSON, `Cache-Control: no-store` and `X-Robots-Tag: noindex`, and carries
 * the request's correlation id (also passed to every mod_* RPC and written to its audit row).
 * Every request but sign-in needs `Authorization: Bearer <access token>` of a moderator
 * (auth.ts): 401 without a valid token, 403 for anyone not on MODERATOR_EMAILS. Bodies are
 * checked with zod before anything runs. Nothing here logs an email or a note.
 */
import { createHash } from 'node:crypto'
import * as z from 'zod'
import type { Logger } from '@/lib/log'
import { parseRpcError } from '@/lib/supabase/attestation'
import { REPORT_REASONS } from '@/lib/safety/reports'
import { checkModerator, isAllowedEmail, type AuthUserLike } from './auth'
import type { RateLimiter } from './rateLimit'

export interface ModRpcResponse {
  readonly data: unknown
  readonly error: { readonly code?: string; readonly message: string } | null
}

export interface ModRouteDeps {
  /** False when the server has no Supabase service configuration: every route answers 503. */
  readonly configured: boolean
  /**
   * The console's absolute URL (`<SITE_URL>/mod`), where sign-in links land; null when SITE_URL
   * is not set, and sign-in then answers 503 for everyone. Never built from the request, whose
   * Host header the caller controls.
   */
  readonly modUrl: string | null
  readonly allowed: ReadonlySet<string>
  readonly getUser: (token: string) => Promise<AuthUserLike | null>
  /** Calls a service-role RPC. */
  readonly rpc: (fn: string, args: Readonly<Record<string, unknown>>) => Promise<ModRpcResponse>
  /** Sends a sign-in link to an allowlisted email. */
  readonly sendSignInLink: (email: string, redirectTo: string) => Promise<void>
  /** Runs work after the response is sent (Next's `after`), so timing reveals nothing. */
  readonly afterResponse: (task: () => Promise<void>) => void
  readonly signInLimiter: RateLimiter
  readonly queueLimit: number
  readonly now: () => number
  readonly logger: Logger
  readonly newCorrelationId: () => string
}

const HEADERS = {
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow',
  'Content-Type': 'application/json',
} as const

export function respond(body: unknown, status: number, correlationId: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...HEADERS, 'X-Correlation-Id': correlationId },
  })
}

const failure = (code: string, status: number, correlationId: string) =>
  respond({ ok: false, code }, status, correlationId)

/**
 * `<SITE_URL>/mod` from the server's SITE_URL (an http(s) origin, any path ignored), or null when
 * it is missing or not one.
 */
export function modUrlFrom(siteUrl: string | undefined): string | null {
  const raw = siteUrl?.trim() ?? ''
  if (raw === '') return null
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    return new URL('/mod', url.origin).toString()
  } catch {
    return null
  }
}

/** The HTTP status an RPC error maps to: SQLSTATE PTxyz → xyz, anything else 500. */
export function statusOfRpcError(error: { readonly code?: string }): number {
  const match = /^PT([1-5]\d\d)$/.exec(error.code ?? '')
  return match === null ? 500 : Number(match[1])
}

/** The client's IP from the proxy headers (first hop), hashed so it is never kept in the clear. */
export function clientKey(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  const ip = forwarded || request.headers.get('x-real-ip')?.trim() || 'unknown'
  return createHash('sha256').update(ip).digest('hex')
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return (await request.json()) as unknown
  } catch {
    return undefined
  }
}

const SignInSchema = z.strictObject({ email: z.email().max(254) })

/**
 * POST /api/mod/sign-in {email}. The answer is the same 202 whether or not the address is on
 * the list, and the link is sent after the response, so neither the body nor the timing says
 * who is a moderator. Rate limited per client IP.
 */
export async function handleSignIn(request: Request, deps: ModRouteDeps): Promise<Response> {
  const correlationId = deps.newCorrelationId()
  const logger = deps.logger.withCorrelationId(correlationId)
  if (!deps.signInLimiter.take(clientKey(request), deps.now())) {
    logger.info('Moderator sign-in rate limited')
    return failure('rate_limited', 429, correlationId)
  }
  const body = SignInSchema.safeParse(await readJson(request))
  if (!body.success) return failure('invalid_argument', 400, correlationId)
  const redirectTo = deps.modUrl
  if (!deps.configured || redirectTo === null) {
    logger.warn('Moderator sign-in is not configured on this server')
    return failure('not_configured', 503, correlationId)
  }
  const email = body.data.email
  if (isAllowedEmail(email, deps.allowed)) {
    deps.afterResponse(async () => {
      try {
        await deps.sendSignInLink(email, redirectTo)
      } catch (error) {
        logger.warn('A moderator sign-in link was not sent', {
          error: error instanceof Error ? error.name : typeof error,
        })
      }
    })
  }
  logger.info('Moderator sign-in requested')
  return respond({ ok: true }, 202, correlationId)
}

type Authorised = {
  readonly moderatorId: string
  readonly correlationId: string
  readonly logger: Logger
}

/** The moderator behind the request, or the response to send instead. */
async function authorise(
  request: Request,
  deps: ModRouteDeps,
): Promise<Authorised | { readonly response: Response }> {
  const correlationId = deps.newCorrelationId()
  if (!deps.configured) return { response: failure('not_configured', 503, correlationId) }
  const check = await checkModerator(request.headers.get('authorization'), {
    allowed: deps.allowed,
    getUser: deps.getUser,
  })
  const logger = deps.logger.withCorrelationId(correlationId)
  if (!check.ok) {
    logger.info('A /mod request was refused', { status: check.status })
    return {
      response: failure(
        check.status === 401 ? 'not_authenticated' : 'not_moderator',
        check.status,
        correlationId,
      ),
    }
  }
  return { moderatorId: check.moderatorId, correlationId, logger }
}

/** Sends an RPC's answer back: its data on success, its machine code and status on failure. */
async function forward(
  auth: Authorised,
  deps: ModRouteDeps,
  fn: string,
  args: Readonly<Record<string, unknown>>,
): Promise<Response> {
  let response: ModRpcResponse
  try {
    response = await deps.rpc(fn, args)
  } catch (error) {
    auth.logger.error('A moderation RPC failed to run', {
      fn,
      error: error instanceof Error ? error.name : typeof error,
    })
    return failure('unknown', 502, auth.correlationId)
  }
  if (response.error !== null) {
    const status = statusOfRpcError(response.error)
    const code = parseRpcError(response.error)
    const level = status >= 500 ? 'error' : 'info'
    auth.logger[level]('A moderation RPC refused', { fn, status, code })
    return failure(code, status, auth.correlationId)
  }
  auth.logger.info('A moderation RPC ran', { fn })
  return respond({ ok: true, data: response.data }, 200, auth.correlationId)
}

/** GET /api/mod/queue: open cases by priority, and pending appeals. */
export async function handleQueue(request: Request, deps: ModRouteDeps): Promise<Response> {
  const auth = await authorise(request, deps)
  if ('response' in auth) return auth.response
  return forward(auth, deps, 'mod_queue', {
    p_moderator_id: auth.moderatorId,
    p_limit: deps.queueLimit,
  })
}

const UuidSchema = z.uuid()

/** GET /api/mod/case/[id]: one case with its reports, holds, sanctions and history. */
export async function handleCase(
  request: Request,
  caseId: string,
  deps: ModRouteDeps,
): Promise<Response> {
  const auth = await authorise(request, deps)
  if ('response' in auth) return auth.response
  if (!UuidSchema.safeParse(caseId).success) {
    return failure('invalid_argument', 400, auth.correlationId)
  }
  return forward(auth, deps, 'mod_case', { p_moderator_id: auth.moderatorId, p_case: caseId })
}

const common = {
  caseId: z.uuid(),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  note: z.optional(z.string().max(500)),
}
const reason = z.enum(REPORT_REASONS)
const days = z.int().min(1).max(365)

/** A moderator action: what the /mod console sends. */
export const ModActionSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('dismiss'), ...common, abusive: z.boolean() }),
  z.strictObject({ action: z.literal('warn'), ...common, reason }),
  z.strictObject({ action: z.literal('reset_handle'), ...common, reason }),
  z.strictObject({ action: z.literal('restrict'), ...common, reason, days }),
  z.strictObject({ action: z.literal('suspend'), ...common, reason, days }),
  z.strictObject({ action: z.literal('ban'), ...common, reason }),
  z.strictObject({ action: z.literal('resolve_appeal'), ...common, overturn: z.boolean() }),
  z.strictObject({ action: z.literal('set_legal_hold'), ...common, hold: z.boolean() }),
])
export type ModAction = z.infer<typeof ModActionSchema>

/** The mod_* RPC and its arguments for an action. */
export function rpcForAction(
  action: ModAction,
  moderatorId: string,
  correlationId: string,
): { readonly fn: string; readonly args: Readonly<Record<string, unknown>> } {
  const base = {
    p_moderator_id: moderatorId,
    p_case: action.caseId,
    p_idempotency_key: action.idempotencyKey,
    p_correlation_id: correlationId,
    ...(action.note === undefined || action.note.trim() === '' ? {} : { p_note: action.note }),
  }
  switch (action.action) {
    case 'dismiss':
      return { fn: 'mod_dismiss', args: { ...base, p_abusive: action.abusive } }
    case 'warn':
    case 'reset_handle':
    case 'ban':
      return { fn: `mod_${action.action}`, args: { ...base, p_reason: action.reason } }
    case 'restrict':
    case 'suspend':
      return {
        fn: `mod_${action.action}`,
        args: { ...base, p_reason: action.reason, p_days: action.days },
      }
    case 'resolve_appeal':
      return { fn: 'mod_resolve_appeal', args: { ...base, p_overturn: action.overturn } }
    case 'set_legal_hold':
      return { fn: 'mod_set_legal_hold', args: { ...base, p_hold: action.hold } }
  }
}

/** POST /api/mod/action: one audited moderator action. 409 when someone resolved it first. */
export async function handleAction(request: Request, deps: ModRouteDeps): Promise<Response> {
  const auth = await authorise(request, deps)
  if ('response' in auth) return auth.response
  const body = ModActionSchema.safeParse(await readJson(request))
  if (!body.success) return failure('invalid_argument', 400, auth.correlationId)
  const { fn, args } = rpcForAction(body.data, auth.moderatorId, auth.correlationId)
  return forward(auth, deps, fn, args)
}
