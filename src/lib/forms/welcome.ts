/**
 * The welcome card form (S05a): year of birth, Terms/Privacy consent and the sound choice. One
 * zod/mini schema validates it; each message is the copy key of the error shown under the field.
 *
 * Being under age is not a validation error: a valid year that fails the age rule is refused by
 * the card after validation (src/engine/ageGate.ts), so the form never hints at the threshold.
 */
import * as z from 'zod/mini'
import { birthYearOptions, type AgeGateConfig } from '@/engine/ageGate'
import type { CopyKey } from '@/lib/copy'
// The error keys below are rendered by fieldErrors, which needs their namespace loaded.
import '@/lib/copy/ns/welcome'

export const AUDIO_CHOICES = ['ours', 'own'] as const
export type AudioChoice = (typeof AUDIO_CHOICES)[number]

/** Fields in DOM order, which is also the order focus moves to the first invalid one. */
export const WELCOME_FIELDS = ['birthYear', 'consent', 'audio'] as const
export type WelcomeField = (typeof WELCOME_FIELDS)[number]

/** What the native controls hold: the select's value, the checkbox, the checked radio. */
export interface WelcomeValues {
  readonly birthYear: string
  readonly consent: boolean
  readonly audio: '' | AudioChoice
}

export const EMPTY_WELCOME_VALUES: WelcomeValues = { birthYear: '', consent: false, audio: '' }

const ERROR = {
  birthYear: 'welcome.birthYear.error',
  consent: 'welcome.consent.error',
  audio: 'welcome.audio.error',
} as const satisfies Record<WelcomeField, CopyKey>

/** The schema for a card rendered in `currentYear`: the year must be one the picker offers. */
export function createWelcomeSchema(
  currentYear: number,
  config: Pick<AgeGateConfig, 'birthYearSpan'>,
) {
  const years = new Set(birthYearOptions(currentYear, config.birthYearSpan).map(String))
  return z.object({
    birthYear: z.string().check(
      z.regex(/^\d{4}$/, ERROR.birthYear),
      z.refine((value) => years.has(value), ERROR.birthYear),
    ),
    consent: z.literal(true, ERROR.consent),
    audio: z.enum(AUDIO_CHOICES, ERROR.audio),
  })
}
