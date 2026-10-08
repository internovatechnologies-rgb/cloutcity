/**
 * S18b part 2: what the /mod console reads (mod_queue, mod_case), against the real database.
 * Service role only, like the actions; a guest or a fake moderator id is refused; the queue
 * orders by priority and carries the trusted and brigade flags; a case shows its reports with
 * the note and snapshot, and the audit history once a moderator acts.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { afterAll, describe, expect, it } from 'vitest'
import {
  expectRpcError,
  newAttestedGuest,
  newPermanentUser,
  serviceClient,
  sql,
  type Guest,
} from './helpers'

const service = serviceClient() as unknown as SupabaseClient
const moderator = newPermanentUser()
const key = () => `it-${crypto.randomUUID()}`

// The local stack is shared and never reset, so open cases from every earlier run pile up and the
// queue (at most 200) cannot be assumed to reach a new case. Cases this file opens are moved to
// the front of their priority (oldest first) and closed again afterwards; only its own rows.
const seeded: string[] = []
async function frontOfQueue(...targets: Guest[]) {
  const ids = targets.map((target) => target.id)
  seeded.push(...ids)
  await sql`
    update private.reports set created_at = timestamptz '2001-01-01T00:00:00Z'
    where target_id in ${sql(ids)}
  `
}
afterAll(async () => {
  if (seeded.length === 0) return
  await sql`
    update private.reports set status = 'dismissed', resolved_at = now()
    where target_id in ${sql(seeded)} and status = 'open'
  `
})

async function report(reporter: Guest, target: Guest, reason: string, note: string | null = null) {
  const { error } = await reporter.client.rpc('submit_report', {
    p_target: target.id,
    p_kind: 'player',
    p_reason: reason,
    p_note: note ?? '',
    p_idempotency_key: key(),
  })
  if (error !== null) throw error
}

interface QueueCase {
  case_id: string
  priority: number
  reports: number
  reporters: number
  trusted_reporters: number
  brigade: boolean
  reasons: string[]
  standing: string
}

async function queue(limit = 200) {
  const { data, error } = await service.rpc('mod_queue', {
    p_moderator_id: (await moderator).id,
    p_limit: limit,
  })
  if (error !== null) throw error
  return data as { cases: QueueCase[]; appeals: unknown[] }
}

describe('mod_queue and mod_case (S18b part 2)', () => {
  it('lists open cases, highest priority first, with reporter counts', async () => {
    const [low, high, a, b] = await Promise.all([
      newAttestedGuest(),
      newAttestedGuest(),
      newAttestedGuest(),
      newAttestedGuest(),
    ])
    await report(a, low, 'spam')
    await report(b, low, 'scam')
    await report(a, high, 'self_harm')
    await frontOfQueue(low, high)
    const { cases } = await queue()
    const lowCase = cases.find((item) => item.case_id === low.id)
    const highCase = cases.find((item) => item.case_id === high.id)
    expect(highCase, 'the seeded high-priority case is in the queue').toBeDefined()
    expect(lowCase, 'the seeded low-priority case is in the queue').toBeDefined()
    expect(lowCase).toMatchObject({
      reports: 2,
      reporters: 2,
      reasons: ['scam', 'spam'],
      standing: 'good',
    })
    // New guests are not trusted reporters yet (autoHideMinReporterAgeHours).
    expect(lowCase?.trusted_reporters).toBe(0)
    expect(highCase?.priority).toBeGreaterThan(lowCase?.priority ?? Infinity)
    const order = cases.map((item) => item.case_id)
    expect(order.indexOf(high.id)).toBeLessThan(order.indexOf(low.id))
    for (let i = 1; i < cases.length; i += 1) {
      expect(cases[i - 1]?.priority ?? 0).toBeGreaterThanOrEqual(cases[i]?.priority ?? 0)
    }
  })

  it('shows a case with notes and snapshots, then the audit row after an action', async () => {
    const [target, reporter] = await Promise.all([newAttestedGuest(), newAttestedGuest()])
    await report(reporter, target, 'harassment', 'kept following me')
    await frontOfQueue(target)
    expect((await queue()).cases.some((item) => item.case_id === target.id)).toBe(true)
    const args = { p_moderator_id: (await moderator).id, p_case: target.id }
    const before = await service.rpc('mod_case', args)
    expect(before.error).toBeNull()
    const detail = before.data as {
      reports: { note: string | null; snapshot: { target_id: string }; reporter_id: string }[]
      audit: unknown[]
      standing: string
    }
    expect(detail.reports).toHaveLength(1)
    expect(detail.reports[0]).toMatchObject({
      note: 'kept following me',
      reporter_id: reporter.id,
      snapshot: { target_id: target.id },
    })
    expect(detail.audit).toEqual([])

    const acted = await service.rpc('mod_suspend', {
      ...args,
      p_idempotency_key: key(),
      p_correlation_id: 'it-console',
      p_reason: 'harassment',
      p_days: 3,
    })
    expect(acted.error).toBeNull()
    const after = (await service.rpc('mod_case', args)).data as typeof detail
    expect(after.standing).toBe('suspension')
    expect(after.audit).toEqual([
      expect.objectContaining({ action: 'suspend', reason: 'harassment' }),
    ])
    const { cases } = await queue()
    expect(cases.some((item) => item.case_id === target.id)).toBe(false)
  })

  it('refuses a guest or unknown moderator id, a bad limit and a case nobody reported', async () => {
    const guest = await newAttestedGuest()
    expectRpcError(
      (await service.rpc('mod_queue', { p_moderator_id: guest.id, p_limit: 10 })).error,
      'not_moderator',
      'PT403',
    )
    expectRpcError(
      (await service.rpc('mod_queue', { p_moderator_id: crypto.randomUUID(), p_limit: 10 })).error,
      'not_moderator',
      'PT403',
    )
    expectRpcError(
      (await service.rpc('mod_queue', { p_moderator_id: (await moderator).id, p_limit: 0 })).error,
      'invalid_argument',
      'PT400',
    )
    expectRpcError(
      (await service.rpc('mod_case', { p_moderator_id: (await moderator).id, p_case: guest.id }))
        .error,
      'case_not_found',
      'PT404',
    )
  })

  it('a signed-in player cannot call either', async () => {
    const guest = await newAttestedGuest()
    const client = guest.client as unknown as SupabaseClient
    for (const [fn, args] of [
      ['mod_queue', { p_moderator_id: guest.id, p_limit: 10 }],
      ['mod_case', { p_moderator_id: guest.id, p_case: guest.id }],
    ] as const) {
      const { error } = await client.rpc(fn, args)
      expect(error?.message, fn).toMatch(/permission denied/)
    }
  })
})
