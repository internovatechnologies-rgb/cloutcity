/**
 * S18b moderator actions and retention against the real database. The mod_* RPCs are called
 * with the service role, the way the /mod server routes will call them, and each must write
 * exactly one audit row, replay on its idempotency key and refuse a case another moderator has
 * just resolved. The retention purge is run on backdated rows and must spare legal holds.
 */
import moderationJson from '@data/config/moderation.json'
import { describe, expect, it } from 'vitest'
import { ModerationConfigSchema } from '@/lib/data/schemas/config'
import { HELD_HANDLE_PLACEHOLDER } from '@/lib/safety/reports'
import {
  expectRpcError,
  newAttestedGuest,
  newPermanentUser,
  serviceClient,
  sql,
  type Guest,
} from './helpers'

const config = ModerationConfigSchema.parse(moderationJson)
const service = serviceClient()
const key = () => `it-${crypto.randomUUID()}`

/** One moderator for the whole file (a permanent account, as /mod requires). */
const moderator = newPermanentUser()

type ModAction =
  | 'mod_dismiss'
  | 'mod_warn'
  | 'mod_reset_handle'
  | 'mod_restrict'
  | 'mod_suspend'
  | 'mod_ban'
  | 'mod_resolve_appeal'
  | 'mod_set_legal_hold'

interface ModResult {
  action: string
  case: string
  replayed: boolean
  report_ids?: string[]
  sanction_id?: string
  handle?: string
  identity_banned?: boolean
  holds_released?: number
}

/** Calls a moderator action; `extra` fills in the action's own arguments. */
async function mod(
  action: ModAction,
  caseId: string,
  extra: Record<string, unknown> = {},
  idempotencyKey: string = key(),
) {
  const defaults: Record<ModAction, Record<string, unknown>> = {
    mod_dismiss: { p_abusive: false },
    mod_warn: { p_reason: 'harassment' },
    mod_reset_handle: { p_reason: 'offensive_name' },
    mod_restrict: { p_reason: 'spam', p_days: 3 },
    mod_suspend: { p_reason: 'threats', p_days: 7 },
    mod_ban: { p_reason: 'hate' },
    mod_resolve_appeal: { p_overturn: false },
    mod_set_legal_hold: { p_hold: true },
  }
  const { data, error } = await (
    service.rpc as unknown as (
      fn: string,
      args: Record<string, unknown>,
    ) => Promise<{ data: unknown; error: { code?: string; message: string } | null }>
  )(action, {
    p_moderator_id: (await moderator).id,
    p_case: caseId,
    p_idempotency_key: idempotencyKey,
    p_correlation_id: 'it-corr',
    ...defaults[action],
    ...extra,
  })
  return { data: data as ModResult | null, error }
}

async function fileReport(reporter: Guest, target: Guest, kind = 'player', reason = 'harassment') {
  const { data, error } = await reporter.client.rpc('submit_report', {
    p_target: target.id,
    p_kind: kind,
    p_reason: reason,
    p_note: '',
    p_idempotency_key: key(),
  })
  if (error !== null) throw error
  return data[0]?.report_id ?? ''
}

/** A reported player with one open report against them. */
async function openCase(): Promise<{ target: Guest; reporter: Guest; reportId: string }> {
  const [target, reporter] = await Promise.all([newAttestedGuest(), newAttestedGuest()])
  const reportId = await fileReport(reporter, target)
  return { target, reporter, reportId }
}

async function auditRows(caseId: string) {
  return sql<
    {
      action: string
      moderator_id: string
      target_id: string | null
      correlation_id: string
      before: Record<string, unknown>
      after: Record<string, unknown>
      report_ids: string[]
    }[]
  >`
    select action, moderator_id, target_id, correlation_id, before, after, report_ids
    from private.moderation_audit where case_id = ${caseId} order by id
  `
}

async function notices(guest: Guest) {
  const { data, error } = await guest.client
    .from('account_notices')
    .select('id, kind, reason, sanction_id, ends_at, acknowledged_at')
    .order('created_at')
  if (error !== null) throw error
  return data
}

