'use client'

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { birthYearOptions, currentCityYear, isAdultBirthYear } from '@/engine/ageGate'
import { copy, copyParts, type CopyKey } from '@/lib/copy'
import { fieldErrors, firstInvalid, type FieldErrors } from '@/lib/forms/errors'
import {
  AUDIO_CHOICES,
  EMPTY_WELCOME_VALUES,
  WELCOME_FIELDS,
  createWelcomeSchema,
  type AudioChoice,
  type WelcomeField,
  type WelcomeValues,
} from '@/lib/forms/welcome'
import { unlockAudioFromGesture } from '@/lib/audio/unlock'
import { onboardingConfig, onboardingStore } from '@/state/onboarding'
import { startGuestSession } from '@/state/session'
// Copy namespaces this module renders (DEC-11: they load with this module's chunk).
import '@/lib/copy/ns/welcome'

interface WelcomeCardProps {
  readonly titleId: string
  readonly introId: string
}

const ERROR_ID: Readonly<Record<WelcomeField, string>> = {
  birthYear: 'welcome-birth-year-error',
  consent: 'welcome-consent-error',
  audio: 'welcome-audio-error',
}

const AUDIO_LABEL: Readonly<Record<AudioChoice, CopyKey>> = {
  ours: 'welcome.audio.ours',
  own: 'welcome.audio.own',
}

const LEGAL_LINK: Readonly<Record<string, { href: string; label: CopyKey }>> = {
  terms: { href: '/terms', label: 'welcome.consent.terms' },
  privacy: { href: '/privacy', label: 'welcome.consent.privacy' },
}

// Native controls styled in place (GR-8): nothing is layered over them.
const CHOICE_INPUT = 'h-6 w-6 shrink-0 accent-taxi-ink'
const CHOICE_LABEL = 'flex min-h-11 cursor-pointer gap-3 py-2.5'

function invalidProps(field: WelcomeField, errors: FieldErrors<WelcomeField>) {
  return errors[field] === undefined
    ? {}
    : { 'aria-invalid': true as const, 'aria-describedby': ERROR_ID[field] }
}

function FieldError({ field, errors }: { field: WelcomeField; errors: FieldErrors<WelcomeField> }) {
  const key = errors[field]
  if (key === undefined) return null
  return (
    <p id={ERROR_ID[field]} className="mt-1 text-sm font-semibold text-danger">
      {copy(key)}
    </p>
  )
}

function ConsentLabel() {
  return (
    <span>
      {copyParts('welcome.consent.label').map((part, index) => {
        if (part.kind === 'text') return part.text
        const link = LEGAL_LINK[part.name]
        if (link === undefined) throw new Error(`No link for consent slot {${part.name}}`)
        return (
          <a
            key={index}
            href={link.href}
            target="_blank"
            rel="noopener noreferrer"
            className="font-semibold text-taxi-ink underline underline-offset-2"
          >
            {copy(link.label)}
            <span className="sr-only"> {copy('welcome.newTab')}</span>
          </a>
        )
      })}
    </span>
  )
}

/**
 * The welcome card form (GR-1, GR-2, GR-8): a neutral year-of-birth picker with no default and
 * no hint of the age rule, the Terms/Privacy consent and the sound choice. Errors come from one
 * schema, are recomputed on every change and appear together after the first submit.
 *
 * The birth year lives only in this component's state: it is never stored, logged or sent.
 * Picking a sound option does nothing audible; submitting a passing card is the deliberate tap
 * that turns sound on (GR-13), with music muted from the start under "I'll bring my own".
 */
