import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import onboardingJson from '@data/config/onboarding.json'
import type { OnboardingRecord } from '@/state/onboarding'
import {
  CONSENT_VERSION_PATTERN,
  RPC_ERRORS,
  parseRpcError,
  toAttestationArgs,
} from './attestation'

const complete: OnboardingRecord = {
  status: 'complete',
  attested: true,
  attestedAt: Date.UTC(2026, 9, 7, 12, 0, 0, 250),
  consentVersion: '2026-10-06',
  consentedAt: Date.UTC(2026, 9, 7, 12, 0, 1),
  audioChoice: 'own',
}

describe('toAttestationArgs', () => {
  it('maps a completed welcome card to the RPC arguments, epoch ms to ISO strings', () => {
    expect(toAttestationArgs(complete)).toEqual({
      p_adult: true,
      p_attested_at: '2026-10-07T12:00:00.250Z',
      p_consent_version: '2026-10-06',
      p_consented_at: '2026-10-07T12:00:01.000Z',
      p_audio_choice: 'own',
    })
  })

  it('never sends anything resembling a birth year', () => {
    const keys = Object.keys(toAttestationArgs(complete))
    expect(keys.filter((key) => /birth|year|age$/i.test(key))).toEqual([])
  })

  it('refuses an under-age lock record', () => {
    expect(() => toAttestationArgs({ status: 'locked', lockedUntil: 1 })).toThrow(/completed/)
  })

  it('refuses a consent version that is not an ISO date', () => {
    expect(() => toAttestationArgs({ ...complete, consentVersion: 'v1' })).toThrow(/ISO date/)
  })

  it('refuses a timestamp outside the Date range', () => {
    expect(() => toAttestationArgs({ ...complete, attestedAt: 9e15 })).toThrow(RangeError)
  })
})

describe('consent version format', () => {
  it('the configured consent version passes the shared pattern', () => {
    expect(CONSENT_VERSION_PATTERN.test(onboardingJson.consentVersion)).toBe(true)
  })

  it('the SQL check uses the same pattern', () => {
    const dir = resolve(import.meta.dirname, '../../../supabase/migrations')
    const file = readdirSync(dir).find((name) => name.endsWith('_s18_profiles_attestation.sql'))
    expect(file).toBeDefined()
    const sql = readFileSync(join(dir, file ?? ''), 'utf8')
    expect(sql).toContain(`consent_version ~ '${CONSENT_VERSION_PATTERN.source}'`)
    expect(sql).toContain(`p_consent_version !~ '${CONSENT_VERSION_PATTERN.source}'`)
  })
})

describe('parseRpcError', () => {
  it('reads every known code from a PostgREST error', () => {
    for (const code of RPC_ERRORS) {
      expect(parseRpcError({ code: 'PT403', message: code, details: null, hint: null })).toBe(code)
    }
  })

  it('anything else is unknown', () => {
    expect(parseRpcError({ message: 'permission denied for table saves' })).toBe('unknown')
    expect(parseRpcError({ message: 42 })).toBe('unknown')
    expect(parseRpcError(new Error('fetch failed'))).toBe('unknown')
    expect(parseRpcError(null)).toBe('unknown')
    expect(parseRpcError(undefined)).toBe('unknown')
    expect(parseRpcError('attestation_required')).toBe('unknown')
  })
})