describe('every moderator action', () => {
  it.each([
    ['mod_dismiss', 'dismissed'],
    ['mod_warn', 'actioned'],
    ['mod_reset_handle', 'actioned'],
    ['mod_restrict', 'actioned'],
    ['mod_suspend', 'actioned'],
    ['mod_ban', 'actioned'],
  ] as const)('%s closes the case and writes exactly one audit row', async (action, status) => {
    const { target, reportId } = await openCase()
    const { data, error } = await mod(action, target.id)
    expect(error).toBeNull()
    expect(data).toMatchObject({ case: target.id, report_ids: [reportId], replayed: false })
    const rows = await auditRows(target.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      moderator_id: (await moderator).id,
      target_id: target.id,
      correlation_id: 'it-corr',
      report_ids: [reportId],
      before: { open_reports: 1 },
      after: { open_reports: 0 },
    })
    const [report] = await sql<{ status: string; resolved_by: string }[]>`
      select status, resolved_by from private.reports where id = ${reportId}
    `
    expect(report).toEqual({ status, resolved_by: (await moderator).id })
  })

  it('a replay with the same key returns the first result and changes nothing', async () => {
    const { target } = await openCase()
    const idempotencyKey = key()
    const first = await mod('mod_warn', target.id, {}, idempotencyKey)
    const replay = await mod('mod_warn', target.id, {}, idempotencyKey)
    expect(replay.error).toBeNull()
    expect(replay.data).toEqual({ ...first.data, replayed: true })
    expect(await auditRows(target.id)).toHaveLength(1)
    expect(await notices(target)).toHaveLength(1)

    const other = await openCase()
    expectRpcError(
      (await mod('mod_warn', other.target.id, {}, idempotencyKey)).error,
      'idempotency_conflict',
      'PT409',
    )
    expectRpcError(
      (await mod('mod_ban', target.id, {}, idempotencyKey)).error,
      'idempotency_conflict',
      'PT409',
    )
  })

  it('two moderators resolving one case at once: one wins, the other gets 409 already_resolved', async () => {
    const { target } = await openCase()
    const results = await Promise.all([
      mod('mod_warn', target.id),
      mod('mod_dismiss', target.id),
      mod('mod_suspend', target.id),
    ])
    expect(results.filter((result) => result.error === null)).toHaveLength(1)
    for (const result of results.filter((r) => r.error !== null)) {
      expectRpcError(result.error, 'already_resolved', 'PT409')
    }
    expect(await auditRows(target.id)).toHaveLength(1)
  })

  it('a resolved case is already_resolved; a never-reported player is case_not_found', async () => {
    const { target } = await openCase()
    expect((await mod('mod_dismiss', target.id)).error).toBeNull()
    expectRpcError((await mod('mod_warn', target.id)).error, 'already_resolved', 'PT409')
    const stranger = await newAttestedGuest()
    expectRpcError((await mod('mod_warn', stranger.id)).error, 'case_not_found', 'PT404')
    expect(await auditRows(stranger.id)).toEqual([])
  })

  it('refuses a guest as moderator, bad arguments and an unknown reason', async () => {
    const { target, reporter } = await openCase()
    const asGuest = await (
      service.rpc as unknown as (
        fn: string,
        args: Record<string, unknown>,
      ) => Promise<{ error: { code?: string; message: string } | null }>
    )('mod_warn', {
      p_moderator_id: reporter.id,
      p_case: target.id,
      p_idempotency_key: key(),
      p_correlation_id: 'it',
      p_reason: 'spam',
    })
    expectRpcError(asGuest.error, 'not_moderator', 'PT403')
    expectRpcError(
      (await mod('mod_warn', target.id, {}, 'bad key!')).error,
      'invalid_argument',
      'PT400',
    )
    expectRpcError(
      (await mod('mod_warn', target.id, { p_reason: 'vibes' })).error,
      'invalid_reason',
      'PT400',
    )
    expectRpcError(
      (await mod('mod_suspend', target.id, { p_days: 0 })).error,
      'invalid_argument',
      'PT400',
    )
    expectRpcError(
      (await mod('mod_warn', target.id, { p_note: 'x'.repeat(501) })).error,
      'invalid_argument',
      'PT400',
    )
    expect(await auditRows(target.id)).toEqual([])
  })
})

