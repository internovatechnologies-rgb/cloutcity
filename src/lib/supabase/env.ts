/**
 * The browser's Supabase configuration (S05): the project URL and its public anon key, from
 * NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY (inlined at build time). Both are
 * optional: without them the game plays local-only (CLAUDE.md "Player state is local-first"),
 * which is also how the e2e suite runs.
 *
 * No zod: this runs in the welcome island right after the attestation and must stay tiny.
 */

export interface SupabaseEnv {
  readonly url: string
  readonly anonKey: string
}

export interface SupabaseEnvSource {
  readonly url: string | undefined
  readonly anonKey: string | undefined
}

// Each variable is named in full so Next.js inlines it (a computed lookup is never replaced).
const buildEnv = (): SupabaseEnvSource => ({
  url: process.env.NEXT_PUBLIC_SUPABASE_URL,
  anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
})

function httpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value)
    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
}

/**
 * The configuration, or null when it is missing or unusable: a blank or absent value, or a URL
 * that is not http(s). Never throws; the caller plays local-only on null.
 */
export function supabaseEnv(source: SupabaseEnvSource = buildEnv()): SupabaseEnv | null {
  const url = source.url?.trim() ?? ''
  const anonKey = source.anonKey?.trim() ?? ''
  if (url === '' || anonKey === '' || !httpUrl(url)) return null
  return { url, anonKey }
}
