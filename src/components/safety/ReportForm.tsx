'use client'

import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react'
import { copy, copyParts, type CopyKey } from '@/lib/copy'
import { fieldErrors, firstInvalid, type FieldErrors } from '@/lib/forms/errors'
import {
  EMPTY_REPORT_VALUES,
  REPORT_FIELDS,
  createReportSchema,
  moderationConfig,
  reportFieldForRpcError,
  type ReportField,
  type ReportValues,
} from '@/lib/forms/report'
import { formatCount } from '@/lib/format'
import { log } from '@/lib/log'
import { reportReasonKey, rpcErrorText } from '@/lib/safety/errorCopy'
import { reportReasonsFor, type ReportKind } from '@/lib/safety/reports'
import type { SafetyApi } from '@/lib/supabase/safetyApi'
import { CrisisPanel } from './CrisisPanel'
import { SAFETY_BUTTON } from './styles'
// Copy namespaces this module renders (DEC-11: they load with this module's chunk).
import '@/lib/copy/ns/safety'

export interface ReportOutcome {
  readonly duplicate: boolean
  /** True when "Also block" was ticked; the caller blocks after the report is in. */
  readonly alsoBlock: boolean
}

/** Code points, as the server counts the note. */
const charCount = (text: string) => [...text].length

/** One id per report attempt, so a retry after a dropped answer never files it twice. */
function newIdempotencyKey(): string {
  return crypto.randomUUID()
}

/**
 * The report form (S18b; GR-1, GR-2, GR-8): reason radios, an optional note with a live counter,
 * "Also block", and a link to the Code of Conduct. Errors come from the shared schema
 * (createReportSchema, the same rules submit_report enforces), recompute on every change and all
 * show after the first submit, each under its field, with focus on the first. Picking "Someone
 * might hurt themselves" shows the crisis lines at once. The note is sent, never logged.
 */
