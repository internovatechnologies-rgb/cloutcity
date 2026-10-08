import { describe, expect, it } from 'vitest'
import { befriend, expectRpcError, newAttestedGuest, newGuest, sql } from './helpers'

async function boostRows(senderId: string) {
  return sql<{ recipient_id: string; ny_day: string }[]>`
    select recipient_id, ny_day::text as ny_day from public.friend_boosts where sender_id = ${senderId}
  `
}

async function nyToday(): Promise<string> {
  const [row] = await sql<{ day: string }[]>`select private.ny_today()::text as day`
  if (row === undefined) throw new Error('no day')
  return row.day
}

describe('send_friend_boost: one per sender per New York day', () => {
  it('sends the first boost of the day to an accepted friend', async () => {
    const [a, b] = await Promise.all([newAttestedGuest(), newAttestedGuest()])
    await befriend(a, b)
    const { data, error } = await a.client.rpc('send_friend_boost', { p_to: b.id })
    expect(error).toBeNull()
    const today = await nyToday()
    expect(data).toEqual([{ boost_id: expect.any(Number), ny_day: today }])
    expect(await boostRows(a.id)).toEqual([{ recipient_id: b.id, ny_day: today }])
  })

  it('refuses a second boost the same day, to the same or another friend', async () => {
    const [a, b, c] = await Promise.all([
      newAttestedGuest(),
      newAttestedGuest(),
      newAttestedGuest(),
    ])
    await befriend(a, b)
    await befriend(c, a)
    expect((await a.client.rpc('send_friend_boost', { p_to: b.id })).error).toBeNull()
    for (const to of [b, c]) {
      const { error, status } = await a.client.rpc('send_friend_boost', { p_to: to.id })
      expectRpcError(error, 'boost_already_sent', 'PT409')
      expect(status).toBe(409)
    }
    expect(await boostRows(a.id)).toHaveLength(1)
  })

  it('lets the recipient boost back: the limit is per sender', async () => {
    const [a, b] = await Promise.all([newAttestedGuest(), newAttestedGuest()])
    await befriend(a, b)
    expect((await a.client.rpc('send_friend_boost', { p_to: b.id })).error).toBeNull()
    expect((await b.client.rpc('send_friend_boost', { p_to: a.id })).error).toBeNull()
  })

  it('10 concurrent boosts to 2 friends: exactly one succeeds and one row is written', async () => {
    const [a, b, c] = await Promise.all([
      newAttestedGuest(),
      newAttestedGuest(),
      newAttestedGuest(),
    ])
    await befriend(a, b)
    await befriend(a, c)
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        a.client.rpc('send_friend_boost', { p_to: i % 2 === 0 ? b.id : c.id }),
      ),
    )
    expect(results.filter((result) => result.error === null)).toHaveLength(1)
    for (const result of results.filter((r) => r.error !== null)) {
      expectRpcError(result.error, 'boost_already_sent', 'PT409')
    }
    expect(await boostRows(a.id)).toHaveLength(1)
  })

  it("yesterday's boost does not block today's", async () => {
    const [a, b] = await Promise.all([newAttestedGuest(), newAttestedGuest()])
    await befriend(a, b)
    await sql`
      insert into public.friend_boosts (sender_id, recipient_id, ny_day)
      values (${a.id}, ${b.id}, private.ny_today() - 1)
    `
    expect((await a.client.rpc('send_friend_boost', { p_to: b.id })).error).toBeNull()
    expect(await boostRows(a.id)).toHaveLength(2)
  })

  it('refuses a player who is not an accepted friend', async () => {
    const [a, b, pending, declined] = await Promise.all([
      newAttestedGuest(),
      newAttestedGuest(),
      newAttestedGuest(),
      newAttestedGuest(),
    ])
    await sql`
      insert into public.friendships (requester_id, addressee_id, status)
      values (${a.id}, ${pending.id}, 'pending'), (${declined.id}, ${a.id}, 'declined')
    `
    for (const to of [b, pending, declined]) {
      const { error } = await a.client.rpc('send_friend_boost', { p_to: to.id })
      expectRpcError(error, 'not_friends', 'PT403')
    }
    expect(await boostRows(a.id)).toHaveLength(0)
  })

  it('refuses yourself, an unknown player and an unattested friend as invalid_target', async () => {
    const a = await newAttestedGuest()
    const unattested = await newGuest()
    await befriend(a, unattested)
    for (const to of [a.id, crypto.randomUUID(), unattested.id]) {
      const { error } = await a.client.rpc('send_friend_boost', { p_to: to })
      expectRpcError(error, 'invalid_target', 'PT400')
    }
    const { error } = await a.client.rpc('send_friend_boost', {
      p_to: null as unknown as string,
    })
    expectRpcError(error, 'invalid_target', 'PT400')
    expect(await boostRows(a.id)).toHaveLength(0)
  })
})

describe('private.ny_day: the New York calendar day', () => {
  it.each([
    // EDT → EST, 2026-11-01: midnight New York is 04:00Z before the change.
    ['2026-11-01T03:59:59Z', '2026-10-31'],
    ['2026-11-01T04:00:00Z', '2026-11-01'],
    // The repeated 1 a.m. hour is still the same day.
    ['2026-11-01T06:30:00Z', '2026-11-01'],
    ['2026-11-02T04:59:59Z', '2026-11-01'],
    ['2026-11-02T05:00:00Z', '2026-11-02'],
    // EST → EDT, 2026-03-08: midnight is 05:00Z; the next midnight is 04:00Z.
    ['2026-03-08T04:59:59Z', '2026-03-07'],
    ['2026-03-08T05:00:00Z', '2026-03-08'],
    ['2026-03-09T03:59:59Z', '2026-03-08'],
    ['2026-03-09T04:00:00Z', '2026-03-09'],
  ])('%s is %s in New York', async (instant, day) => {
    const [row] = await sql<{ day: string }[]>`
      select private.ny_day(${instant}::timestamptz)::text as day
    `
    expect(row?.day).toBe(day)
  })
})
