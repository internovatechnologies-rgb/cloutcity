/**
 * S18b player safety against the real database: blocks (both ways, with the friendship and
 * roommate link ended and an undo window), mutes, reports (private, filtered, rate-limited,
 * idempotent), auto-hide by trusted reporters and the standing gate. Time-based rules are reached
 * by backdating rows with direct SQL; caps are tested inside a rolled-back transaction with a
 * lowered setting, so no other suite ever sees it.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import moderationJson from '@data/config/moderation.json'
import { describe, expect, it } from 'vitest'
import { ModerationConfigSchema } from '@/lib/data/schemas/config'
import { HELD_HANDLE_PLACEHOLDER } from '@/lib/safety/reports'
import { TEXT_FILTER_FIXTURES } from '@/lib/safety/textFilter.fixtures'
import { containsContactInfo, normalizeText } from '@/lib/safety/textFilter'
import {
  asRequest,
  befriend,
  errorOf,
  expectRpcError,
  newAttestedGuest,
  serviceClient,
  sql,
  type Guest,
} from './helpers'

const config = ModerationConfigSchema.parse(moderationJson)

const key = () => `it-${crypto.randomUUID()}`

async function report(
  from: Guest,
  target: string,
  options: { kind?: string; reason?: string; note?: string; key?: string } = {},
) {
  return from.client.rpc('submit_report', {
    p_target: target,
    p_kind: options.kind ?? 'player',
    p_reason: options.reason ?? 'harassment',
    p_note: options.note ?? '',
    p_idempotency_key: options.key ?? key(),
  })
}

async function reportRow(id: string) {
  const [row] = await sql<
    {
      reporter_id: string | null
      target_id: string
      note: string | null
      snapshot: Record<string, unknown>
      trusted: boolean
      brigade: boolean
      priority: number
      legal_hold: boolean
      status: string
    }[]
  >`
    select reporter_id, target_id, note, snapshot, trusted, brigade, priority, legal_hold, status
    from private.reports where id = ${id}
  `
  return row
}

/** Makes the account old enough to count as a trusted reporter. */
async function ageAccount(guest: Guest, hours = config.autoHideMinReporterAgeHours + 1) {
  await sql`
    update public.profiles set created_at = now() - make_interval(hours => ${hours})
    where id = ${guest.id}
  `
}

async function trustedGuest(): Promise<Guest> {
  const guest = await newAttestedGuest()
  await ageAccount(guest)
  return guest
}

async function activeRoommates(a: Guest, b: Guest): Promise<string> {
  const [low, high] = a.id < b.id ? [a.id, b.id] : [b.id, a.id]
  const [row] = await sql<{ id: string }[]>`
    insert into public.roommates (user_low, user_high, home_id, status, invited_by, accepted_at)
    values (${low}, ${high}, 'queens-room', 'active', ${a.id}, now())
    returning id
  `
  return row?.id ?? ''
}

async function sanction(guest: Guest, kind: 'restriction' | 'suspension' | 'ban', days = 3) {
  await sql`
    insert into private.sanctions (user_id, kind, reason, ends_at, created_by)
    values (${guest.id}, ${kind}, 'harassment',
      ${kind === 'ban' ? null : new Date(Date.now() + days * 86_400_000)}, gen_random_uuid())
  `
}

async function handleOf(guest: Guest): Promise<string> {
  const [row] = await sql<
    { handle: string }[]
  >`select handle from public.profiles where id = ${guest.id}`
  return row?.handle ?? ''
}

async function publicIds(viewer: Guest, ids: string[]): Promise<string[]> {
  const { data, error } = await viewer.client.rpc('get_public_profiles', { p_ids: ids })
  if (error !== null) throw error
  return data.map((row) => row.id)
}

