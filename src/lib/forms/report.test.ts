import { describe, expect, it } from 'vitest'
import { HANDLE_REPORT_REASONS, REPORT_REASONS } from '@/lib/safety/reports'
import { RPC_ERRORS } from '@/lib/supabase/attestation'
import { fieldErrors, firstInvalid } from './errors'
import {
  EMPTY_REPORT_VALUES,
  REPORT_FIELDS,
  SubmitReportResultSchema,
  createReportSchema,
  moderationConfig,
  reportFieldForRpcError,
  trimNote,
} from './report'

const playerSchema = createReportSchema('player')
const handleSchema = createReportSchema('handle')

describe('report form schema', () => {
  it('accepts a reason with no note, and a note that is plain evidence', () => {
    expect(fieldErrors(playerSchema, { reason: 'harassment', note: '' })).toEqual({})
    expect(
      fieldErrors(playerSchema, { reason: 'hate', note: 'called me a slur, then a bastard' }),
    ).toEqual({})
  })

  it('shows every error at once', () => {
    const errors = fieldErrors(playerSchema, { reason: '', note: 'add me on ig: coolcat' })
    expect(errors).toEqual({
      reason: 'safety.report.error.reason',
      note: 'safety.report.error.noteContact',
    })
    expect(firstInvalid(REPORT_FIELDS, errors)).toBe('reason')
  })

  it('an empty form asks for a reason only', () => {
    expect(fieldErrors(playerSchema, EMPTY_REPORT_VALUES)).toEqual({
      reason: 'safety.report.error.reason',
    })
  })

  it('counts the note in code points after trimming spaces, as the database does', () => {
    const max = moderationConfig.noteMaxChars
    const atMax = '😀'.repeat(max)
    expect(fieldErrors(playerSchema, { reason: 'spam', note: `  ${atMax}  ` })).toEqual({})
    expect(fieldErrors(playerSchema, { reason: 'spam', note: `${atMax}a` })).toEqual({
      note: 'safety.report.error.noteTooLong',
    })
    expect(trimNote('  a b  ')).toBe('a b')
  })

  it('offers every reason for a player and only the handle subset for a handle', () => {
    for (const reason of REPORT_REASONS) {
      expect(fieldErrors(playerSchema, { reason, note: '' }), reason).toEqual({})
      const handleErrors = fieldErrors(handleSchema, { reason, note: '' })
      expect(handleErrors.reason === undefined, reason).toBe(
        (HANDLE_REPORT_REASONS as readonly string[]).includes(reason),
      )
    }
  })

  it('refuses a reason that is not on the list', () => {
    expect(fieldErrors(playerSchema, { reason: 'vibes', note: '' }).reason).toBe(
      'safety.report.error.reason',
    )
  })
})

describe('reportFieldForRpcError', () => {
  it('puts the server refusals under their fields', () => {
    expect(reportFieldForRpcError('invalid_reason')).toBe('reason')
    expect(reportFieldForRpcError('note_too_long')).toBe('note')
    expect(reportFieldForRpcError('note_contact_info')).toBe('note')
    expect(reportFieldForRpcError('rate_limited')).toBeNull()
    expect(reportFieldForRpcError('unknown')).toBeNull()
  })

  it('every code it maps is a known RPC error', () => {
    for (const code of RPC_ERRORS) {
      const field = reportFieldForRpcError(code)
      if (field !== null) expect(REPORT_FIELDS).toContain(field)
    }
  })
})

describe('SubmitReportResultSchema', () => {
  it('reads one submit_report row', () => {
    const row = { report_id: '9f1c1d6e-0000-4000-8000-000000000000', duplicate: false }
    expect(SubmitReportResultSchema.parse(row)).toEqual(row)
    expect(SubmitReportResultSchema.safeParse({ report_id: 1 }).success).toBe(false)
  })
})
