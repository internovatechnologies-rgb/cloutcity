/**
 * S18a handles and the public profile against the real database: generated handles, the
 * filter, uniqueness under a race, quarantine, change limits, rate limits and what other players
 * can see. Change and rate limits are reached by backdating rows with direct SQL, so the suite
 * never waits for real time to pass.
 */
import { randomInt } from 'node:crypto'
import blocklistJson from '@data/moderation/handle-blocklist.json'
import wordsJson from '@data/copy/handleWords.json'
import { describe, expect, it } from 'vitest'
import { HandleBlocklistSchema, HandleWordsSchema } from '@/lib/data/schemas/handles'
import { HANDLE_PATTERN, MyProfileSchema, handlesConfig } from '@/lib/forms/handle'
import { flattenBlocklist, handleAllowed } from '@/lib/handles/filter'
import { handleKey, handleSkeleton } from '@/lib/handles/normalise'
import { toAttestationArgs } from '@/lib/supabase/attestation'
import {
  anonClient,
  expectRpcError,
  newAttestedGuest,
  newGuest,
  serviceClient,
  sql,
  welcomeRecord,
  type Guest,
} from './helpers'

const terms = flattenBlocklist(HandleBlocklistSchema.parse(blocklistJson))
const words = HandleWordsSchema.parse(wordsJson)

/** The handle on attest_and_consent's returned profile row (its generated type is opaque). */
function attestedHandle(row: unknown): string {
  return (row as { handle?: string | null } | null)?.handle ?? ''
}