describe('outcomes', () => {
  it('dismiss releases a handle hidden by auto-hide; abusive dismissal costs reporters trust', async () => {
    const target = await newAttestedGuest()
    const reporters = await Promise.all(
      Array.from({ length: config.autoHideReports }, () => newAttestedGuest()),
    )
    await sql`
      update public.profiles set created_at = now() - interval '2 days'
      where id = any(${reporters.map((r) => r.id)}::uuid[])
    `
    for (const reporter of reporters) await fileReport(reporter, target, 'handle', 'offensive_name')
    const viewer = await newAttestedGuest()
    const seen = async () =>
      (await viewer.client.rpc('get_public_profiles', { p_ids: [target.id] })).data?.[0]?.handle
    expect(await seen()).toBe(HELD_HANDLE_PLACEHOLDER)

    const { data } = await mod('mod_dismiss', target.id, { p_abusive: true })
    expect(data?.holds_released).toBe(1)
    const [profile] = await sql<{ handle: string }[]>`
      select handle from public.profiles where id = ${target.id}
    `
    expect(await seen()).toBe(profile?.handle)
    const stats = await sql<{ false_reports: number }[]>`
      select false_reports from private.reporter_stats
      where user_id = any(${reporters.map((r) => r.id)}::uuid[])
    `
    expect(stats.map((row) => row.false_reports)).toEqual(reporters.map(() => 1))
  })

  it('warn: the player gets a notice they can read and acknowledge, naming no reporter', async () => {
    const { target, reporter } = await openCase()
    const { data } = await mod('mod_warn', target.id, { p_note: 'internal only' })
    const [notice] = await notices(target)
    expect(notice).toEqual({
      id: expect.any(String),
      kind: 'warning',
      reason: 'harassment',
      sanction_id: data?.sanction_id,
      ends_at: null,
      acknowledged_at: null,
    })
    expect(JSON.stringify(notice)).not.toContain(reporter.id)
    expect(await notices(reporter)).toEqual([])

    expect(
      (await target.client.rpc('acknowledge_notice', { p_notice_id: notice?.id ?? '' })).error,
    ).toBeNull()
    expect((await notices(target))[0]?.acknowledged_at).not.toBeNull()
    expectRpcError(
      (await reporter.client.rpc('acknowledge_notice', { p_notice_id: notice?.id ?? '' })).error,
      'notice_not_found',
      'PT404',
    )
    // The reporter sees their report reviewed, never the outcome.
    const mine = await reporter.client.rpc('list_my_reports')
    expect(mine.data?.[0]?.status).toBe('reviewed')
  })

  it('reset handle: a fresh generated handle, the old one retired, and kept in the audit', async () => {
    const { target } = await openCase()
    const [before] = await sql<{ handle: string }[]>`
      select handle from public.profiles where id = ${target.id}
    `
    const { data, error } = await mod('mod_reset_handle', target.id)
    expect(error).toBeNull()
    const [after] = await sql<{ handle: string }[]>`
      select handle from public.profiles where id = ${target.id}
    `
    expect(after?.handle).toBe(data?.handle)
    expect(after?.handle).not.toBe(before?.handle)
    const [audit] = await auditRows(target.id)
    expect(audit?.before).toMatchObject({ handle: before?.handle })
    expect(audit?.after).toMatchObject({ handle: after?.handle })
    const [retired] = await sql<{ retired_at: Date | null }[]>`
      select retired_at from public.handles where handle = ${before?.handle ?? ''}
    `
    expect(retired?.retired_at).not.toBeNull()
    expect((await notices(target)).map((n) => n.kind)).toEqual(['handle_reset'])
  })

  it('restrict: social features refused until it ends; the notice says when', async () => {
    const { target } = await openCase()
    const friend = await newAttestedGuest()
    await sql`
      insert into public.friendships (requester_id, addressee_id, status)
      values (${target.id}, ${friend.id}, 'accepted')
    `
    const { data } = await mod('mod_restrict', target.id, { p_days: 2 })
    expectRpcError(
      (await target.client.rpc('send_friend_boost', { p_to: friend.id })).error,
      'account_restricted',
      'PT403',
    )
    const [notice] = await notices(target)
    expect(notice?.kind).toBe('restriction')
    expect(notice?.sanction_id).toBe(data?.sanction_id)
    const days = (Date.parse(notice?.ends_at ?? '') - Date.now()) / 86_400_000
    expect(days).toBeCloseTo(2, 1)
  })

  it('suspend, appeal, overturn: the player is back in good standing and told so', async () => {
    const { target } = await openCase()
    const viewer = await newAttestedGuest()
    await mod('mod_suspend', target.id)
    const visible = async () =>
      (await viewer.client.rpc('get_public_profiles', { p_ids: [target.id] })).data?.length
    expect(await visible()).toBe(0)
    expectRpcError(
      (await target.client.rpc('mute_player', { p_target: viewer.id })).error,
      'account_suspended',
      'PT403',
    )

    const [notice] = await notices(target)
    const appealed = await target.client.rpc('submit_appeal', {
      p_notice_id: notice?.id ?? '',
      p_body: '  It was a misunderstanding.  ',
    })
    expect(appealed.error).toBeNull()
    const appealId = appealed.data?.[0]?.appeal_id ?? ''
    expectRpcError(
      (
        await target.client.rpc('submit_appeal', {
          p_notice_id: notice?.id ?? '',
          p_body: 'Again',
        })
      ).error,
      'appeal_exists',
      'PT409',
    )

    const resolved = await mod('mod_resolve_appeal', appealId, { p_overturn: true })
    expect(resolved.error).toBeNull()
    expect(await visible()).toBe(1)
    expect((await target.client.rpc('mute_player', { p_target: viewer.id })).error).toBeNull()
    expect((await notices(target)).map((n) => n.kind)).toEqual(['suspension', 'appeal_overturned'])
    expect(await auditRows(appealId)).toEqual([
      expect.objectContaining({ action: 'resolve_appeal', target_id: target.id }),
    ])
    expectRpcError(
      (await mod('mod_resolve_appeal', appealId, { p_overturn: false })).error,
      'already_resolved',
      'PT409',
    )
  })

  it('appeal rules: own notice only, not for a handle reset, length-limited', async () => {
    const { target, reporter } = await openCase()
    await mod('mod_reset_handle', target.id)
    const [resetNotice] = await notices(target)
    expectRpcError(
      (
        await target.client.rpc('submit_appeal', {
          p_notice_id: resetNotice?.id ?? '',
          p_body: 'Please',
        })
      ).error,
      'not_appealable',
      'PT400',
    )
    await fileReport(reporter, target, 'player', 'spam')
    await mod('mod_warn', target.id)
    const warning = (await notices(target)).find((n) => n.kind === 'warning')
    expectRpcError(
      (
        await reporter.client.rpc('submit_appeal', {
          p_notice_id: warning?.id ?? '',
          p_body: 'Not mine',
        })
      ).error,
      'notice_not_found',
      'PT404',
    )
    expectRpcError(
      (
        await target.client.rpc('submit_appeal', {
          p_notice_id: warning?.id ?? '',
          p_body: 'x'.repeat(config.appealMaxChars + 1),
        })
      ).error,
      'appeal_too_long',
      'PT400',
    )
    expectRpcError(
      (await target.client.rpc('submit_appeal', { p_notice_id: warning?.id ?? '', p_body: ' ' }))
        .error,
      'invalid_argument',
      'PT400',
    )
  })

  it('ban: hidden, refused, and the email kept only as a peppered hash; an upheld appeal keeps it', async () => {
    const target = await newPermanentUser()
    const reporter = await newAttestedGuest()
    await fileReport(reporter, target)
    const { data } = await mod('mod_ban', target.id)
    expect(data?.identity_banned).toBe(true)
    expectRpcError(
      (await target.client.rpc('mute_player', { p_target: reporter.id })).error,
      'account_banned',
      'PT403',
    )
    const [user] = await sql<
      { email: string }[]
    >`select email from auth.users where id = ${target.id}`
    const [hash] = await sql<{ banned: boolean; plain: number }[]>`
      select private.is_banned_identity(${user?.email ?? ''}) as banned,
        (select count(*)::int from private.banned_identities
          where identity_hash = ${user?.email ?? ''} or identity_hash = md5(${user?.email ?? ''})) as plain
    `
    expect(hash).toEqual({ banned: true, plain: 0 })

    const [notice] = await notices(target)
    const appeal = await target.client.rpc('submit_appeal', {
      p_notice_id: notice?.id ?? '',
      p_body: 'Please reconsider',
    })
    await mod('mod_resolve_appeal', appeal.data?.[0]?.appeal_id ?? '', { p_overturn: false })
    expect((await notices(target)).map((n) => n.kind)).toEqual(['ban', 'appeal_upheld'])
    const [still] = await sql<{ banned: boolean }[]>`
      select private.is_banned_identity(${user?.email ?? ''}) as banned
    `
    expect(still?.banned).toBe(true)
  })

  it('an anonymous guest is banned without an identity hash (RISK-4)', async () => {
    const { target } = await openCase()
    const { data } = await mod('mod_ban', target.id)
    expect(data?.identity_banned).toBe(false)
  })

  it('legal hold covers every report about the player; child safety stays held when lifted', async () => {
    const { target, reporter } = await openCase()
    await fileReport(reporter, target, 'player', 'child_safety')
    const held = async () =>
      (
        await sql<{ reason: string; legal_hold: boolean }[]>`
          select reason, legal_hold from private.reports where target_id = ${target.id} order by reason
        `
      ).map((row) => [row.reason, row.legal_hold])
    await mod('mod_set_legal_hold', target.id, { p_hold: true })
    expect(await held()).toEqual([
      ['child_safety', true],
      ['harassment', true],
    ])
    await mod('mod_set_legal_hold', target.id, { p_hold: false })
    expect(await held()).toEqual([
      ['child_safety', true],
      ['harassment', false],
    ])
    expect((await auditRows(target.id)).map((row) => row.action)).toEqual([
      'set_legal_hold',
      'set_legal_hold',
    ])
  })
})