export function ReportForm({
  handle,
  target,
  kind = 'player',
  api,
  onSubmitted,
  onCancel,
}: {
  readonly handle: string
  readonly target: string
  readonly kind?: ReportKind
  readonly api: SafetyApi
  readonly onSubmitted: (outcome: ReportOutcome) => void
  readonly onCancel: () => void
}) {
  const id = useId()
  const titleRef = useRef<HTMLHeadingElement>(null)
  const firstReason = useRef<HTMLInputElement>(null)
  const noteRef = useRef<HTMLTextAreaElement>(null)
  const [values, setValues] = useState<ReportValues>(EMPTY_REPORT_VALUES)
  const [alsoBlock, setAlsoBlock] = useState(false)
  const [attempted, setAttempted] = useState(false)
  const [serverErrors, setServerErrors] = useState<FieldErrors<ReportField>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [idempotencyKey] = useState(newIdempotencyKey)

  const schema = useMemo(() => createReportSchema(kind), [kind])
  const errors = useMemo(() => fieldErrors(schema, values), [schema, values])
  const shown: FieldErrors<ReportField> = { ...(attempted ? errors : {}), ...serverErrors }
  const max = moderationConfig.noteMaxChars
  const reasons = reportReasonsFor(kind)

  useEffect(() => titleRef.current?.focus(), [])

  const errorId = (field: ReportField) => `${id}-${field}-error`
  const invalid = (field: ReportField) =>
    shown[field] === undefined
      ? {}
      : { 'aria-invalid': true as const, 'aria-describedby': errorId(field) }
  const update = (patch: Partial<ReportValues>) => {
    setValues((previous) => ({ ...previous, ...patch }))
    setServerErrors({})
    setFormError(null)
  }

  function focusField(field: ReportField) {
    ;(field === 'reason' ? firstReason : noteRef).current?.focus()
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (sending) return
    setAttempted(true)
    const parsed = schema.safeParse(values)
    if (!parsed.success) {
      const field = firstInvalid(REPORT_FIELDS, errors)
      if (field !== undefined) focusField(field)
      return
    }
    setSending(true)
    setFormError(null)
    const result = await api.report({
      target,
      kind,
      reason: parsed.data.reason,
      note: parsed.data.note,
      idempotencyKey,
    })
    setSending(false)
    if (result.ok) {
      onSubmitted({ duplicate: result.data.duplicate, alsoBlock })
      return
    }
    log.info('A report was refused', { code: result.code })
    const field = reportFieldForRpcError(result.code)
    if (field === null) {
      setFormError(
        result.code === 'unknown' ? copy('safety.report.failed') : rpcErrorText(result.code),
      )
      return
    }
    const key = field === 'reason' ? 'safety.report.error.reason' : rpcNoteKey(result.code)
    setServerErrors({ [field]: key })
    focusField(field)
  }

  const fieldError = (field: ReportField) => {
    const key = shown[field]
    if (key === undefined) return null
    return (
      <p id={errorId(field)} className="text-sm font-semibold text-danger">
        {copy(key)}
      </p>
    )
  }

  return (
    <section
      data-report-form={kind}
      aria-labelledby={`${id}-title`}
      className="flex flex-col gap-3"
    >
      <h3
        ref={titleRef}
        id={`${id}-title`}
        tabIndex={-1}
        className="text-base font-extrabold text-taxi-ink focus:outline-none"
      >
        {copy(kind === 'handle' ? 'safety.report.titleHandle' : 'safety.report.title', { handle })}
      </h3>
      <form noValidate onSubmit={onSubmit} className="flex flex-col gap-3">
        <fieldset role="radiogroup" className="flex flex-col" {...invalid('reason')}>
          <legend className="text-sm font-semibold text-fg">
            {copy('safety.report.reasonLegend')}
          </legend>
          {reasons.map((reason, index) => (
            <label key={reason} className="flex min-h-11 cursor-pointer items-center gap-3 py-1">
              <input
                ref={index === 0 ? firstReason : undefined}
                type="radio"
                name={`${id}-reason`}
                value={reason}
                checked={values.reason === reason}
                onChange={() => update({ reason })}
                className="h-6 w-6 shrink-0 accent-taxi"
              />
              <span className="text-sm text-fg">{copy(reportReasonKey(reason))}</span>
            </label>
          ))}
          {fieldError('reason')}
        </fieldset>

        {values.reason === 'self_harm' ? <CrisisPanel /> : null}

        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-note`} className="text-sm font-semibold text-fg">
            {copy('safety.report.noteLabel')}
          </label>
          <textarea
            ref={noteRef}
            id={`${id}-note`}
            name="note"
            rows={3}
            value={values.note}
            onChange={(event) => update({ note: event.target.value })}
            aria-invalid={shown.note === undefined ? undefined : true}
            aria-describedby={[
              `${id}-note-hint`,
              `${id}-note-count`,
              shown.note === undefined ? null : errorId('note'),
            ]
              .filter((part) => part !== null)
              .join(' ')}
            className="w-full rounded-xl border border-line bg-canvas px-3 py-2 text-base text-fg focus-visible:outline-2 focus-visible:outline-focus"
          />
          <p id={`${id}-note-hint`} className="text-xs text-muted">
            {copy('safety.report.noteHint', { max: formatCount(max) })}
          </p>
          <p
            id={`${id}-note-count`}
            data-note-count={charCount(values.note)}
            className={`text-xs ${charCount(values.note) > max ? 'font-semibold text-danger' : 'text-muted'}`}
          >
            {copy('safety.report.counter', {
              count: formatCount(charCount(values.note)),
              max: formatCount(max),
            })}
          </p>
          {fieldError('note')}
        </div>

        <label className="flex min-h-11 cursor-pointer items-center gap-3">
          <input
            type="checkbox"
            name="alsoBlock"
            checked={alsoBlock}
            onChange={(event) => setAlsoBlock(event.target.checked)}
            className="h-6 w-6 shrink-0 accent-taxi"
          />
          <span className="text-sm text-fg">{copy('safety.report.alsoBlock', { handle })}</span>
        </label>

        <p className="text-xs text-muted">{copy('safety.report.private', { handle })}</p>
        <p className="text-xs text-muted">
          {copyParts('safety.report.conduct').map((part, index) =>
            part.kind === 'text' ? (
              part.text
            ) : (
              <a
                key={index}
                href="/conduct"
                target="_blank"
                rel="noopener noreferrer"
                className="font-semibold text-taxi-ink underline underline-offset-2"
              >
                {copy('safety.report.conductLink')}
              </a>
            ),
          )}
        </p>

        {formError === null ? null : (
          <p role="alert" className="text-sm font-semibold text-danger">
            {formError}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <button
            type="submit"
            aria-disabled={sending ? true : undefined}
            className={`${SAFETY_BUTTON} bg-taxi text-on-taxi`}
          >
            {sending ? copy('safety.report.sending') : copy('safety.report.submit')}
          </button>
          <button type="button" onClick={onCancel} className={`${SAFETY_BUTTON} bg-raised text-fg`}>
            {copy('safety.report.cancel')}
          </button>
        </div>
      </form>
    </section>
  )
}

function rpcNoteKey(code: string): CopyKey {
  return code === 'note_too_long'
    ? 'safety.report.error.noteTooLong'
    : 'safety.report.error.noteContact'
}
