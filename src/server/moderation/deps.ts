import 'server-only'
/**
 * The real dependencies of the /api/mod/* handlers: the server's Supabase clients,
 * MODERATOR_EMAILS, SITE_URL (where sign-in links land), Next's `after` and the per-instance sign-in limiter. Read once per server
 * instance; a change to MODERATOR_EMAILS needs a redeploy (or restart), like any server env.
 */
import moderationJson from '@data/config/moderation.json'
import { after } from 'next/server'
import { log, newCorrelationId } from '@/lib/log'
import { anonServerClient, serverSupabaseEnv, serviceClient } from '@/server/supabase/service'
import { parseModeratorEmails } from './auth'
import { modUrlFrom, type ModRouteDeps } from './handlers'
import { createRateLimiter } from './rateLimit'

const { console: consoleConfig } = moderationJson

const signInLimiter = createRateLimiter(
  consoleConfig.signInMaxPerWindow,
  consoleConfig.signInWindowMs,
)

let deps: ModRouteDeps | undefined

export function modRouteDeps(): ModRouteDeps {
  if (deps !== undefined) return deps
  const env = serverSupabaseEnv()
  deps = {
    configured: env !== null,
    modUrl: modUrlFrom(process.env.SITE_URL),
    allowed: parseModeratorEmails(process.env.MODERATOR_EMAILS),
    getUser: async (token) => {
      if (env === null) return null
      const { data, error } = await serviceClient(env).auth.getUser(token)
      return error !== null ? null : data.user
    },
    rpc: async (fn, args) => {
      if (env === null) throw new Error('Supabase is not configured on this server')
      // The typed client's rpc() is generic over the schema's functions; the handlers name
      // each mod_* function and pass arguments the zod schema already checked.
      const client = serviceClient(env) as unknown as {
        rpc: (
          fn: string,
          args: Readonly<Record<string, unknown>>,
        ) => PromiseLike<{
          data: unknown
          error: { code?: string; message: string } | null
        }>
      }
      return client.rpc(fn, args)
    },
    sendSignInLink: async (email, redirectTo) => {
      if (env === null) return
      const { error } = await anonServerClient(env).auth.signInWithOtp({
        email,
        options: { emailRedirectTo: redirectTo, shouldCreateUser: true },
      })
      if (error !== null) throw error
    },
    afterResponse: (task) => after(task),
    signInLimiter,
    queueLimit: consoleConfig.queueLimit,
    now: () => Date.now(),
    logger: log,
    newCorrelationId,
  }
  return deps
}