describe('retention purge', () => {
  /** A resolved report about `target`, resolved `days` ago. */
  async function oldReport(target: string, days: number, legalHold = false) {
    const [row] = await sql<{ id: string }[]>`
      insert into private.reports (reporter_id, target_id, kind, reason, note, snapshot,
        idempotency_key, ny_day, trusted, priority, legal_hold, status, resolved_at, created_at)
      values (null, ${target}, 'player', 'spam', 'evidence note', '{"handle":"Someone"}',
        ${key()}, private.ny_today() - ${days}::int, false, 10, ${legalHold}, 'actioned',
        now() - make_interval(days => ${days}), now() - make_interval(days => ${days}))
      returning id
    `
    return row?.id ?? ''
  }

  async function oldAudit(target: string, days: number) {
    const [row] = await sql<{ id: number }[]>`
      insert into private.moderation_audit (action, moderator_id, case_id, target_id,
        idempotency_key, correlation_id, result, created_at)
      values ('warn', gen_random_uuid(), ${target}, ${target}, ${key()}, 'it-purge', '{}',
        now() - make_interval(days => ${days}))
      returning id
    `
    return row?.id ?? 0
  }

  it('purges evidence, then rows and audit by age, and never anything under legal hold', async () => {
    const { evidenceDays, reportRowDays, auditDays } = config.retention
    const free = crypto.randomUUID()
    const held = crypto.randomUUID()
    const fresh = await oldReport(free, evidenceDays - 1)
    const stale = await oldReport(free, evidenceDays + 1)
    const ancient = await oldReport(free, reportRowDays + 1)
    const heldStale = await oldReport(held, reportRowDays + 1, true)
    const heldSibling = await oldReport(held, reportRowDays + 1)
    const freeAudit = await oldAudit(free, auditDays + 1)
    const heldAudit = await oldAudit(held, auditDays + 1)
    const recentAudit = await oldAudit(free, auditDays - 1)

    const [{ result } = { result: {} }] = await sql<{ result: Record<string, number> }[]>`
      select private.purge_expired_safety_data() as result
    `
    expect(result.evidence_purged).toBeGreaterThanOrEqual(1)

    const reports = await sql<{ id: string; note: string | null; snapshot: object }[]>`
      select id, note, snapshot from private.reports
      where id = any(${[fresh, stale, ancient, heldStale, heldSibling]}::uuid[])
    `
    const byId = new Map(reports.map((row) => [row.id, row]))
    expect(byId.get(fresh)).toMatchObject({ note: 'evidence note' })
    expect(byId.get(stale)).toMatchObject({ note: null, snapshot: {} })
    expect(byId.has(ancient)).toBe(false)
    expect(byId.get(heldStale)).toMatchObject({ note: 'evidence note' })
    expect(byId.get(heldSibling)).toMatchObject({ note: 'evidence note' })

    const audit = await sql<{ id: number }[]>`
      select id from private.moderation_audit
      where id = any(${[freeAudit, heldAudit, recentAudit]}::bigint[])
    `
    expect(audit.map((row) => Number(row.id)).sort()).toEqual(
      [heldAudit, recentAudit].map(Number).sort(),
    )
  })

  it('the purge flag is the only way to delete audit rows, and it does not outlive the purge', async () => {
    const id = await oldAudit(crypto.randomUUID(), 1)
    await sql.begin(async (tx) => {
      await tx`select private.purge_expired_safety_data()`
      await expect(
        tx.savepoint((sp) => sp`delete from private.moderation_audit where id = ${id}`),
      ).rejects.toThrow('moderation_audit_append_only')
    })
  })

  it('pg_cron runs the purge daily', async () => {
    const rows = await sql<{ schedule: string; command: string; active: boolean }[]>`
      select schedule, command, active from cron.job where jobname = 'purge-expired-safety-data'
    `
    expect(rows).toEqual([
      {
        schedule: '17 8 * * *',
        command: 'select private.purge_expired_safety_data()',
        active: true,
      },
    ])
  })
})
