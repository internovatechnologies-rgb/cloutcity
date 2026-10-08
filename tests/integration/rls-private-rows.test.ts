import type { SupabaseClient } from '@supabase/supabase-js'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  anonClient,
  befriend,
  newAttestedGuest,
  serviceClient,
  sql,
  type Client,
  type Guest,
} from './helpers'

/** Table names vary per case, so writes go through the untyped client surface. */
const loose = (client: Client) => client as unknown as SupabaseClient

interface PrivateTable {
  readonly table: string
  /** Seeds a row involving `owner` (and `partner` for two-party rows); returns its key. */
  seed(owner: Guest, partner: Guest): Promise<{ column: string; value: string | number }>
  /** Who may read the row. */
  readonly parties: 'owner' | 'both'
  /** A column a client might try to change. */
  readonly update: Record<string, unknown>
  /** The columns a client may select (default every column; saves hides its flags, S18c). */
  readonly columns?: string
  /** A row a client might try to insert for themselves. */
  insert(owner: Guest, partner: Guest): Record<string, unknown>
}

async function insertOne(table: string, row: Record<string, unknown>, key: string) {
  const { data, error } = await loose(serviceClient()).from(table).insert(row).select(key).single()
  if (error !== null) throw error
  return (data as unknown as Record<string, string | number>)[key] as string | number
}

const CASES: readonly PrivateTable[] = [
  {
    table: 'profiles',
    parties: 'owner',
    seed: async (owner) => ({ column: 'id', value: owner.id }),
    update: { attested: false },
    insert: (owner) => ({ id: owner.id }),
  },
  {
    table: 'saves',
    parties: 'owner',
    seed: async (owner) => ({
      column: 'user_id',
      value: await insertOne(
        'saves',
        { user_id: owner.id, save_version: 6, data: { cash: 150 } },
        'user_id',
      ),
    }),
    update: { data: { cash: 1_000_000 } },
    insert: (owner) => ({ user_id: owner.id, save_version: 6, data: {} }),
    columns: 'user_id, save_version, revision, data',
  },
  {
    table: 'friendships',
    parties: 'both',
    seed: async (owner, partner) => {
      await befriend(owner, partner)
      const [row] = await sql<{ id: string }[]>`
        select id from public.friendships where requester_id = ${owner.id}
      `
      return { column: 'id', value: row?.id ?? '' }
    },
    update: { status: 'declined' },
    insert: (owner, partner) => ({
      requester_id: partner.id,
      addressee_id: owner.id,
      status: 'accepted',
    }),
  },
  {
    table: 'friend_boosts',
    parties: 'both',
    seed: async (owner, partner) => {
      const [row] = await sql<{ id: string }[]>`
        insert into public.friend_boosts (sender_id, recipient_id, ny_day)
        values (${owner.id}, ${partner.id}, private.ny_today() - 3)
        returning id::text
      `
      return { column: 'id', value: Number(row?.id) }
    },
    update: { recipient_id: '00000000-0000-0000-0000-000000000000' },
    insert: (owner, partner) => ({
      sender_id: owner.id,
      recipient_id: partner.id,
      ny_day: '2026-01-02',
    }),
  },
  {
    table: 'roommates',
    parties: 'both',
    seed: async (owner, partner) => {
      const [low, high] = [owner.id, partner.id].sort()
      return {
        column: 'id',
        value: await insertOne(
          'roommates',
          { user_low: low, user_high: high, home_id: 'queens-room', invited_by: owner.id },
          'id',
        ),
      }
    },
    update: { status: 'active' },
    insert: (owner, partner) => {
      const [low, high] = [owner.id, partner.id].sort()
      return { user_low: low, user_high: high, home_id: 'manhattan-loft', invited_by: owner.id }
    },
  },
  {
    table: 'referrals',
    parties: 'both',
    seed: async (owner, partner) => ({
      column: 'id',
      value: await insertOne('referrals', { inviter_id: owner.id, invitee_id: partner.id }, 'id'),
    }),
    update: { status: 'rewarded' },
    insert: (owner, partner) => ({ inviter_id: partner.id, invitee_id: owner.id }),
  },
]

describe.each(CASES)('$table: private rows', (spec) => {
  let owner: Guest
  let partner: Guest
  let stranger: Guest
  let key: { column: string; value: string | number }

  beforeAll(async () => {
    ;[owner, partner, stranger] = await Promise.all([
      newAttestedGuest(),
      newAttestedGuest(),
      newAttestedGuest(),
    ])
    key = await spec.seed(owner, partner)
  })

  const read = (client: Client) =>
    loose(client)
      .from(spec.table)
      .select(spec.columns ?? '*')
      .eq(key.column, key.value)

  it('the owner reads it', async () => {
    const { data, error } = await read(owner.client)
    expect(error).toBeNull()
    expect(data).toHaveLength(1)
  })

  it(`the other party ${spec.parties === 'both' ? 'reads it' : 'cannot read it'}`, async () => {
    const { data, error } = await read(partner.client)
    expect(error).toBeNull()
    expect(data).toHaveLength(spec.parties === 'both' ? 1 : 0)
  })

  it('a stranger reads nothing, even listing the whole table', async () => {
    expect((await read(stranger.client)).data).toEqual([])
    const all = await loose(stranger.client)
      .from(spec.table)
      .select(spec.columns ?? '*')
    expect(all.error).toBeNull()
    for (const row of (all.data ?? []) as unknown as Record<string, unknown>[]) {
      expect(Object.values(row)).not.toContain(owner.id)
    }
  })

  it('a visitor with no session reads nothing', async () => {
    const { data, error } = await read(anonClient())
    expect(data ?? []).toEqual([])
    expect(error?.code).toBe('42501')
  })

  it('no client can insert, update or delete, not even a party', async () => {
    for (const player of [owner, partner, stranger]) {
      const client = loose(player.client)
      const results = await Promise.all([
        client.from(spec.table).insert(spec.insert(player, player === owner ? partner : owner)),
        client.from(spec.table).update(spec.update).eq(key.column, key.value),
        client.from(spec.table).delete().eq(key.column, key.value),
      ])
      for (const { error } of results) expect(error?.code).toBe('42501')
    }
    const anon = loose(anonClient())
    for (const { error } of await Promise.all([
      anon.from(spec.table).insert(spec.insert(owner, partner)),
      anon.from(spec.table).update(spec.update).eq(key.column, key.value),
      anon.from(spec.table).delete().eq(key.column, key.value),
    ])) {
      expect(error?.code).toBe('42501')
    }
    const { data } = await read(owner.client)
    expect(data).toHaveLength(1)
  })
})

describe('live_stats: public read, server write', () => {
  it('a visitor with no session reads every seeded key', async () => {
    const { data, error } = await anonClient().from('live_stats').select('key, value')
    expect(error).toBeNull()
    expect(data?.map((row) => row.key).sort()).toEqual([
      'players_online',
      'players_total',
      'visits_all_time',
      'visits_today',
    ])
  })

  it('neither a visitor nor a player can change a number', async () => {
    const player = await newAttestedGuest()
    for (const client of [anonClient(), player.client]) {
      const results = await Promise.all([
        client.from('live_stats').update({ value: 1_000_000 }).eq('key', 'players_online'),
        loose(client).from('live_stats').insert({ key: 'players_online', value: 5 }),
        client.from('live_stats').delete().eq('key', 'players_online'),
      ])
      for (const { error } of results) expect(error?.code).toBe('42501')
    }
    expect((await anonClient().from('live_stats').select('key')).data).toHaveLength(4)
  })
})
