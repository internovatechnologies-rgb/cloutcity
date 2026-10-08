import 'server-only'
/**
 * Who may use /mod (S18b): accounts whose email is on MODERATOR_EMAILS, checked on the server on
 * every request. Fails closed: an empty or missing list means nobody; a guest (anonymous)
 * account, an unconfirmed email or a token Supabase does not vouch for is never a moderator.
 * The session must also have been signed in through an emailed link or code (`amr` method
 * `otp`): an address on the list is not proof by itself, since with email confirmations off (the
 * local stack) a password sign-up or a guest setting its email is marked confirmed without
 * anyone reading the inbox, and a password set on an address before its owner signs in would
 * otherwise outlive the owner's confirmation. Emails are compared lower-cased and trimmed, and
 * are never logged.
 */
import * as z from 'zod'

/** The parts of a Supabase Auth user this check reads. */
export interface AuthUserLike {
  readonly id: string
  readonly email?: string | null
  readonly email_confirmed_at?: string | null
  readonly is_anonymous?: boolean | null
}

const EmailSchema = z.email()

/** Normalised for comparison: trimmed and lower-cased. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase()
}

/**
 * MODERATOR_EMAILS: comma-separated addresses. Blank entries and anything that is not an email
 * are dropped (never treated as a wildcard). Missing or empty: nobody.
 */
export function parseModeratorEmails(raw: string | undefined): ReadonlySet<string> {
  const emails = new Set<string>()
  for (const part of (raw ?? '').split(',')) {
    const email = normaliseEmail(part)
    if (email !== '' && EmailSchema.safeParse(email).success) emails.add(email)
  }
  return emails
}

/** True when `email` is on the list. */
export function isAllowedEmail(email: string, allowed: ReadonlySet<string>): boolean {
  return allowed.has(normaliseEmail(email))
}

/** True only for a permanent account with a confirmed email on the list. */
export function isModerator(user: AuthUserLike, allowed: ReadonlySet<string>): boolean {
  if (user.is_anonymous === true) return false
  if (typeof user.email !== 'string' || user.email === '') return false
  if (typeof user.email_confirmed_at !== 'string' || user.email_confirmed_at === '') return false
  return isAllowedEmail(user.email, allowed)
}

/** The token of an `Authorization: Bearer <token>` header, or null. */
export function bearerToken(header: string | null): string | null {
  const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(header?.trim() ?? '')
  return match?.[1] ?? null
}

/** How a session was signed in: an emailed link or code. Refreshed sessions keep their `amr`. */
const INBOX_METHODS: ReadonlySet<string> = new Set(['otp', 'magiclink'])

const AmrPayloadSchema = z.object({
  amr: z.array(z.object({ method: z.string() })),
})

/**
 * The sign-in methods (`amr`) in a JWT's payload. Only read after Supabase has vouched for the
 * token (`getUser`), so the payload is trusted; anything unreadable is no methods.
 */
export function tokenSignInMethods(token: string): readonly string[] {
  const payload = token.split('.')[1]
  if (payload === undefined) return []
  try {
    const parsed = AmrPayloadSchema.safeParse(
      JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')),
    )
    return parsed.success ? parsed.data.amr.map((entry) => entry.method) : []
  } catch {
    return []
  }
}

export type ModeratorCheck =
  | { readonly ok: true; readonly moderatorId: string }
  | { readonly ok: false; readonly status: 401 | 403 }

export interface ModeratorAuthDeps {
  readonly allowed: ReadonlySet<string>
  /** Supabase's `auth.getUser(token)`: the user the token belongs to, or null. */
  readonly getUser: (token: string) => Promise<AuthUserLike | null>
}

/**
 * Checks a request's bearer token: 401 without a valid token, 403 for a valid one that is not a
 * moderator's. Never throws: a failed lookup is a 401.
 */
export async function checkModerator(
  authorization: string | null,
  deps: ModeratorAuthDeps,
): Promise<ModeratorCheck> {
  const token = bearerToken(authorization)
  if (token === null) return { ok: false, status: 401 }
  let user: AuthUserLike | null
  try {
    user = await deps.getUser(token)
  } catch {
    return { ok: false, status: 401 }
  }
  if (user === null) return { ok: false, status: 401 }
  if (deps.allowed.size === 0 || !isModerator(user, deps.allowed)) return { ok: false, status: 403 }
  if (!tokenSignInMethods(token).some((method) => INBOX_METHODS.has(method))) {
    return { ok: false, status: 403 }
  }
  return { ok: true, moderatorId: user.id }
}
