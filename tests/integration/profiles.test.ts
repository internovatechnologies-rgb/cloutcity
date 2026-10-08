import { describe, expect, it } from 'vitest'
import { toAttestationArgs } from '@/lib/supabase/attestation'
import {
  anonClient,
  expectRpcError,
  newAttestedGuest,
  newGuest,
  welcomeRecord,
  type Guest,
} from './helpers'

async function ownProfile(guest: Guest) {
  const { data, error } = await guest.client.from('profiles').select('*').eq('id', guest.id)
  if (error !== null) throw error
  expect(data).toHaveLength(1)
  const [row] = data
  if (row === undefined) throw new Error('no profile')
  return row
}

const validArgs = () => toAttestationArgs(welcomeRecord())

describe('profiles: creation on the first guest session', () => {
  it('signInAnonymously creates an unattested profile', async () => {
    const guest = await newGuest()
    const profile = await ownProfile(guest)
    expect(profile).toMatchObject({
      id: guest.id,
      attested: false,
      attested_at: null,
      attestation_recorded_at: null,
      consent_version: null,
      consented_at: null,
      audio_choice: null,
    })
  })

  it('stores no birth year or age anywhere on the profile', async () => {
    const profile = await ownProfile(await newGuest())
    expect(Object.keys(profile).filter((key) => /birth|year|age$/i.test(key))).toEqual([])
  })
})

describe('attest_and_consent', () => {
  it('records the S05a attestation, consent and audio choice', async () => {
    const guest = await newGuest()
    const args = validArgs()
    const before = Date.now()
    const { data, error } = await guest.client.rpc('attest_and_consent', args)
    expect(error).toBeNull()
    const profile = await ownProfile(guest)
    expect(data).toMatchObject({ id: guest.id, attested: true })
    expect(profile.attested).toBe(true)
    expect(new Date(profile.attested_at ?? '').getTime()).toBe(Date.parse(args.p_attested_at))
    expect(new Date(profile.consented_at ?? '').getTime()).toBe(Date.parse(args.p_consented_at))
    expect(profile.consent_version).toBe('2026-10-06')
    expect(profile.audio_choice).toBe('ours')
    const recorded = new Date(profile.attestation_recorded_at ?? '').getTime()
    expect(recorded).toBeGreaterThan(before - 60_000)
  })

  it('the first attestation wins; a retry with the same version keeps the consent time', async () => {
    const guest = await newAttestedGuest()
    const first = await ownProfile(guest)
    const later = toAttestationArgs({ ...welcomeRecord(), attestedAt: Date.now() - 5_000 })
    const { error } = await guest.client.rpc('attest_and_consent', {
      ...later,
      p_consented_at: new Date(Date.now() - 5_000).toISOString(),
    })
    expect(error).toBeNull()
    const second = await ownProfile(guest)
    expect(second.attested_at).toBe(first.attested_at)
    expect(second.attestation_recorded_at).toBe(first.attestation_recorded_at)
    expect(second.consented_at).toBe(first.consented_at)
  })

  it('a new consent version updates the consent and its time', async () => {
    const guest = await newAttestedGuest()
    const first = await ownProfile(guest)
    const consentedAt = new Date(Date.now() - 1_000).toISOString()
    const { error } = await guest.client.rpc('attest_and_consent', {
      ...validArgs(),
      p_consent_version: '2027-01-15',
      p_consented_at: consentedAt,
    })
    expect(error).toBeNull()
    const second = await ownProfile(guest)
    expect(second.consent_version).toBe('2027-01-15')
    expect(new Date(second.consented_at ?? '').getTime()).toBe(Date.parse(consentedAt))
    expect(second.attested_at).toBe(first.attested_at)
  })

  it.each([
    ['not an adult', { p_adult: false }, 'not_adult'],
    [
      'an attestation in the future',
      { p_attested_at: new Date(Date.now() + 10 * 60_000).toISOString() },
      'invalid_timestamp',
    ],
    ['an ancient attestation', { p_attested_at: '2025-12-31T23:59:59Z' }, 'invalid_timestamp'],
    [
      'a consent in the future',
      { p_consented_at: new Date(Date.now() + 10 * 60_000).toISOString() },
      'invalid_timestamp',
    ],
    ['an ancient consent', { p_consented_at: '2020-01-01T00:00:00Z' }, 'invalid_timestamp'],
    ['a malformed consent version', { p_consent_version: 'v1' }, 'invalid_argument'],
    ['an unknown audio choice', { p_audio_choice: 'loud' }, 'invalid_argument'],
  ] as const)('refuses %s and records nothing', async (_name, override, message) => {
    const guest = await newGuest()
    const { error } = await guest.client.rpc('attest_and_consent', {
      ...validArgs(),
      ...(override as Record<string, unknown>),
    } as ReturnType<typeof validArgs>)
    expectRpcError(error, message, 'PT400')
    expect((await ownProfile(guest)).attested).toBe(false)
  })

  it('an attestation a few seconds ahead (device clock drift) is accepted', async () => {
    const guest = await newGuest()
    const { error } = await guest.client.rpc('attest_and_consent', {
      ...validArgs(),
      p_attested_at: new Date(Date.now() + 60_000).toISOString(),
    })
    expect(error).toBeNull()
  })

  it('without a session it is refused (anon cannot execute it)', async () => {
    const { error } = await anonClient().rpc('attest_and_consent', validArgs())
    expect(error).not.toBeNull()
  })
})

describe('set_audio_choice', () => {
  it('changes the stored sound choice', async () => {
    const guest = await newAttestedGuest()
    const { error } = await guest.client.rpc('set_audio_choice', { p_choice: 'own' })
    expect(error).toBeNull()
    expect((await ownProfile(guest)).audio_choice).toBe('own')
  })

  it('refuses an unknown choice', async () => {
    const guest = await newAttestedGuest()
    const { error } = await guest.client.rpc('set_audio_choice', { p_choice: 'loud' })
    expectRpcError(error, 'invalid_argument', 'PT400')
  })

  it('without a session it is refused', async () => {
    const { error } = await anonClient().rpc('set_audio_choice', { p_choice: 'own' })
    expect(error).not.toBeNull()
  })
})