describe('settings and the text filter', () => {
  it('private.moderation_settings matches data/config/moderation.json', async () => {
    const [row] = await sql<Record<string, number | boolean>[]>`
      select * from private.moderation_settings
    `
    expect(row).toEqual({
      id: true,
      auto_hide_reports: config.autoHideReports,
      auto_hide_reporter_min_hours: config.autoHideMinReporterAgeHours,
      false_report_threshold: config.falseReportThreshold,
      reports_per_day: config.reportsPerDay,
      note_max_chars: config.noteMaxChars,
      appeal_max_chars: config.appealMaxChars,
      block_undo_seconds: config.blockUndoSeconds,
      block_max: config.blockMax,
      mute_max: config.muteMax,
      evidence_days: config.retention.evidenceDays,
      report_row_days: config.retention.reportRowDays,
      audit_days: config.retention.auditDays,
      appeal_days: config.retention.appealDays,
    })
    const [{ n } = { n: 0 }] = await sql<{ n: number }[]>`
      select count(*)::int as n from private.moderation_settings
    `
    expect(n).toBe(1)
  })

  it('normalize_text and contains_contact_info give the fixture answers, like their twins', async () => {
    const rows = await sql<{ text: string; normalized: string; contact: boolean }[]>`
      select t as text, private.normalize_text(t) as normalized,
        private.contains_contact_info(t) as contact
      from unnest(${TEXT_FILTER_FIXTURES.map((f) => f.text)}::text[]) with ordinality as x(t, i)
      order by i
    `
    expect(rows).toHaveLength(TEXT_FILTER_FIXTURES.length)
    for (const [i, fixture] of TEXT_FILTER_FIXTURES.entries()) {
      const row = rows[i]
      expect(row?.normalized, fixture.text).toBe(fixture.normalized)
      expect(row?.contact, fixture.text).toBe(fixture.contact)
      expect(normalizeText(fixture.text), fixture.text).toBe(row?.normalized)
      expect(containsContactInfo(fixture.text), fixture.text).toBe(row?.contact)
    }
  })

  it('contains_contact_info(null) is false', async () => {
    const [row] = await sql<{ v: boolean }[]>`select private.contains_contact_info(null) as v`
    expect(row?.v).toBe(false)
  })
})

