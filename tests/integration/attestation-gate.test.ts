import { describe, expect, it } from 'vitest'
import { anonClient, befriend, expectRpcError, newAttestedGuest, newGuest, sql } from './helpers'

describe('the attestation gate (private.require_attestation)', () => {
  it('refuses an unattested guest with 403 attestation_required', async () => {
    const guest = await newGuest()
    const { error, status } = await guest.client.rpc('assert_attested')
    expectRpcError(error, 'attestation_required', 'PT403')
    expect(status).toBe(403)
  })

  it('refuses an unattested guest sending a friend boost, even to an accepted friend', async () => {
    const guest = await newGuest()
    const friend = await newAttestedGuest()
    await befriend(guest, friend)
    const { error, status } = await guest.client.rpc('send_friend_boost', { p_to: friend.id })
    expectRpcError(error, 'attestation_required', 'PT403')
    expect(status).toBe(403)
    const [row] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.friend_boosts where sender_id = ${guest.id}
    `
    expect(row?.n).toBe(0)
  })

  it('a visitor with no session cannot reach the gated RPCs at all (401)', async () => {
    for (const call of [
      anonClient().rpc('assert_attested'),
      anonClient().rpc('send_friend_boost', { p_to: crypto.randomUUID() }),
    ]) {
      const { error, status } = await call
      expect(error?.code).toBe('42501')
      expect(status).toBe(401)
    }
  })

  it('an authenticated request without a user id gets 401 not_authenticated', async () => {
    // The gate's own check, below the role grant: the authenticated role with no `sub` claim.
    await expect(
      sql.begin(async (tx) => {
        await tx`set local role authenticated`
        await tx`select public.assert_attested()`
      }),
    ).rejects.toMatchObject({ code: 'PT401', message: 'not_authenticated' })
  })

  it('lets an attested guest through', async () => {
    const guest = await newAttestedGuest()
    const { error } = await guest.client.rpc('assert_attested')
    expect(error).toBeNull()
    // Past the gate, send_friend_boost reaches its own checks.
    const stranger = await newAttestedGuest()
    const boost = await guest.client.rpc('send_friend_boost', { p_to: stranger.id })
    expectRpcError(boost.error, 'not_friends', 'PT403')
  })
})
