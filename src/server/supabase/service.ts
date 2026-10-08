import 'server-only'
/**
 * Server-only Supabase clients, one module for every server feature (S18b part 2: /mod; S18c:
 * POST /api/save). The service-role key bypasses RLS, so it lives only here: never NEXT_PUBLIC_,
 * never in a client chunk (`import 'server-only'` fails the build if a client module imports
 * this; src/lib/client-imports.test.ts, src/server/server-boundary.test.ts and
 * scripts/shell-guard.ts check it too, RISK-5).
 *
 * Nothing persists a session: every request brings its own bearer token, checked with
 * `auth.getUser(token)`.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/database.types'

export type ServiceClient = SupabaseClient<Database>

/** What the service-role client needs (S18c cloud saves). */
export interface ServiceEnv {
  readonly url: string
  readonly serviceRoleKey: string
}

/** What the /mod routes need: the service-role client and an anon-key client (S18b). */
export interface ServerSupabaseEnv extends ServiceEnv {
  readonly anonKey: string
}

export interface ServerSupabaseEnvSource {
  readonly NEXT_PUBLIC_SUPABASE_URL: string | undefined
  readonly NEXT_PUBLIC_SUPABASE_ANON_KEY: string | undefined
  readonly SUPABASE_SERVICE_ROLE_KEY: string | undefined
}

/** The URL when it is an http(s) URL, else null. */
function httpUrl(raw: string): string | null {
  if (raw === '') return null
  try {
    const { protocol } = new URL(raw)
    if (protocol !== 'https:' && protocol !== 'http:') return null
  } catch {
    return null
  }
  return raw
}

/** The server's configuration, or null when any part is missing (the routes then fail closed). */
export function serverSupabaseEnv(
  source: ServerSupabaseEnvSource = {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  },
): ServerSupabaseEnv | null {
  const url = httpUrl(source.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? '')
  const anonKey = source.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() ?? ''
  const serviceRoleKey = source.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? ''
  if (url === null || anonKey === '' || serviceRoleKey === '') return null
  return { url, anonKey, serviceRoleKey }
}

/**
 * The project URL (SUPABASE_URL, else the public NEXT_PUBLIC_SUPABASE_URL) and the service-role
 * key, or null when either is missing: the server then has no cloud saves (local-only play).
 */
export function serviceEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ServiceEnv | null {
  const url = httpUrl((env.SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL ?? '').trim())
  const serviceRoleKey = (env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim()
  if (url === null || serviceRoleKey === '') return null
  return { url, serviceRoleKey }
}

const OPTIONS = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
} as const

const clients = new Map<string, ServiceClient>()

/**
 * The service-role client: bypasses RLS. Only for RPCs granted to service_role. One client per
 * configuration, reused across requests; never persists or refreshes a session.
 */
export function serviceClient(env: ServiceEnv): ServiceClient {
  const id = `${env.url}\n${env.serviceRoleKey}`
  let client = clients.get(id)
  if (client === undefined) {
    client = createClient<Database>(env.url, env.serviceRoleKey, OPTIONS)
    clients.set(id, client)
  }
  return client
}

/**
 * An anon-key client with no session, for auth calls made on a visitor's behalf (sending a
 * moderator's sign-in link). A fresh one per call: auth calls can set state on a client.
 */
export function anonServerClient(env: ServerSupabaseEnv): ServiceClient {
  return createClient<Database>(env.url, env.anonKey, OPTIONS)
}
