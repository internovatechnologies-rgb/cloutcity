/**
 * Adversarial probes against the S18 privilege model: races, exact clock edges, PostgREST
 * embedding and counting, GraphQL, other schemas, sequences, account deletion and requests
 * that carry the wrong identity. Each one is a way a client could try to get around RLS or
 * the attestation gate.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type postgres from 'postgres'
import { describe, expect, inject, it } from 'vitest'
import {
  anonClient,
  asRequest,
  befriend,
  errorOf,
  expectRpcError,
  newAttestedGuest,
  newGuest,
  serviceClient,
  sql,
  welcomeRecord,
} from './helpers'
import { toAttestationArgs } from '@/lib/supabase/attestation'

describe('attest_and_consent under pressure', () => {
  it('10 concurrent calls: all succeed, one attestation time and one recorded time win', async () => {
    const guest = await newGuest()
    const base = Date.now() - 120_000
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        guest.client.rpc(
          'attest_and_consent',
          toAttestationArgs({ ...welcomeRecord(), attestedAt: base + i * 1000 }),
        ),
      ),
    )
    for (const { error } of results) expect(error).toBeNull()
    const [row] = await sql<{ attested_at: Date; recorded: Date; n: number }[]>`
      select attested_at, attestation_recorded_at as recorded,
        (select count(*)::int from public.profiles where id = ${guest.id}) as n
      from public.profiles where id = ${guest.id}
    `
    expect(row?.n).toBe(1)
    const rows = results.map(
      (r) => r.data as unknown as { attested_at: string; attestation_recorded_at: string },
    )
    // Every caller saw the same, final first attestation and recorded time.
    expect(new Set(rows.map((r) => new Date(r.attested_at).getTime()))).toEqual(
      new Set([row?.attested_at.getTime()]),
    )
    expect(new Set(rows.map((r) => new Date(r.attestation_recorded_at).getTime()))).toEqual(
      new Set([row?.recorded.getTime()]),
    )
  })

  it('accepts exactly now() + 5 minutes and 2026-01-01T00:00:00Z; refuses one microsecond past either', async () => {
    const guest = await newGuest()
    const claims = { sub: guest.id, role: 'authenticated' }
    const call = (tx: postgres.TransactionSql, attested: string, consented: string) =>
      errorOf(
        tx,
        (sp) => sp`
        select public.attest_and_consent(true, ${attested}::timestamptz, '2026-10-06',
          ${consented}::timestamptz, 'ours')
      `,
      )
    const results = await asRequest('authenticated', claims, async (tx) => ({
      atEdge: await errorOf(
        tx,
        (sp) => sp`
          select public.attest_and_consent(true, now() + interval '5 minutes', '2026-10-07',
            now() + interval '5 minutes', 'ours')
        `,
      ),
      pastFuture: await errorOf(
        tx,
        (sp) => sp`
          select public.attest_and_consent(true, now() + interval '5 minutes 1 microsecond',
            '2026-10-08', now(), 'ours')
        `,
      ),
      pastFutureConsent: await errorOf(
        tx,
        (sp) => sp`
          select public.attest_and_consent(true, now(), '2026-10-08',
            now() + interval '5 minutes 1 microsecond', 'ours')
        `,
      ),
      earliest: await call(tx, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
      beforeEarliest: await call(tx, '2025-12-31T23:59:59.999999Z', '2026-01-01T00:00:00Z'),
      beforeEarliestConsent: await call(tx, '2026-01-01T00:00:00Z', '2025-12-31T23:59:59.999999Z'),
    }))
    expect(results.atEdge).toBeNull()
    expect(results.earliest).toBeNull()
    for (const key of [
      'pastFuture',
      'pastFutureConsent',
      'beforeEarliest',
      'beforeEarliestConsent',
    ] as const) {
      expect(results[key]?.message, key).toBe('invalid_timestamp')
    }
  })
})

describe('identity edge cases', () => {
  it('the service role calling player RPCs gets not_authenticated (it is no player)', async () => {
    const service = serviceClient() as unknown as SupabaseClient
    for (const [fn, args] of [
      ['assert_attested', {}],
      ['send_friend_boost', { p_to: crypto.randomUUID() }],
      ['set_audio_choice', { p_choice: 'ours' }],
      ['attest_and_consent', toAttestationArgs(welcomeRecord())],
    ] as const) {
      const { error } = await service.rpc(fn, args)
      expectRpcError(error, 'not_authenticated', 'PT401')
    }
  })

  it('role authenticated with no sub claim: every RPC refuses with not_authenticated', async () => {
    const results = await asRequest('authenticated', { role: 'authenticated' }, async (tx) => ({
      assert: await errorOf(tx, (sp) => sp`select public.assert_attested()`),
      boost: await errorOf(
        tx,
        (sp) => sp`select * from public.send_friend_boost(gen_random_uuid())`,
      ),
      audio: await errorOf(tx, (sp) => sp`select public.set_audio_choice('ours')`),
      attest: await errorOf(
        tx,
        (sp) => sp`select public.attest_and_consent(true, now(), '2026-10-06', now(), 'ours')`,
      ),
    }))
    for (const [name, error] of Object.entries(results)) {
      expect(error?.message, name).toBe('not_authenticated')
    }
  })

  it('a sub claim naming another player still reads only that row set (RLS keys on the JWT)', async () => {
    // Sanity check on the harness itself: impersonation here is the postgres superuser forging
    // claims, which a client cannot do without the JWT secret.
    const [a, b] = await Promise.all([newAttestedGuest(), newAttestedGuest()])
    const ids = await asRequest(
      'authenticated',
      { sub: a.id, role: 'authenticated' },
      (tx) => tx<{ id: string }[]>`select id from public.profiles where id in (${a.id}, ${b.id})`,
    )
    expect(ids.map((row) => row.id)).toEqual([a.id])
  })
})

describe('RLS through PostgREST features', () => {
  it('embedding a party row never reveals the other player profile', async () => {
    const [a, b] = await Promise.all([newAttestedGuest(), newAttestedGuest()])
    await befriend(a, b)
    const { error: boostError } = await a.client.rpc('send_friend_boost', { p_to: b.id })
    expect(boostError).toBeNull()
    const client = a.client as unknown as SupabaseClient
    const { data, error } = await client
      .from('friend_boosts')
      .select(
        'id, sender:profiles!friend_boosts_sender_id_fkey(id, consented_at), recipient:profiles!friend_boosts_recipient_id_fkey(id, consented_at)',
      )
    expect(error).toBeNull()
    expect(data).toHaveLength(1)
    const row = data?.[0] as unknown as { sender: { id: string } | null; recipient: unknown }
    expect(row.sender?.id).toBe(a.id)
    expect(row.recipient).toBeNull()

    const { data: viaProfiles } = await client
      .from('profiles')
      .select('id, friend_boosts!friend_boosts_recipient_id_fkey(id)')
    expect(viaProfiles).toEqual([{ id: a.id, friend_boosts: [] }])
  })

  it("a stranger's or= filters, embeddings and counts see none of another player's rows", async () => {
    const [a, b, stranger] = await Promise.all([
      newAttestedGuest(),
      newAttestedGuest(),
      newAttestedGuest(),
    ])
    await befriend(a, b)
    const client = stranger.client as unknown as SupabaseClient
    for (const table of ['profiles', 'friendships', 'grants', 'purchases', 'saves']) {
      const column =
        table === 'profiles' ? 'id' : table === 'friendships' ? 'requester_id' : 'user_id'
      const { data, error } = await client
        .from(table)
        // saves hides its flag columns from clients (S18c): name the readable ones.
        .select(table === 'saves' ? 'user_id, data' : '*')
        .or(`${column}.eq.${a.id},${column}.eq.${b.id},${column}.neq.${stranger.id}`)
      expect(error, table).toBeNull()
      expect(data, table).toEqual([])
    }
    const head = await client.from('profiles').select('*', { count: 'exact', head: true })
    expect(head.count).toBe(1)
    const friendCount = await client.from('friendships').select('*', { count: 'exact', head: true })
    expect(friendCount.count).toBe(0)
    const embedded = await client
      .from('friendships')
      .select('*, profiles!friendships_requester_id_fkey(*)')
    expect(embedded.data).toEqual([])
  })

  it('a visitor with no session can neither count nor embed private tables', async () => {
    const client = anonClient() as unknown as SupabaseClient
    for (const table of ['profiles', 'grants', 'friend_boosts']) {
      const head = await client.from(table).select('*', { count: 'exact', head: true })
      expect(head.count ?? 0, table).toBe(0)
      expect(head.status, table).toBeGreaterThanOrEqual(400)
    }
    const embed = await client.from('live_stats').select('key, profiles(*)')
    expect(embed.error).not.toBeNull()
  })
})

describe('other doors', () => {
  it('a player cannot set attested on their own row, by REST or GraphQL', async () => {
    const guest = await newGuest()
    const client = guest.client as unknown as SupabaseClient
    const rest = await client.from('profiles').update({ attested: true }).eq('id', guest.id)
    expect(rest.error).not.toBeNull()
    const upsert = await client.from('profiles').upsert({ id: guest.id, attested: true })
    expect(upsert.error).not.toBeNull()

    const { data: session } = await guest.client.auth.getSession()
    const res = await fetch(`${inject('apiUrl')}/graphql/v1`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        apikey: inject('anonKey'),
        authorization: `Bearer ${session.session?.access_token ?? ''}`,
      },
      body: JSON.stringify({
        query: `mutation { updateprofilesCollection(set: { attested: true }, atMost: 1) { affectedCount } }`,
      }),
    })
    const body = (await res.json()) as { data?: unknown; errors?: unknown[] }
    expect(body.errors?.length ?? 0).toBeGreaterThan(0)

    const [row] = await sql<{ attested: boolean }[]>`
      select attested from public.profiles where id = ${guest.id}
    `
    expect(row?.attested).toBe(false)
  })

  it('the private schema and its helpers are unreachable over the API', async () => {
    const guest = await newAttestedGuest()
    const client = guest.client as unknown as SupabaseClient
    for (const fn of ['require_attestation', 'ny_today', 'are_friends', 'handle_new_user']) {
      const { data, error } = await client.schema('private').rpc(fn, {})
      expect(data, fn).toBeNull()
      expect(error, fn).not.toBeNull()
    }
  })

  it('no client role may use any sequence in public', async () => {
    const rows = await sql<{ name: string; role: string }[]>`
      select c.relname as name, r.role
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      cross join unnest(array['anon', 'authenticated']) as r(role)
      where n.nspname = 'public' and c.relkind = 'S'
        and has_sequence_privilege(r.role, c.oid, 'usage,select,update')
    `
    expect(rows).toEqual([])
  })

  it('no S18 table is published to realtime yet (S29 adds channel policies first)', async () => {
    const rows = await sql<{ name: string }[]>`
      select tablename as name from pg_publication_tables where schemaname = 'public'
    `
    expect(rows).toEqual([])
  })

  it('no column in any app schema stores a birth year or age', async () => {
    const rows = await sql<{ schema: string; table: string; column: string }[]>`
      select table_schema as schema, table_name as table, column_name as column
      from information_schema.columns
      where table_schema in ('public', 'private', 'graphql_public')
        and (column_name ilike '%birth%' or column_name ilike '%year%' or column_name ~* '(^|_)age($|_)')
    `
    expect(rows).toEqual([])
  })
})

describe('grants and account deletion', () => {
  async function seed(userId: string) {
    const [grant] = await sql<{ id: string }[]>`
      insert into public.grants (user_id, kind, idempotency_key, cash_amount, cap_amount,
        clout_cap, eligibility, reason, issued_by)
      values (${userId}, 'boost_reward', ${`probe:${crypto.randomUUID()}`}, 10, 10, 0, '{}',
        'probe', 'system')
      returning id
    `
    return grant?.id ?? ''
  }

  it('applied_at set together with another column, reset to null, or moved: all refused', async () => {
    const guest = await newAttestedGuest()
    const id = await seed(guest.id)
    await expect(
      sql`update public.grants set applied_at = now(), cash_amount = 0 where id = ${id}`,
    ).rejects.toMatchObject({ message: 'grants_append_only' })
    await sql`update public.grants set applied_at = now() where id = ${id}`
    for (const change of [
      sql`update public.grants set applied_at = null where id = ${id}`,
      sql`update public.grants set applied_at = applied_at + interval '1 second' where id = ${id}`,
    ]) {
      await expect(change).rejects.toMatchObject({ message: 'grants_append_only' })
    }
  })

  it('deleting an account removes its private rows and keeps its payment records, unlinked', async () => {
    const [a, b] = await Promise.all([newAttestedGuest(), newAttestedGuest()])
    await befriend(a, b)
    const grantId = await seed(a.id)
    await sql`update public.grants set applied_at = now() where id = ${grantId}`
    const [purchase] = await sql<{ id: string }[]>`
      insert into public.purchases (user_id, item_id, price_tier, amount_cents,
        stripe_checkout_session_id, status)
      values (${a.id}, 'probe-item', 'tier1', 299, ${`cs_test_${crypto.randomUUID()}`}, 'paid')
      returning id
    `
    await sql`
      insert into public.entitlements (user_id, item_id, source, purchase_id)
      values (${a.id}, 'probe-item', 'purchase', ${purchase?.id ?? ''})
    `
    await sql`
      insert into public.entitlements (user_id, item_id, source, grant_id)
      values (${a.id}, 'probe-grant-item', 'grant', ${grantId})
    `
    await sql`
      insert into public.friend_boosts (sender_id, recipient_id, ny_day, grant_id)
      values (${a.id}, ${b.id}, private.ny_today(), ${grantId})
    `
    await sql`
      insert into public.saves (user_id, save_version, data) values (${a.id}, 6, '{}')
    `

    const { error } = await serviceClient().auth.admin.deleteUser(a.id)
    expect(error).toBeNull()

    const [left] = await sql<Record<string, number>[]>`
      select
        (select count(*)::int from public.profiles where id = ${a.id}) as profiles,
        (select count(*)::int from public.grants where user_id = ${a.id}) as grants,
        (select count(*)::int from public.entitlements where user_id = ${a.id}) as entitlements,
        (select count(*)::int from public.friendships where requester_id = ${a.id}) as friendships,
        (select count(*)::int from public.friend_boosts where sender_id = ${a.id}) as boosts,
        (select count(*)::int from public.saves where user_id = ${a.id}) as saves,
        (select count(*)::int from public.purchases where id = ${purchase?.id ?? ''} and user_id is null) as unlinked
    `
    expect(left).toEqual({
      profiles: 0,
      grants: 0,
      entitlements: 0,
      friendships: 0,
      boosts: 0,
      saves: 0,
      unlinked: 1,
    })
  })
})

describe('friend boosts on city time', () => {
  it('stores the New York day of the server clock, not UTC', async () => {
    const [a, b] = await Promise.all([newAttestedGuest(), newAttestedGuest()])
    await befriend(a, b)
    const { data, error } = await a.client.rpc('send_friend_boost', { p_to: b.id })
    expect(error).toBeNull()
    const [row] = await sql<{ expected: string }[]>`
      select ((now() at time zone 'America/New_York')::date)::text as expected
    `
    expect(data?.[0]?.ny_day).toBe(row?.expected)
  })

  it('a boost sent at 23:59 New York time and one at 00:00 the next day are both allowed', async () => {
    const [a, b] = await Promise.all([newAttestedGuest(), newAttestedGuest()])
    await sql`
      insert into public.friend_boosts (sender_id, recipient_id, ny_day)
      values (${a.id}, ${b.id}, private.ny_day('2026-11-01T03:59:59Z')),
             (${a.id}, ${b.id}, private.ny_day('2026-11-01T04:00:00Z'))
    `
    await expect(
      sql`
        insert into public.friend_boosts (sender_id, recipient_id, ny_day)
        values (${a.id}, ${b.id}, private.ny_day('2026-11-01T23:59:59-05:00'))
      `,
    ).rejects.toMatchObject({ code: '23505' })
  })
})
