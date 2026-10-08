import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

/**
 * The running local Supabase stack, for `*.supabase.spec.ts` specs that seed or check rows
 * (playwright.supabase.config.ts reads the same `supabase status`). The stack is shared by every
 * checkout: specs only add their own rows and never reset it.
 */
export interface LocalStack {
  readonly apiUrl: string
  readonly anonKey: string
  readonly serviceRoleKey: string
  readonly dbUrl: string
  readonly mailpitUrl: string
}

/** The address the opt-in suite lists in MODERATOR_EMAILS (playwright.supabase.config.ts). */
export const E2E_MODERATOR_EMAIL = 'mod-e2e@cloutcity.test'

export function localStack(): LocalStack {
  let output: string
  try {
    output = execFileSync(
      join(import.meta.dirname, '../../../node_modules/.bin/supabase'),
      ['status', '-o', 'env'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    )
  } catch {
    throw new Error('Local Supabase is not running. Start it with `npx supabase start`.')
  }
  const value = (name: string): string => {
    const found = output.match(new RegExp(`^${name}="?([^"\\n]*)"?$`, 'm'))?.[1]
    if (found === undefined || found === '') throw new Error(`supabase status has no ${name}`)
    return found
  }
  const mailpit = output.match(/^(?:MAILPIT_URL|INBUCKET_URL)="?([^"\n]*)"?$/m)?.[1]
  if (mailpit === undefined) throw new Error('supabase status has no MAILPIT_URL')
  return {
    apiUrl: value('API_URL'),
    anonKey: value('ANON_KEY'),
    serviceRoleKey: value('SERVICE_ROLE_KEY'),
    dbUrl: value('DB_URL'),
    mailpitUrl: mailpit,
  }
}