async function myProfile(guest: Guest) {
  const { data, error } = await guest.client.rpc('get_my_profile')
  if (error !== null) throw error
  expect(data).toHaveLength(1)
  return MyProfileSchema.parse(data[0])
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

/** A handle no one has ever used that passes the format rule and the filter. */
async function freshHandle(prefix = 'Tq'): Promise<string> {
  for (;;) {
    let candidate = prefix
    while (candidate.length < 14) candidate += ALPHABET[randomInt(ALPHABET.length)]
    if (!HANDLE_PATTERN.test(candidate) || !handleAllowed(candidate, terms)) continue
    const rows = await sql<{ n: number }[]>`
      select count(*)::int as n from public.handles where handle_key = ${handleKey(candidate)}
    `
    if (rows[0]?.n === 0) return candidate
  }
}

async function setHandle(guest: Guest, handle: string) {
  return guest.client.rpc('set_handle', { p_handle: handle })
}

async function checkHandle(guest: Guest, handle: string) {
  const { data, error } = await guest.client.rpc('check_handle', { p_handle: handle })
  if (error !== null) throw error
  return data
}

/** Moves every recorded handle change of the player back by `hours`. */
async function backdateChanges(guest: Guest, hours: number): Promise<void> {
  await sql`
    update private.handle_changes
    set changed_at = changed_at - make_interval(hours => ${hours})
    where user_id = ${guest.id}
  `
}

async function handleRow(handle: string) {
  const [row] = await sql<
    {
      user_id: string | null
      source: string
      released_at: Date | null
      quarantine_until: Date | null
      retired_at: Date | null
    }[]
  >`
    select user_id, source, released_at, quarantine_until, retired_at
    from public.handles where handle_key = ${handleKey(handle)}
  `
  return row
}

describe('generated handles', () => {
  it('attesting gives the player an AdjectiveNoun## handle from data/copy/handleWords.json', async () => {
    const guest = await newGuest()
    const { data, error } = await guest.client.rpc(
      'attest_and_consent',
      toAttestationArgs(welcomeRecord()),
    )
    expect(error).toBeNull()
    const handle = attestedHandle(data)
    const match = /^([A-Z][a-z]+)([A-Z][a-z]+)(\d{2})$/.exec(handle)
    expect(match, handle).not.toBeNull()
    const pairs = words.adjectives.flatMap((a) => words.nouns.map((n) => a + n))
    expect(pairs).toContain(`${match?.[1]}${match?.[2]}`)
    expect(Number(match?.[3])).toBeGreaterThanOrEqual(10)
    expect(handleAllowed(handle, terms)).toBe(true)

    const profile = await myProfile(guest)
    expect(profile).toEqual({
      handle,
      public_level: 'nobody',
      career_path: null,
      avatar: {},
      handle_generated: true,
      free_handle_change: true,
      handle_changes_left: handlesConfig.changes.perWindow,
      next_handle_change_at: null,
    })
    expect(await handleRow(handle)).toMatchObject({
      user_id: guest.id,
      source: 'generated',
      released_at: null,
    })
  })

  it('an unattested guest has no handle; attesting again keeps the first one', async () => {
    const guest = await newGuest()
    const { data: own } = await guest.client.from('profiles').select('handle').eq('id', guest.id)
    expect(own).toEqual([{ handle: null }])

    const args = toAttestationArgs(welcomeRecord())
    const first = await guest.client.rpc('attest_and_consent', args)
    const again = await guest.client.rpc('attest_and_consent', args)
    expect(attestedHandle(again.data)).toBe(attestedHandle(first.data))
    const [row] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.handles where user_id = ${guest.id}
    `
    expect(row?.n).toBe(1)
  })

  it('a profile inserted already attested (service role) gets a handle too', async () => {
    const guest = await newGuest()
    await sql`delete from public.profiles where id = ${guest.id}`
    await sql`
      insert into public.profiles (id, attested, attested_at, attestation_recorded_at)
      values (${guest.id}, true, now(), now())
    `
    const [row] = await sql<{ handle: string | null }[]>`
      select handle from public.profiles where id = ${guest.id}
    `
    expect(row?.handle ?? '').toMatch(HANDLE_PATTERN)
  })

  it('every attested profile has a handle, and every handle is unique case-insensitively', async () => {
    const [row] = await sql<{ missing: number; dupes: number }[]>`
      select
        (select count(*)::int from public.profiles where attested and handle is null) as missing,
        (select count(*)::int from (
          select private.handle_key(handle) from public.profiles where handle is not null
          group by 1 having count(*) > 1
        ) d) as dupes
    `
    expect(row).toEqual({ missing: 0, dupes: 0 })
  })

  it('every word pair passes the database filter too', async () => {
    const [row] = await sql<{ blocked: string[] | null }[]>`
      select array_agg(a.word || n.word) as blocked
      from private.handle_words a cross join private.handle_words n
      where a.kind = 'adjective' and n.kind = 'noun'
        and not private.handle_allowed(a.word || n.word)
    `
    expect(row?.blocked).toBeNull()
  })
})

describe('the filter: database and TypeScript agree', () => {
  const samples = [
    'Shithead',
    'Sh1tH34d',
    'F4gg0t',
    'Fuuuuck',
    'F_u_c_k',
    'CloutCity_Staff',
    'Admin1',
    'Admiin',
    'Mod',
    'Mod99',
    'Modern',
    'NYPD_Officer',
    'NYPD_0ff1cer',
    'MayorOfQueens',
    'Fdny_Chief',
    'TikTokSupport',
    'Badminton',
    'Cocktail',
    'Cocktail_Cock',
    'Peacock',
    'Therapist',
    'Scunthorpe',
    'Raccoon',
    'DykerHeights',
    'CalmTaxi',
    'Bob',
    'Glass',
    'Classic',
    'Settings',
    'SwiftTaxi42',
    'KnishIt',
    'Knish17',
  ]

  it('handle_allowed, handle_skeleton and handle_format_ok match their twins', async () => {
    const rows = await sql<
      { handle: string; allowed: boolean; skeleton: string; format: boolean }[]
    >`
      select h as handle, private.handle_allowed(h) as allowed,
        private.handle_skeleton(h) as skeleton, private.handle_format_ok(h) as format
      from unnest(${[...samples, 'ab', '1ab', 'a__b', 'ab_', 'A12', 'Abéc', 'a'.repeat(17)]}::text[]) as h
    `
    for (const row of rows) {
      expect(row.skeleton, row.handle).toBe(handleSkeleton(row.handle))
      expect(row.format, row.handle).toBe(HANDLE_PATTERN.test(row.handle))
      if (row.format) expect(row.allowed, row.handle).toBe(handleAllowed(row.handle, terms))
    }
  })

  it.each([
    ['profanity in leetspeak', 'Sh1tH34d'],
    ['a staff name', 'CloutCity_Staff'],
    ['a reserved word with digits', 'Mod99'],
    ['an agency', 'NYPD_0ff1cer'],
  ])('check_handle and set_handle refuse %s', async (_why, handle) => {
    const guest = await newAttestedGuest()
    expect(await checkHandle(guest, handle)).toBe('not_allowed')
    const { error } = await setHandle(guest, handle)
    expectRpcError(error, 'handle_not_allowed', 'PT400')
  })

  it('an allowlisted word is not refused for the term inside it', async () => {
    const guest = await newAttestedGuest()
    expect(await checkHandle(guest, 'Badminton')).not.toBe('not_allowed')
  })

  it.each(['ab', '9lives', 'a__b', 'abc_', 'Ab c', 'A123'])(
    'an invalid format (%j) is invalid, never silently rewritten',
    async (handle) => {
      const guest = await newAttestedGuest()
      const before = (await myProfile(guest)).handle
      expect(await checkHandle(guest, handle)).toBe('invalid')
      expectRpcError((await setHandle(guest, handle)).error, 'handle_invalid', 'PT400')
      expect((await myProfile(guest)).handle).toBe(before)
    },
  )
})

describe('choosing a handle', () => {
  it('the first change is free and the handle is stored exactly as typed', async () => {
    const guest = await newAttestedGuest()
    const handle = await freshHandle('Free')
    expect(await checkHandle(guest, handle)).toBe('available')
    const { data, error } = await setHandle(guest, handle)
    expect(error).toBeNull()
    expect(data?.[0]).toMatchObject({ handle, handle_generated: false, free_handle_change: false })
    expect(await checkHandle(guest, handle)).toBe('current')
    const { data: own } = await guest.client.from('profiles').select('handle').eq('id', guest.id)
    expect(own).toEqual([{ handle }])
  })

  it('setting the handle you already have changes nothing and uses no allowance', async () => {
    const guest = await newAttestedGuest()
    const { handle } = await myProfile(guest)
    const { error } = await setHandle(guest, handle ?? '')
    expect(error).toBeNull()
    expect((await myProfile(guest)).free_handle_change).toBe(true)
  })

  it('case and underscores do not make a different handle', async () => {
    const [a, b] = await Promise.all([newAttestedGuest(), newAttestedGuest()])
    const handle = await freshHandle('Case')
    expect((await setHandle(a, handle)).error).toBeNull()
    const lookAlike = `${handle.slice(0, 2).toUpperCase()}_${handle.slice(2).toLowerCase()}`
    expect(await checkHandle(b, lookAlike)).toBe('taken')
    expectRpcError((await setHandle(b, lookAlike)).error, 'handle_taken', 'PT409')
    // The owner may restyle their own handle.
    expect(await checkHandle(a, lookAlike)).toBe('available')
  })

  it('10 players racing for one handle: exactly one wins, the rest get handle_taken', async () => {
    const guests = await Promise.all(Array.from({ length: 10 }, () => newAttestedGuest()))
    const handle = await freshHandle('Race')
    const results = await Promise.all(guests.map((guest) => setHandle(guest, handle)))
    const winners = results.filter((result) => result.error === null)
    expect(winners).toHaveLength(1)
    for (const result of results) {
      if (result.error !== null) expectRpcError(result.error, 'handle_taken', 'PT409')
    }
    const [row] = await sql<{ n: number; owners: number }[]>`
      select count(*)::int as n,
        (select count(*)::int from public.profiles
          where private.handle_key(handle) = ${handleKey(handle)}) as owners
      from public.handles where handle_key = ${handleKey(handle)}
    `
    expect(row).toEqual({ n: 1, owners: 1 })
    // Each loser keeps their generated handle.
    for (const [i, guest] of guests.entries()) {
      if (results[i]?.error !== null) expect((await myProfile(guest)).handle_generated).toBe(true)
    }
  })
})

describe('change limits', () => {
  it('after the free change: 24 h apart, then at most 2 in 30 days', async () => {
    const guest = await newAttestedGuest()
    const [h1, h2, h3, h4] = await Promise.all([
      freshHandle('Lim'),
      freshHandle('Lim'),
      freshHandle('Lim'),
      freshHandle('Lim'),
    ])

    expect((await setHandle(guest, h1)).error).toBeNull()
    // Within 24 h of the free change.
    expectRpcError((await setHandle(guest, h2)).error, 'handle_change_limited', 'PT429')
    const waiting = await myProfile(guest)
    expect(waiting.free_handle_change).toBe(false)
    expect(waiting.handle_changes_left).toBe(2)
    const next = Date.parse(waiting.next_handle_change_at ?? '')
    expect(next - Date.now()).toBeGreaterThan(23 * 3_600_000)
    expect(next - Date.now()).toBeLessThanOrEqual(24 * 3_600_000)

    await backdateChanges(guest, 25)
    expect((await setHandle(guest, h2)).error).toBeNull()
    expectRpcError((await setHandle(guest, h3)).error, 'handle_change_limited', 'PT429')

    await backdateChanges(guest, 25)
    expect((await setHandle(guest, h3)).error).toBeNull()
    expect((await myProfile(guest)).handle_changes_left).toBe(0)

    // Two counted changes in the window: a day later is still too soon.
    await backdateChanges(guest, 25)
    expectRpcError((await setHandle(guest, h4)).error, 'handle_change_limited', 'PT429')
    const full = await myProfile(guest)
    const opens = Date.parse(full.next_handle_change_at ?? '')
    expect(opens - Date.now()).toBeGreaterThan(27 * 24 * 3_600_000)

    // Once the older counted change leaves the 30-day window, a slot opens.
    await backdateChanges(guest, 30 * 24)
    expect((await setHandle(guest, h4)).error).toBeNull()
    expect((await myProfile(guest)).handle).toBe(h4)
  })

  it('a refused change leaves the handle, the allowance and the old name alone', async () => {
    const [a, b] = await Promise.all([newAttestedGuest(), newAttestedGuest()])
    const taken = await freshHandle('Own')
    expect((await setHandle(b, taken)).error).toBeNull()
    const before = await myProfile(a)
    expectRpcError((await setHandle(a, taken)).error, 'handle_taken', 'PT409')
    expect(await myProfile(a)).toEqual(before)
    expect(await handleRow(before.handle ?? '')).toMatchObject({ user_id: a.id, released_at: null })
  })
})

describe('quarantine and moderator resets', () => {
  it('a released handle is held for its owner for 30 days, then anyone may take it', async () => {
    const [a, b] = await Promise.all([newAttestedGuest(), newAttestedGuest()])
    const [first, second] = await Promise.all([freshHandle('Qua'), freshHandle('Qua')])
    expect((await setHandle(a, first)).error).toBeNull()
    await backdateChanges(a, 25)
    expect((await setHandle(a, second)).error).toBeNull()

    const released = await handleRow(first)
    expect(released?.user_id).toBe(a.id)
    const held = (released?.quarantine_until?.getTime() ?? 0) - Date.now()
    expect(held).toBeGreaterThan(29 * 24 * 3_600_000)
    expect(held).toBeLessThanOrEqual(30 * 24 * 3_600_000)

    expect(await checkHandle(b, first)).toBe('taken')
    expectRpcError((await setHandle(b, first)).error, 'handle_taken', 'PT409')
    expect(await checkHandle(a, first)).toBe('available')

    await sql`
      update public.handles set quarantine_until = now() - interval '1 second'
      where handle_key = ${handleKey(first)}
    `
    expect(await checkHandle(b, first)).toBe('available')
    expect((await setHandle(b, first)).error).toBeNull()
    expect(await handleRow(first)).toMatchObject({ user_id: b.id, released_at: null })
  })

  it("a deleted account's handle is quarantined, not freed", async () => {
    const [a, b] = await Promise.all([newAttestedGuest(), newAttestedGuest()])
    const handle = await freshHandle('Del')
    expect((await setHandle(a, handle)).error).toBeNull()
    const { error } = await serviceClient().auth.admin.deleteUser(a.id)
    expect(error).toBeNull()
    const row = await handleRow(handle)
    expect(row?.user_id).toBeNull()
    expect(row?.quarantine_until?.getTime() ?? 0).toBeGreaterThan(Date.now())
    expect(await checkHandle(b, handle)).toBe('taken')
  })

  it('moderator_reset_handle retires the handle for good and generates a new one', async () => {
    const [a, b] = await Promise.all([newAttestedGuest(), newAttestedGuest()])
    const handle = await freshHandle('Ret')
    expect((await setHandle(a, handle)).error).toBeNull()

    const refused = await a.client.rpc('moderator_reset_handle', {
      p_user_id: a.id,
      p_reason: 'self-service',
    })
    expect(refused.error).not.toBeNull()

    // S18b: the service role goes through the audited mod_reset_handle; the function itself
    // is only reachable from SQL (tests/integration/moderation.test.ts covers the audited path).
    const viaApi = await serviceClient().rpc('moderator_reset_handle', {
      p_user_id: a.id,
      p_reason: 'impersonation report',
    })
    expect(viaApi.error).not.toBeNull()
    const [reset] = await sql<{ handle: string }[]>`
      select public.moderator_reset_handle(${a.id}, 'impersonation report') as handle
    `
    const profile = await myProfile(a)
    expect(profile.handle).toBe(reset?.handle)
    expect(profile.handle_generated).toBe(true)
    expect(await handleRow(handle)).toMatchObject({ quarantine_until: null })
    expect((await handleRow(handle))?.retired_at).not.toBeNull()

    await sql`
      update public.handles set released_at = released_at - interval '400 days'
      where handle_key = ${handleKey(handle)}
    `
    expect(await checkHandle(b, handle)).toBe('taken')
    expect(await checkHandle(a, handle)).toBe('taken')
    await backdateChanges(a, 25)
    expectRpcError((await setHandle(a, handle)).error, 'handle_taken', 'PT409')
  })

  it('moderator_reset_handle refuses a missing reason or an unknown player', async () => {
    const guest = await newAttestedGuest()
    await expect(sql`select public.moderator_reset_handle(${guest.id}, ' ')`).rejects.toThrow(
      'invalid_argument',
    )
    await expect(
      sql`select public.moderator_reset_handle('00000000-0000-4000-8000-000000000000', 'test')`,
    ).rejects.toThrow('invalid_target')
  })
})

describe('rate limits', () => {
  it(`check_handle allows ${handlesConfig.rateLimits.checkHandle.max} calls a minute, then 429`, async () => {
    const guest = await newAttestedGuest()
    const { max } = handlesConfig.rateLimits.checkHandle
    for (let i = 0; i < max; i += 1) await checkHandle(guest, 'Abc')
    const { error } = await guest.client.rpc('check_handle', { p_handle: 'Abc' })
    expectRpcError(error, 'rate_limited', 'PT429')
    // set_handle draws on the same allowance.
    expectRpcError((await setHandle(guest, 'Abcdef')).error, 'rate_limited', 'PT429')

    await sql`
      update private.rate_limits set window_started_at = window_started_at - interval '61 seconds'
      where user_id = ${guest.id}
    `
    expect(await checkHandle(guest, 'Abc')).not.toBeNull()
  })

  it('the public profile reads share one limit per player', async () => {
    const [guest, other] = await Promise.all([newAttestedGuest(), newAttestedGuest()])
    const { handle } = await myProfile(other)
    await guest.client.rpc('get_public_profile', { p_handle: handle ?? '' })
    await sql`
      update private.rate_limits set hits = ${handlesConfig.rateLimits.publicProfile.max}
      where user_id = ${guest.id} and bucket = 'publicProfile'
    `
    expectRpcError(
      (await guest.client.rpc('get_public_profile', { p_handle: handle ?? '' })).error,
      'rate_limited',
      'PT429',
    )
    expectRpcError(
      (await guest.client.rpc('get_public_profiles', { p_ids: [other.id] })).error,
      'rate_limited',
      'PT429',
    )
    // The other player's own allowance is untouched.
    expect((await other.client.rpc('get_public_profiles', { p_ids: [guest.id] })).error).toBeNull()
  })
})

describe('what other players see', () => {
  it('get_public_profile returns exactly handle, public_level, career_path and avatar', async () => {
    const [viewer, target] = await Promise.all([newAttestedGuest(), newAttestedGuest()])
    const { handle } = await myProfile(target)
    const { data, error } = await viewer.client.rpc('get_public_profile', {
      p_handle: handle?.toLowerCase() ?? '',
    })
    expect(error).toBeNull()
    expect(data).toHaveLength(1)
    expect(Object.keys(data?.[0] ?? {}).sort()).toEqual([
      'avatar',
      'career_path',
      'handle',
      'public_level',
    ])
    expect(data?.[0]).toEqual({ handle, public_level: 'nobody', career_path: null, avatar: {} })
  })

  it('shows the projection S18c writes (service role), and nothing else', async () => {
    const [viewer, target] = await Promise.all([newAttestedGuest(), newAttestedGuest()])
    const avatar = { body: 'b2', cosmetics: ['cap-taxi', 'premium-chain'] }
    await sql`
      update public.profiles
      set public_level = 'known', career_path = 'streamer', avatar = ${sql.json(avatar)}
      where id = ${target.id}
    `
    const { handle } = await myProfile(target)
    const { data } = await viewer.client.rpc('get_public_profile', { p_handle: handle ?? '' })
    expect(data?.[0]).toEqual({ handle, public_level: 'known', career_path: 'streamer', avatar })
  })

  it('the profile columns refuse values S18c must never write', async () => {
    const guest = await newAttestedGuest()
    for (const assignment of [
      sql`public_level = 'superstar'`,
      sql`career_path = 'Not An Id'`,
      sql`avatar = '[]'::jsonb`,
      sql`avatar = ${sql.json({ blob: 'x'.repeat(5000) })}`,
      sql`handle = 'a__b'`,
    ]) {
      await expect(
        sql`update public.profiles set ${assignment} where id = ${guest.id}`,
      ).rejects.toMatchObject({ code: '23514' })
    }
  })

  it('unknown, invalid, released and retired handles all get the same 404', async () => {
    const [viewer, owner] = await Promise.all([newAttestedGuest(), newAttestedGuest()])
    const [released, retired, unused] = await Promise.all([
      freshHandle('Gone'),
      freshHandle('Gone'),
      freshHandle('Gone'),
    ])
    expect((await setHandle(owner, released)).error).toBeNull()
    await backdateChanges(owner, 25)
    expect((await setHandle(owner, retired)).error).toBeNull()
    await sql`select public.moderator_reset_handle(${owner.id}, 'test')`

    const errors: ({ code?: string; message: string } | null)[] = []
    for (const handle of [unused, released, retired, 'x', '']) {
      const { data, error } = await viewer.client.rpc('get_public_profile', { p_handle: handle })
      expect(data, handle).toBeNull()
      errors.push(error)
    }
    for (const error of errors) {
      expectRpcError(error, 'profile_not_found', 'PT404')
      expect(error).toEqual(errors[0])
    }
  })

  it('get_public_profiles: four public fields plus the id asked for; hidden ids left out', async () => {
    const [viewer, a, b] = await Promise.all([
      newAttestedGuest(),
      newAttestedGuest(),
      newAttestedGuest(),
    ])
    const unattested = await newGuest()
    const unknown = '00000000-0000-4000-8000-000000000000'
    const { data, error } = await viewer.client.rpc('get_public_profiles', {
      p_ids: [a.id, b.id, a.id, unattested.id, unknown],
    })
    expect(error).toBeNull()
    expect(data?.map((row) => row.id).sort()).toEqual([a.id, b.id].sort())
    for (const row of data ?? []) {
      expect(Object.keys(row).sort()).toEqual([
        'avatar',
        'career_path',
        'handle',
        'id',
        'public_level',
      ])
    }
  })

  it(`get_public_profiles takes at most ${handlesConfig.publicProfilesMaxIds} ids`, async () => {
    const viewer = await newAttestedGuest()
    const ids = (n: number) =>
      Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)
    const max = handlesConfig.publicProfilesMaxIds
    expect((await viewer.client.rpc('get_public_profiles', { p_ids: ids(max) })).data).toEqual([])
    const over = await viewer.client.rpc('get_public_profiles', { p_ids: ids(max + 1) })
    expectRpcError(over.error, 'too_many_ids', 'PT400')
    const none = await viewer.client.rpc('get_public_profiles', {
      p_ids: null as unknown as string[],
    })
    expectRpcError(none.error, 'invalid_argument', 'PT400')
  })

  it('clients cannot read the handles table or other players’ profile rows', async () => {
    const [viewer, other] = await Promise.all([newAttestedGuest(), newAttestedGuest()])
    const table = await viewer.client.from('handles').select('*')
    expect(table.error).not.toBeNull()
    const rows = await viewer.client.from('profiles').select('handle').eq('id', other.id)
    expect(rows.data).toEqual([])
  })

  it('every profile RPC refuses anon (no session)', async () => {
    const anon = anonClient()
    for (const result of await Promise.all([
      anon.rpc('get_my_profile'),
      anon.rpc('check_handle', { p_handle: 'Abc' }),
      anon.rpc('set_handle', { p_handle: 'Abc' }),
      anon.rpc('get_public_profile', { p_handle: 'Abc' }),
      anon.rpc('get_public_profiles', { p_ids: [] }),
    ])) {
      expect(result.error).not.toBeNull()
    }
  })
})
