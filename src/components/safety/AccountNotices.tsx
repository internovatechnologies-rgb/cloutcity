'use client'

import Link from 'next/link'
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from 'react'
import { useModalPresence } from '@/components/overlay/modalState'
import { trapTab } from '@/components/overlay/trapTab'
import { copy, copyParts } from '@/lib/copy'
import { createAppealSchema, isAppealable } from '@/lib/forms/appeal'
import { fieldErrors } from '@/lib/forms/errors'
import { moderationConfig } from '@/lib/forms/report'
import { formatCount, formatDate } from '@/lib/format'
import { log } from '@/lib/log'
import { noticeKey, reportReasonKey, rpcErrorText } from '@/lib/safety/errorCopy'
import type { AccountNotice } from '@/lib/supabase/safetyApi'
import {
  accountNoticesStore,
  clearAccountNotices,
  removeAccountNotice,
} from '@/state/accountNotices'
import { SAFETY_BUTTON } from './styles'
// Copy namespaces this module renders (DEC-11: they load with this module's chunk).
import '@/lib/copy/ns/safety'

const state = () => accountNoticesStore.getState()

/**
 * A moderator's notice about the player's account (S18b), shown as a modal at session start:
 * what was decided, why, until when, and a link to the Code of Conduct. "Got it" acknowledges it
 * on the server; a sanction can be appealed once from here. Escape puts the notices away for
 * this session without acknowledging them, so they show again next time.
 */
export function AccountNotices() {
  const { notices, api } = useSyncExternalStore(accountNoticesStore.subscribe, state, state)
  const notice = notices[0]
  if (notice === undefined || api === null) return null
  return <NoticeDialog key={notice.id} notice={notice} api={api} />
}

function NoticeDialog({
  notice,
  api,
}: {
  readonly notice: AccountNotice
  readonly api: NonNullable<ReturnType<typeof state>['api']>
}) {
  useModalPresence(true)
  const dialog = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const bodyId = useId()
  const appealId = useId()
  const [step, setStep] = useState<'notice' | 'appeal'>('notice')
  const [body, setBody] = useState('')
  const [attempted, setAttempted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)
  const schema = useMemo(() => createAppealSchema(), [])
  const errors = useMemo(() => fieldErrors(schema, { body }), [schema, body])
  const shownError = attempted ? errors.body : undefined

  useEffect(() => {
    dialog.current?.querySelector<HTMLElement>('h2')?.focus()
  }, [step])

  // On close, after the page behind stops being inert (the next frame): the map.
  useEffect(
    () => () => {
      requestAnimationFrame(() => document.querySelector<HTMLElement>('main')?.focus())
    },
    [],
  )

  useEffect(() => {
    const element = dialog.current
    if (element === null) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        if (step === 'appeal') setStep('notice')
        else clearAccountNotices()
        return
      }
      trapTab(element, event)
    }
    element.addEventListener('keydown', onKeyDown)
    return () => element.removeEventListener('keydown', onKeyDown)
  }, [step])

  async function acknowledge() {
    if (busy) return
    setBusy(true)
    const result = await api.acknowledgeNotice(notice.id)
    setBusy(false)
    if (!result.ok && result.code !== 'notice_not_found') {
      log.info('A notice was not acknowledged', { code: result.code })
      setError(rpcErrorText(result.code))
      return
    }
    removeAccountNotice(notice.id)
  }

  async function submitAppeal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    setAttempted(true)
    if (errors.body !== undefined) {
      dialog.current?.querySelector<HTMLElement>('textarea')?.focus()
      return
    }
    setBusy(true)
    setError(null)
    const result = await api.appeal(notice.id, body)
    setBusy(false)
    if (!result.ok && result.code !== 'appeal_exists') {
      log.info('An appeal was refused', { code: result.code })
      setError(rpcErrorText(result.code))
      return
    }
    setSent(true)
    setStep('notice')
  }

  const conduct = copyParts('safety.notice.conduct').map((part, index) =>
    part.kind === 'text' ? (
      part.text
    ) : (
      <Link
        key={index}
        href="/conduct"
        className="font-semibold text-taxi-ink underline underline-offset-2"
      >
        {copy('safety.report.conductLink')}
      </Link>
    ),
  )

  return (
    <div
      ref={dialog}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      data-account-notice={notice.kind}
      data-cc-feature="cc-feature:account-notices"
      className="pointer-events-auto m-auto flex max-h-full w-full max-w-md flex-col gap-3 overflow-y-auto rounded-2xl border border-taxi glass p-4 shadow-xl"
    >
      <h2
        id={titleId}
        tabIndex={-1}
        className="text-xl font-extrabold text-taxi-ink focus:outline-none"
      >
        {copy(step === 'appeal' ? 'safety.notice.appealTitle' : 'safety.notice.title')}
      </h2>
      <div id={bodyId} className="flex flex-col gap-1 text-sm text-fg">
        <p>{copy(noticeKey(notice.kind))}</p>
        {notice.reason === null ? null : (
          <p>{copy('safety.notice.reason', { reason: copy(reportReasonKey(notice.reason)) })}</p>
        )}
        {notice.endsAt === null ? null : (
          <p>{copy('safety.notice.until', { date: formatDate(notice.endsAt) })}</p>
        )}
        <p className="text-muted">{conduct}</p>
      </div>
      {step === 'appeal' ? (
        <form noValidate onSubmit={submitAppeal} className="flex flex-col gap-2">
          <label htmlFor={appealId} className="text-sm font-semibold text-fg">
            {copy('safety.notice.appealLabel')}
          </label>
          <textarea
            id={appealId}
            rows={4}
            value={body}
            onChange={(event) => {
              setBody(event.target.value)
              setError(null)
            }}
            aria-invalid={shownError === undefined ? undefined : true}
            aria-describedby={`${appealId}-hint${shownError === undefined ? '' : ` ${appealId}-error`}`}
            className="w-full rounded-xl border border-line bg-canvas px-3 py-2 text-base text-fg focus-visible:outline-2 focus-visible:outline-focus"
          />
          <p id={`${appealId}-hint`} className="text-xs text-muted">
            {copy('safety.notice.appealHint', {
              max: formatCount(moderationConfig.appealMaxChars),
            })}
          </p>
          {shownError === undefined ? null : (
            <p id={`${appealId}-error`} className="text-sm font-semibold text-danger">
              {copy(shownError)}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              aria-disabled={busy ? true : undefined}
              className={`${SAFETY_BUTTON} bg-taxi text-on-taxi`}
            >
              {busy ? copy('safety.notice.appealSending') : copy('safety.notice.appealSubmit')}
            </button>
            <button
              type="button"
              onClick={() => setStep('notice')}
              className={`${SAFETY_BUTTON} bg-raised text-fg`}
            >
              {copy('safety.notice.appealCancel')}
            </button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void acknowledge()}
            aria-disabled={busy ? true : undefined}
            className={`${SAFETY_BUTTON} bg-taxi text-on-taxi`}
          >
            {copy('safety.notice.ok')}
          </button>
          {isAppealable(notice) && !sent ? (
            <button
              type="button"
              onClick={() => setStep('appeal')}
              className={`${SAFETY_BUTTON} bg-raised text-fg`}
            >
              {copy('safety.notice.appeal')}
            </button>
          ) : null}
        </div>
      )}
      <p role="status" className="min-h-5 text-sm text-taxi-ink">
        {sent ? copy('safety.notice.appealSent') : null}
      </p>
      {error === null ? null : (
        <p role="alert" className="text-sm font-semibold text-danger">
          {error}
        </p>
      )}
    </div>
  )
}