describe('blocks', () => {
  it('ends the friendship and the roommate link in one go, and says so', async () => {
    const [a, b] = await Promise.all([newAttestedGuest(), newAttestedGuest()])
    await befriend(a, b)
    const roomId = await activeRoommates(a, b)

    const { data, error } = await a.client.rpc('block_player', { p_target: b.id })
    expect(error).toBeNull()
    expect(data).toEqual([
      {
        undo_id: expect.any(String),
        undo_expires_at: expect.any(String),
        friendship_ended: true,
        roommate_ended: true,
      },
    ])
    const [left] = await sql<{ friendships: number; status: string }[]>`
      select
        (select count(*)::int from public.friendships
          where ${a.id} in (requester_id, addressee_id) and ${b.id} in (requester_id, addressee_id)) as friendships,
        (select status from public.roommates where id = ${roomId}) as status
    `
    expect(left).toEqual({ friendships: 0, status: 'ended' })
  })

  it('only the blocker sees the block; nobody can write one directly', async () => {
    const [a, b] = await Promise.all([newAttestedGuest(), newAttestedGuest()])
    expect((await a.client.rpc('block_player', { p_target: b.id })).error).toBeNull()

    const mine = await a.client.from('blocks').select('blocker_id, blocked_id')
    expect(mine.data).toEqual([{ blocker_id: a.id, blocked_id: b.id }])
    const theirs = await b.client.from('blocks').select('blocker_id')
    expect(theirs.data).toEqual([])

    const insert = await b.client.from('blocks').insert({ blocker_id: b.id, blocked_id: a.id })
    expect(insert.error).not.toBeNull()
    const remove = await a.client.from('blocks').delete().eq('blocked_id', b.id).select()
    expect(remove.error).not.toBeNull()
    expect((await a.client.from('blocks').select('blocked_id')).data).toHaveLength(1)
  })

  it('hides both ways: profiles 404 and city lookups leave the other out (can_view)', async () => {
    const [a, b, c] = await Promise.all([
      newAttestedGuest(),
      newAttestedGuest(),
      newAttestedGuest(),
    ])
    const [handleA, handleB] = await Promise.all([handleOf(a), handleOf(b)])
    expect((await a.client.rpc('block_player', { p_target: b.id })).error).toBeNull()

    for (const [viewer, handle] of [
      [a, handleB],
      [b, handleA],
    ] as const) {
      const { error } = await viewer.client.rpc('get_public_profile', { p_handle: handle })
      expectRpcError(error, 'profile_not_found', 'PT404')
    }
    expect(await publicIds(a, [b.id, c.id])).toEqual([c.id])
    expect(await publicIds(b, [a.id, c.id])).toEqual([c.id])
    // A bystander still sees both.
    expect((await publicIds(c, [a.id, b.id])).sort()).toEqual([a.id, b.id].sort())
  })

  it('refuses a friend boost either way, even if a friendship row came back', async () => {
    const [a, b] = await Promise.all([newAttestedGuest(), newAttestedGuest()])
    await befriend(a, b)
    expect((await b.client.rpc('block_player', { p_target: a.id })).error).toBeNull()
    // Blocked looks exactly like unknown, so the boost cannot be used to learn who blocked you.
    expectRpcError(
      (await a.client.rpc('send_friend_boost', { p_to: b.id })).error,
      'invalid_target',
      'PT400',
    )
    // S20's request flow will refuse to befriend a blocked pair; the boost does not rely on it.
    await befriend(a, b)
    for (const [from, to] of [
      [a, b],
      [b, a],
    ] as const) {
      expectRpcError(
        (await from.client.rpc('send_friend_boost', { p_to: to.id })).error,
        'invalid_target',
        'PT400',
      )
    }
  })

  it('undo within the window restores the friendship and the roommate link exactly', async () => {
    const [a, b] = await Promise.all([newAttestedGuest(), newAttestedGuest()])
    await befriend(a, b)
    const roomId = await activeRoommates(a, b)
    const [before] = await sql<{ id: string; created_at: Date }[]>`
      select id, created_at from public.friendships where requester_id = ${a.id}
    `
    const blocked = await b.client.rpc('block_player', { p_target: a.id })
    const undo = blocked.data?.[0]?.undo_id ?? ''

    const { data, error } = await b.client.rpc('unblock_player', { p_target: a.id, p_undo: undo })
    expect(error).toBeNull()
    expect(data).toEqual([{ unblocked: true, friendship_restored: true, roommate_restored: true }])
    const [after] = await sql<{ id: string; created_at: Date; status: string }[]>`
      select id, created_at, status from public.friendships where requester_id = ${a.id}
    `
    expect(after).toEqual({ ...before, status: 'accepted' })
    const [room] = await sql<{ status: string; ended_at: Date | null }[]>`
      select status, ended_at from public.roommates where id = ${roomId}
    `
    expect(room).toEqual({ status: 'active', ended_at: null })

    // The token is single-use.
    await b.client.rpc('block_player', { p_target: a.id })
    const again = await b.client.rpc('unblock_player', { p_target: a.id, p_undo: undo })
    expect(again.data).toEqual([
      { unblocked: true, friendship_restored: false, roommate_restored: false },
    ])
  })

  it('after the undo window, unblocking keeps the friendship ended', async () => {
    const [a, b] = await Promise.all([newAttestedGuest(), newAttestedGuest()])
    await befriend(a, b)
    const blocked = await a.client.rpc('block_player', { p_target: b.id })
    const undo = blocked.data?.[0]?.undo_id ?? ''
    await sql`
      update private.block_undo
      set expires_at = now() - interval '1 second', created_at = created_at - interval '1 minute'
      where id = ${undo}
    `
    const { data } = await a.client.rpc('unblock_player', { p_target: b.id, p_undo: undo })
    expect(data).toEqual([
      { unblocked: true, friendship_restored: false, roommate_restored: false },
    ])
    expect(await sql`select 1 from public.friendships where requester_id = ${a.id}`).toHaveLength(0)
    // Unblocked: they see each other again.
    expect(await publicIds(a, [b.id])).toEqual([b.id])
  })

  it('undo restores nothing while the other player blocks back', async () => {
    const [a, b] = await Promise.all([newAttestedGuest(), newAttestedGuest()])
    await befriend(a, b)
    const blocked = await a.client.rpc('block_player', { p_target: b.id })
    await b.client.rpc('block_player', { p_target: a.id })
    const { data } = await a.client.rpc('unblock_player', {
      p_target: b.id,
      p_undo: blocked.data?.[0]?.undo_id ?? '',
    })
    expect(data).toEqual([
      { unblocked: true, friendship_restored: false, roommate_restored: false },
    ])
  })

  it('a repeat block changes nothing; self, unknown and unattested targets are refused', async () => {
    const [a, b] = await Promise.all([newAttestedGuest(), newAttestedGuest()])
    await a.client.rpc('block_player', { p_target: b.id })
    const repeat = await a.client.rpc('block_player', { p_target: b.id })
    expect(repeat.data).toEqual([
      { undo_id: null, undo_expires_at: null, friendship_ended: false, roommate_ended: false },
    ])
    for (const target of [a.id, crypto.randomUUID()]) {
      expectRpcError(
        (await a.client.rpc('block_player', { p_target: target })).error,
        'invalid_target',
        'PT400',
      )
    }
    const notBlocked = await b.client.rpc('unblock_player', { p_target: a.id })
    expect(notBlocked.data).toEqual([
      { unblocked: false, friendship_restored: false, roommate_restored: false },
    ])
  })

  it('list_my_blocks lists the caller’s blocks with handles, newest first', async () => {
    const [a, b, c] = await Promise.all([
      newAttestedGuest(),
      newAttestedGuest(),
      newAttestedGuest(),
    ])
    await a.client.rpc('block_player', { p_target: b.id })
    await a.client.rpc('block_player', { p_target: c.id })
    const { data, error } = await a.client.rpc('list_my_blocks')
    expect(error).toBeNull()
    expect(data?.map((row) => [row.player_id, row.handle])).toEqual([
      [c.id, await handleOf(c)],
      [b.id, await handleOf(b)],
    ])
    expect((await b.client.rpc('list_my_blocks')).data).toEqual([])
  })

  it(`stops at blockMax (${config.blockMax}): tested with the cap lowered to 1`, async () => {
    const [a, b, c] = await Promise.all([
      newAttestedGuest(),
      newAttestedGuest(),
      newAttestedGuest(),
    ])
    const errors = await asRequest(
      'authenticated',
      { sub: a.id, role: 'authenticated' },
      async (tx) => ({
        first: await errorOf(tx, (sp) => sp`select * from public.block_player(${b.id})`),
        second: await errorOf(tx, (sp) => sp`select * from public.block_player(${c.id})`),
        mute: await errorOf(tx, (sp) => sp`select public.mute_player(${b.id})`),
        muteAgain: await errorOf(tx, (sp) => sp`select public.mute_player(${c.id})`),
      }),
      (tx) => tx`update private.moderation_settings set block_max = 1, mute_max = 1`,
    )
    expect(errors.first).toBeNull()
    expect(errors.second?.message).toBe('block_limit')
    expect(errors.mute).toBeNull()
    expect(errors.muteAgain?.message).toBe('mute_limit')
  })
})

