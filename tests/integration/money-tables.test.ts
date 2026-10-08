import { beforeAll, describe, expect, it } from 'vitest'
import { anonClient, newAttestedGuest, serviceClient, type Client, type Guest } from './helpers'

const MONEY_TABLES = ['purchases', 'grants', 'entitlements'] as const

function purchaseFor(userId: string) {
  const ref = crypto.randomUUID()
  return {
    user_id: userId,
    item_id: 'premium-test-jacket',
    price_tier: 'tier1',
    amount_cents: 299,
    stripe_checkout_session_id: `cs_test_${ref}`,
    stripe_payment_intent_id: `pi_test_${ref}`,
    status: 'paid',
    paid_at: new Date().toISOString(),
  }
}

function grantFor(userId: string) {
  return {
    user_id: userId,
    kind: 'goal_reward',
    idempotency_key: `goal:${userId}:${crypto.randomUUID()}`,
    cash_amount: 50,
    clout_amount: 0,
    cap_amount: 100,
    clout_cap: 0,
    eligibility: { goal: 'first-rent' },
    reason: 'First rent paid',
    issued_by: 'system',
  }
}

async function seedMoneyRows(service: Client, owner: Guest) {
  const purchase = await service.from('purchases').insert(purchaseFor(owner.id)).select().single()
  if (purchase.error !== null) throw purchase.error
  const grant = await service.from('grants').insert(grantFor(owner.id)).select().single()
  if (grant.error !== null) throw grant.error
  const entitlements = await service
    .from('entitlements')
    .insert([
      {
        user_id: owner.id,
        item_id: 'premium-test-jacket',
        source: 'purchase',
        purchase_id: purchase.data.id,
      },
      { user_id: owner.id, item_id: 'premium-test-hat', source: 'grant', grant_id: grant.data.id },
    ])
    .select()
  if (entitlements.error !== null) throw entitlements.error
  return { purchase: purchase.data, grant: grant.data }
}

describe('purchases, grants and entitlements: owner-read, service-write', () => {
  const service = serviceClient()
  let owner: Guest
  let other: Guest
  let seeded: Awaited<ReturnType<typeof seedMoneyRows>>

  beforeAll(async () => {
    ;[owner, other] = await Promise.all([newAttestedGuest(), newAttestedGuest()])
    seeded = await seedMoneyRows(service, owner)
    await seedMoneyRows(service, other)
  })

  it.each(MONEY_TABLES)('%s: the owner reads only their own rows', async (table) => {
    const { data, error } = await owner.client.from(table).select('user_id')
    expect(error).toBeNull()
    expect(data?.length).toBeGreaterThan(0)
    expect(new Set(data?.map((row) => row.user_id))).toEqual(new Set([owner.id]))
  })

  it.each(MONEY_TABLES)("%s: another player cannot read the owner's rows", async (table) => {
    const { data, error } = await other.client.from(table).select('user_id').eq('user_id', owner.id)
    expect(error).toBeNull()
    expect(data).toEqual([])
  })

  it.each(MONEY_TABLES)('%s: a visitor with no session reads nothing', async (table) => {
    const { data, error } = await anonClient().from(table).select('user_id')
    expect(data ?? []).toEqual([])
    expect(error?.code).toBe('42501')
  })

  it('players cannot insert, update or delete money rows, even their own', async () => {
    for (const player of [owner, other]) {
      const attempts = [
        player.client.from('purchases').insert(purchaseFor(player.id)),
        player.client.from('grants').insert(grantFor(player.id)),
        player.client
          .from('entitlements')
          .insert({ user_id: player.id, item_id: 'x', source: 'grant', grant_id: seeded.grant.id }),
        player.client.from('purchases').update({ status: 'refunded' }).eq('user_id', owner.id),
        player.client.from('grants').update({ cash_amount: 100 }).eq('user_id', owner.id),
        player.client
          .from('entitlements')
          .update({ revoked_at: null, revoke_reason: null })
          .eq('user_id', owner.id),
        player.client.from('purchases').delete().eq('user_id', owner.id),
        player.client.from('grants').delete().eq('user_id', owner.id),
        player.client.from('entitlements').delete().eq('user_id', owner.id),
      ]
      for (const { error } of await Promise.all(attempts)) {
        expect(error?.code).toBe('42501')
      }
    }
    const { data } = await service.from('entitlements').select('id').eq('user_id', owner.id)
    expect(data).toHaveLength(2)
    const purchase = await service.from('purchases').select('status').eq('id', seeded.purchase.id)
    expect(purchase.data).toEqual([{ status: 'paid' }])
  })

  it('the service role writes them', async () => {
    const { error } = await service
      .from('purchases')
      .update({ status: 'refunded', refunded_at: new Date().toISOString() })
      .eq('id', seeded.purchase.id)
    expect(error).toBeNull()
    const revoke = await service
      .from('entitlements')
      .update({ revoked_at: new Date().toISOString(), revoke_reason: 'refund' })
      .eq('purchase_id', seeded.purchase.id)
    expect(revoke.error).toBeNull()
  })

  it('a grant idempotency key is used once', async () => {
    const grant = grantFor(owner.id)
    expect((await service.from('grants').insert(grant)).error).toBeNull()
    const again = await service.from('grants').insert(grant)
    expect(again.error?.code).toBe('23505')
  })

  it('a grant is append-only: only applied_at can be set, once', async () => {
    const { data, error } = await service
      .from('grants')
      .insert(grantFor(owner.id))
      .select()
      .single()
    if (error !== null) throw error
    const change = await service.from('grants').update({ cash_amount: 99 }).eq('id', data.id)
    expect(change.error?.message).toBe('grants_append_only')
    const applied = await service
      .from('grants')
      .update({ applied_at: new Date().toISOString() })
      .eq('id', data.id)
    expect(applied.error).toBeNull()
    const reapplied = await service
      .from('grants')
      .update({ applied_at: new Date(Date.now() + 1000).toISOString() })
      .eq('id', data.id)
    expect(reapplied.error?.message).toBe('grants_append_only')
    const cleared = await service.from('grants').update({ applied_at: null }).eq('id', data.id)
    expect(cleared.error?.message).toBe('grants_append_only')
  })

  it('a grant over its cap, or issued by an email, is refused', async () => {
    const overCap = await service.from('grants').insert({ ...grantFor(owner.id), cash_amount: 101 })
    expect(overCap.error?.code).toBe('23514')
    const byEmail = await service
      .from('grants')
      .insert({ ...grantFor(owner.id), issued_by: 'ops@example.com' })
    expect(byEmail.error?.code).toBe('23514')
  })

  it('a live-mode purchase is refused (Stripe test mode only)', async () => {
    const { error } = await service
      .from('purchases')
      .insert({ ...purchaseFor(owner.id), livemode: true })
    expect(error?.code).toBe('23514')
  })

  it('an entitlement must link exactly the record its source names', async () => {
    const { error } = await service.from('entitlements').insert({
      user_id: owner.id,
      item_id: 'premium-test-scarf',
      source: 'purchase',
      grant_id: seeded.grant.id,
    })
    expect(error?.code).toBe('23514')
  })

  it('one live entitlement per item per player', async () => {
    const { error } = await service.from('entitlements').insert({
      user_id: owner.id,
      item_id: 'premium-test-hat',
      source: 'grant',
      grant_id: seeded.grant.id,
    })
    expect(error?.code).toBe('23505')
  })
})