export function WelcomeCard({ titleId, introId }: WelcomeCardProps) {
  // Client-only (the gate renders nothing on the server), so reading the clock here is safe.
  const [currentYear] = useState(() => currentCityYear(Date.now()))
  const [values, setValues] = useState<WelcomeValues>(EMPTY_WELCOME_VALUES)
  const [attempted, setAttempted] = useState(false)

  const schema = useMemo(() => createWelcomeSchema(currentYear, onboardingConfig), [currentYear])
  const years = useMemo(
    () => birthYearOptions(currentYear, onboardingConfig.birthYearSpan),
    [currentYear],
  )
  const errors = useMemo(() => fieldErrors(schema, values), [schema, values])
  const shown = attempted ? errors : {}

  const title = useRef<HTMLHeadingElement>(null)
  const birthYear = useRef<HTMLSelectElement>(null)
  const consent = useRef<HTMLInputElement>(null)
  const firstAudio = useRef<HTMLInputElement>(null)

  useEffect(() => title.current?.focus(), [])

  const update = (patch: Partial<WelcomeValues>) => setValues((prev) => ({ ...prev, ...patch }))

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setAttempted(true)
    const parsed = schema.safeParse(values)
    if (!parsed.success) {
      const field = firstInvalid(WELCOME_FIELDS, errors)
      const target = { birthYear, consent, audio: firstAudio }[field ?? 'birthYear']
      target.current?.focus()
      return
    }
    const nowMs = Date.now()
    const onboarding = onboardingStore.getState()
    if (!isAdultBirthYear(Number(parsed.data.birthYear), nowMs, onboardingConfig)) {
      onboarding.refuseUnderAge(nowMs)
      return
    }
    const choice = {
      consentVersion: onboardingConfig.consentVersion,
      audioChoice: parsed.data.audio,
    }
    if (!onboarding.completeAdult(choice, nowMs)) return
    // Synchronously, still inside the submit gesture: Safari only starts audio there.
    unlockAudioFromGesture()
    startGuestSession()
  }

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h2
          ref={title}
          id={titleId}
          tabIndex={-1}
          className="text-2xl font-extrabold tracking-tight text-fg focus:outline-none"
        >
          {copy('welcome.title')}
        </h2>
        <p id={introId} className="text-sm text-muted">
          {copy('welcome.intro')}
        </p>
      </header>

      <form noValidate onSubmit={onSubmit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="welcome-birth-year" className="text-sm font-semibold text-fg">
            {copy('welcome.birthYear.label')}
          </label>
          <select
            ref={birthYear}
            id="welcome-birth-year"
            name="birthYear"
            value={values.birthYear}
            onChange={(event) => update({ birthYear: event.target.value })}
            className="min-h-11 w-full rounded-xl border border-line bg-canvas px-3 text-base text-fg focus-visible:outline-2 focus-visible:outline-focus"
            {...invalidProps('birthYear', shown)}
          >
            <option value="">{copy('welcome.birthYear.placeholder')}</option>
            {years.map((year) => (
              <option key={year} value={String(year)}>
                {String(year)}
              </option>
            ))}
          </select>
          <FieldError field="birthYear" errors={shown} />
        </div>

        <div>
          <label className={`${CHOICE_LABEL} items-start text-sm text-fg`}>
            <input
              ref={consent}
              id="welcome-consent"
              type="checkbox"
              name="consent"
              checked={values.consent}
              onChange={(event) => update({ consent: event.target.checked })}
              className={CHOICE_INPUT}
              {...invalidProps('consent', shown)}
            />
            <ConsentLabel />
          </label>
          <FieldError field="consent" errors={shown} />
        </div>

        <fieldset role="radiogroup" className="flex flex-col" {...invalidProps('audio', shown)}>
          <legend className="text-sm font-semibold text-fg">{copy('welcome.audio.legend')}</legend>
          {AUDIO_CHOICES.map((choice, index) => (
            <label key={choice} className={`${CHOICE_LABEL} items-center text-base text-fg`}>
              <input
                ref={index === 0 ? firstAudio : undefined}
                type="radio"
                name="audio"
                value={choice}
                checked={values.audio === choice}
                onChange={() => update({ audio: choice })}
                className={CHOICE_INPUT}
              />
              {copy(AUDIO_LABEL[choice])}
            </label>
          ))}
          <FieldError field="audio" errors={shown} />
        </fieldset>

        <button
          type="submit"
          className="min-h-11 rounded-full bg-taxi px-6 text-base font-extrabold text-on-taxi focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          {copy('welcome.submit')}
        </button>
      </form>
    </div>
  )
}