describe('mutes', () => {
  it('mute and unmute are owner-only, idempotent and listed for the owner', async () => {
    const [a, b] = await Promise.all([newAttestedGuest(), newAttestedGuest()])
    expect((await a.client.rpc('mute_player', { p_target: b.id })).error).toBeNull()
    expect((await a.client.rpc('mute_player', { p_target: b.id })).error).toBeNull()

    expect((await a.client.from('mutes').select('muted_id')).data).toEqual([{ muted_id: b.id }])
    expect((await b.client.from('mutes').select('muted_id')).data).toEqual([])
    const listed = await a.client.rpc('list_my_mutes')
    expect(listed.data?.map((row) => [row.player_id, row.handle])).toEqual([
      [b.id, await handleOf(b)],
    ])
    // A mute hides nothing server-side: b still sees a, and a still sees b.
    expect(await publicIds(b, [a.id])).toEqual([a.id])
    expect(await publicIds(a, [b.id])).toEqual([b.id])

    expect((await a.client.rpc('unmute_player', { p_target: b.id })).error).toBeNull()
    expect((await a.client.from('mutes').select('muted_id')).data).toEqual([])
    expectRpcError(
      (await a.client.rpc('mute_player', { p_target: a.id })).error,
      'invalid_target',
      'PT400',
    )
  })
})

