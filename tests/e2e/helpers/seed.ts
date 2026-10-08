import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import postgres from 'postgres'
import { toAttestationArgs } from '@/lib/supabase/attestation'
import type { LocalStack } from './stack'

/**
 * Seeding for `*.supabase.spec.ts`: fresh attested guests and permanent accounts made the way
 * the app and the integration suite make them, plus direct SQL for checks. Only adds rows.
 */
const OPTIONS = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
} as const

export interface SeedUser {
  readonly id: string
  readonly client: SupabaseClient
  readonly accessToken: string
}

async function attest(client: SupabaseClient): Promise<void> {
  const now = Date.now()
  const { error } = await client.rpc(
    'attest_and_consent',
    toAttestationArgs({
      status: 'complete',
      attested: true,
      attestedAt: now - 60_000,
      consentVersion: '2026-10-06',
      consentedAt: now - 60_000,
      audioChoice: 'ours',
    }),
  )
  if (error !== null) throw error
}

export async function newGuest(stack: LocalStack): Promise<SeedUser> {
  const client = createClient(stack.apiUrl, stack.anonKey, OPTIONS)
  const { data, error } = await client.auth.signInAnonymously()
  if (error !== null || data.user === null || data.session === null) {
    throw error ?? new Error('no session')
  }
  await attest(client)
  return { id: data.user.id, client, accessToken: data.session.access_token }
}

/** A confirmed email account that is not on MODERATOR_EMAILS. */
export async function newPermanentUser(stack: LocalStack): Promise<SeedUser> {
  const email = `e2e-${crypto.randomUUID()}@example.test`
  const password = `pw-${crypto.randomUUID()}`
  const admin = createClient(stack.apiUrl, stack.serviceRoleKey, OPTIONS)
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true })
  if (created.error !== null) throw created.error
  const client = createClient(stack.apiUrl, stack.anonKey, OPTIONS)
  const { data, error } = await client.auth.signInWithPassword({ email, password })
  if (error !== null || data.session === null) throw error ?? new Error('no session')
  return { id: created.data.user.id, client, accessToken: data.session.access_token }
}

export function database(stack: LocalStack) {
  return postgres(stack.dbUrl, { max: 1, onnotice: () => undefined })
}