describe('reports', () => {
  it('are filed with a server snapshot and never readable through the API', async () => {
    const [reporter, target] = await Promise.all([newAttestedGuest(), newAttestedGuest()])
    const { data, error } = await report(reporter, target.id, {
      reason: 'hate',
      note: '  called me a slur  ',
    })
    expect(error).toBeNull()
    expect(data).toEqual([{ report_id: expect.any(String), duplicate: false }])
    const row = await reportRow(data?.[0]?.report_id ?? '')
    expect(row).toMatchObject({
      reporter_id: reporter.id,
      target_id: target.id,
      note: 'called me a slur',
      status: 'open',
      legal_hold: false,
      priority: 10,
    })
    expect(row?.snapshot).toMatchObject({
      kind: 'player',
      target_id: target.id,
      handle: await handleOf(target),
      public_level: 'nobody',
      friends: false,
      reporter_blocked_target: false,
    })

    for (const client of [reporter.client, target.client] as unknown as SupabaseClient[]) {
      const exposed = await client.from('reports').select('*')
      expect(exposed.error).not.toBeNull()
      const viaSchema = await client.schema('private').from('reports').select('*')
      expect(viaSchema.error).not.toBeNull()
      expect(viaSchema.data).toBeNull()
    }
  })

  it('list_my_reports shows only the caller’s own, in safe columns', async () => {
    const [reporter, other, target] = await Promise.all([
      newAttestedGuest(),
      newAttestedGuest(),
      newAttestedGuest(),
    ])
    await report(reporter, target.id, { reason: 'spam', note: 'note text' })
    await report(other, target.id)
    const { data, error } = await reporter.client.rpc('list_my_reports')
    expect(error).toBeNull()
    expect(data).toEqual([
      {
        report_id: expect.any(String),
        kind: 'player',
        reason: 'spam',
        status: 'open',
        target_handle: await handleOf(target),
        created_at: expect.any(String),
      },
    ])
    // The reported player learns nothing: none of the reports about them are theirs to list.
    expect((await target.client.rpc('list_my_reports')).data).toEqual([])
  })

  it('note rules: at most noteMaxChars, no contact details, insults allowed, blank is none', async () => {
    const [reporter, target] = await Promise.all([newAttestedGuest(), newAttestedGuest()])
    expectRpcError(
      (await report(reporter, target.id, { note: 'x'.repeat(config.noteMaxChars + 1) })).error,
      'note_too_long',
      'PT400',
    )
    for (const note of ['dm me on ig: coolcat', 'call 555 123 4567', 'see evil.com']) {
      expectRpcError(
        (await report(reporter, target.id, { note })).error,
        'note_contact_info',
        'PT400',
      )
    }
    const atMax = await report(reporter, target.id, {
      reason: 'spam',
      note: `  ${'😀'.repeat(config.noteMaxChars)}  `,
    })
    expect(atMax.error).toBeNull()
    const blank = await report(reporter, target.id, { reason: 'scam', note: '   ' })
    expect((await reportRow(blank.data?.[0]?.report_id ?? ''))?.note).toBeNull()
  })

  it('refuses unknown reasons, handle reports with a player-only reason, bad kinds and keys', async () => {
    const [reporter, target] = await Promise.all([newAttestedGuest(), newAttestedGuest()])
    expectRpcError(
      (await report(reporter, target.id, { reason: 'vibes' })).error,
      'invalid_reason',
      'PT400',
    )
    expectRpcError(
      (await report(reporter, target.id, { kind: 'handle', reason: 'spam' })).error,
      'invalid_reason',
      'PT400',
    )
    expectRpcError(
      (await report(reporter, target.id, { kind: 'message' })).error,
      'invalid_argument',
      'PT400',
    )
    expectRpcError(
      (await report(reporter, target.id, { key: 'short' })).error,
      'invalid_argument',
      'PT400',
    )
  })

  it('refuses a self-report and an unknown target', async () => {
    const reporter = await newAttestedGuest()
    expectRpcError((await report(reporter, reporter.id)).error, 'self_report', 'PT400')
    expectRpcError((await report(reporter, crypto.randomUUID())).error, 'invalid_target', 'PT400')
  })

  it('is idempotent: the same key, or the same open report, returns the first one', async () => {
    const [reporter, target] = await Promise.all([newAttestedGuest(), newAttestedGuest()])
    const id = key()
    const first = await report(reporter, target.id, { key: id })
    const replay = await report(reporter, target.id, { key: id, reason: 'spam' })
    const repeat = await report(reporter, target.id)
    const reportId = first.data?.[0]?.report_id
    expect(replay.data).toEqual([{ report_id: reportId, duplicate: true }])
    expect(repeat.data).toEqual([{ report_id: reportId, duplicate: true }])
    const other = await report(reporter, target.id, { reason: 'threats' })
    expect(other.data?.[0]?.duplicate).toBe(false)
    const [{ n } = { n: 0 }] = await sql<{ n: number }[]>`
      select count(*)::int as n from private.reports where reporter_id = ${reporter.id}
    `
    expect(n).toBe(2)
  })

  it(`allows ${config.reportsPerDay} reports per New York day, then 429`, async () => {
    const [reporter, target, next] = await Promise.all([
      newAttestedGuest(),
      newAttestedGuest(),
      newAttestedGuest(),
    ])
    await sql`
      insert into private.reports (reporter_id, target_id, kind, reason, snapshot,
        idempotency_key, ny_day, trusted, priority, status, resolved_at)
      select ${reporter.id}, ${target.id}, 'player', 'spam', '{}', 'seed-' || g || '-' || md5(random()::text),
        private.ny_today(), false, 10, 'dismissed', now()
      from generate_series(1, ${config.reportsPerDay - 1}) g
    `
    // Yesterday's reports do not count.
    await sql`
      insert into private.reports (reporter_id, target_id, kind, reason, snapshot,
        idempotency_key, ny_day, trusted, priority)
      values (${reporter.id}, ${next.id}, 'player', 'scam', '{}', ${key()},
        private.ny_today() - 1, false, 10)
    `
    expect((await report(reporter, target.id)).error).toBeNull()
    const { error, status } = await report(reporter, next.id)
    expectRpcError(error, 'rate_limited', 'PT429')
    expect(status).toBe(429)
  })

  it('child safety reports are always under legal hold and go to the top of the queue', async () => {
    const [reporter, target] = await Promise.all([newAttestedGuest(), newAttestedGuest()])
    const { data } = await report(reporter, target.id, { reason: 'child_safety' })
    expect(await reportRow(data?.[0]?.report_id ?? '')).toMatchObject({
      legal_hold: true,
      priority: 100,
    })
    await expect(
      sql`update private.reports set legal_hold = false where id = ${data?.[0]?.report_id ?? ''}`,
    ).rejects.toMatchObject({ code: '23514' })
  })

  it('a suspended or banned player can still report (standing-exempt)', async () => {
    const [suspended, banned, target] = await Promise.all([
      newAttestedGuest(),
      newAttestedGuest(),
      newAttestedGuest(),
    ])
    await sanction(suspended, 'suspension')
    await sanction(banned, 'ban')
    expect((await report(suspended, target.id)).error).toBeNull()
    expect((await report(banned, target.id)).error).toBeNull()
  })
})

describe('auto-hide', () => {
  async function handleReports(reporters: Guest[], target: Guest) {
    for (const reporter of reporters) {
      const { error } = await report(reporter, target.id, {
        kind: 'handle',
        reason: 'offensive_name',
      })
      expect(error).toBeNull()
    }
  }

  async function heldHandle(target: Guest): Promise<boolean> {
    const [row] = await sql<{ held: boolean }[]>`select private.handle_held(${target.id}) as held`
    return row?.held ?? false
  }

  it(`hides a handle after ${config.autoHideReports} distinct trusted reporters, for others only`, async () => {
    const target = await newAttestedGuest()
    const reporters = await Promise.all(
      Array.from({ length: config.autoHideReports }, () => trustedGuest()),
    )
    const viewer = await newAttestedGuest()
    const handle = await handleOf(target)

    await handleReports(reporters.slice(0, -1), target)
    expect(await heldHandle(target)).toBe(false)
    await handleReports(reporters.slice(-1), target)
    expect(await heldHandle(target)).toBe(true)

    const { data } = await viewer.client.rpc('get_public_profiles', { p_ids: [target.id] })
    expect(data?.[0]?.handle).toBe(HELD_HANDLE_PLACEHOLDER)
    expectRpcError(
      (await viewer.client.rpc('get_public_profile', { p_handle: handle })).error,
      'profile_not_found',
      'PT404',
    )
    // Hidden from others, not from the player: they keep seeing (and can change) their handle.
    const mine = await target.client.rpc('get_my_profile')
    expect(mine.data?.[0]?.handle).toBe(handle)
    // The player is not hidden: only their content is.
    expect(await publicIds(viewer, [target.id])).toEqual([target.id])
  })

  it('new accounts do not hide anything; piling on flags a brigade instead', async () => {
    const target = await newAttestedGuest()
    const reporters = await Promise.all(
      Array.from({ length: config.autoHideReports }, () => newAttestedGuest()),
    )
    await handleReports(reporters, target)
    expect(await heldHandle(target)).toBe(false)
    const rows = await sql<{ trusted: boolean; brigade: boolean }[]>`
      select trusted, brigade from private.reports where target_id = ${target.id}
    `
    expect(rows).toHaveLength(config.autoHideReports)
    expect(rows.every((row) => !row.trusted && row.brigade)).toBe(true)
  })

  it(`reporters with ${config.falseReportThreshold} abusive reports stop counting`, async () => {
    const target = await newAttestedGuest()
    const reporters = await Promise.all(
      Array.from({ length: config.autoHideReports }, () => trustedGuest()),
    )
    const [abuser] = reporters
    await sql`
      insert into private.reporter_stats (user_id, false_reports)
      values (${abuser?.id ?? ''}, ${config.falseReportThreshold})
    `
    await handleReports(reporters, target)
    expect(await heldHandle(target)).toBe(false)
  })

  it('player reports never hide anything (content only)', async () => {
    const target = await newAttestedGuest()
    const reporters = await Promise.all(
      Array.from({ length: config.autoHideReports }, () => trustedGuest()),
    )
    for (const reporter of reporters) await report(reporter, target.id, { reason: 'hate' })
    expect(await heldHandle(target)).toBe(false)
    const [{ n } = { n: 0 }] = await sql<{ n: number }[]>`
      select count(*)::int as n from private.content_holds where target_id = ${target.id}
    `
    expect(n).toBe(0)
  })
})

describe('standing gate', () => {
  it('a suspended player cannot block, mute, boost or set a handle, and is hidden from others', async () => {
    const [player, friend, viewer] = await Promise.all([
      newAttestedGuest(),
      newAttestedGuest(),
      newAttestedGuest(),
    ])
    await befriend(player, friend)
    await sanction(player, 'suspension')
    for (const { error } of [
      await player.client.rpc('block_player', { p_target: friend.id }),
      await player.client.rpc('mute_player', { p_target: friend.id }),
      await player.client.rpc('send_friend_boost', { p_to: friend.id }),
      await player.client.rpc('set_handle', { p_handle: 'Whatever' }),
    ]) {
      expectRpcError(error, 'account_suspended', 'PT403')
    }
    expect(await publicIds(viewer, [player.id])).toEqual([])
    // The friend cannot boost a suspended player either: the same answer as an unknown one.
    expectRpcError(
      (await friend.client.rpc('send_friend_boost', { p_to: player.id })).error,
      'invalid_target',
      'PT400',
    )
    // Reading their own lists still works.
    expect((await player.client.rpc('list_my_blocks')).error).toBeNull()
  })

  it('a restricted player loses social features only', async () => {
    const [player, friend] = await Promise.all([newAttestedGuest(), newAttestedGuest()])
    await befriend(player, friend)
    await sanction(player, 'restriction')
    expectRpcError(
      (await player.client.rpc('send_friend_boost', { p_to: friend.id })).error,
      'account_restricted',
      'PT403',
    )
    expect((await player.client.rpc('mute_player', { p_target: friend.id })).error).toBeNull()
    expect((await player.client.rpc('block_player', { p_target: friend.id })).error).toBeNull()
  })

  it('a ban says account_banned; an expired or revoked sanction no longer counts', async () => {
    const [banned, lapsed, target] = await Promise.all([
      newAttestedGuest(),
      newAttestedGuest(),
      newAttestedGuest(),
    ])
    await sanction(banned, 'ban')
    expectRpcError(
      (await banned.client.rpc('mute_player', { p_target: target.id })).error,
      'account_banned',
      'PT403',
    )
    await sanction(lapsed, 'suspension')
    await sql`
      update private.sanctions
      set starts_at = now() - interval '4 days', ends_at = now() - interval '1 day'
      where user_id = ${lapsed.id}
    `
    expect((await lapsed.client.rpc('mute_player', { p_target: target.id })).error).toBeNull()
    expect(await publicIds(target, [lapsed.id])).toEqual([lapsed.id])
  })

  it('the service role is no player: client RPCs still say not_authenticated', async () => {
    const service = serviceClient() as unknown as SupabaseClient
    const { error } = await service.rpc('block_player', { p_target: crypto.randomUUID() })
    expectRpcError(error, 'not_authenticated', 'PT401')
  })
})
