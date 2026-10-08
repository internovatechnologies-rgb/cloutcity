'use client'

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react'
import * as z from 'zod/mini'
import { copy } from '@/lib/copy'
import { snakeToCamel } from '@/lib/copy/camel'
import { reportReasonKey } from '@/lib/safety/errorCopy'
import type { ReportReason } from '@/lib/safety/reports'
import { formatCount, formatDate } from '@/lib/format'
import { supabaseEnv } from '@/lib/supabase/env'
import {
  MOD_ACTIONS,
  REASONED_ACTIONS,
  REPORT_REASONS,
  TIMED_ACTIONS,
  fetchCase,
  fetchQueue,
  newActionKey,
  postAction,
  type CaseDetail,
  type ModActionName,
  type ModResult,
  type Queue,
} from './modApi'
// Copy namespaces this module renders (DEC-11: they load with this module's chunk).
import '@/lib/copy/ns/mod'
import '@/lib/copy/ns/safety'

const BUTTON =
  'min-h-11 min-w-11 rounded-xl px-3 py-2 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus'
const INPUT =
  'min-h-11 w-full rounded-xl border border-line bg-canvas px-3 text-base text-fg focus-visible:outline-2 focus-visible:outline-focus'

const reasonName = (reason: string): string =>
  (REPORT_REASONS as readonly string[]).includes(reason)
    ? copy(reportReasonKey(reason as ReportReason))
    : reason

const actionName = (action: ModActionName): string => copy(`mod.action.${snakeToCamel(action)}`)

type Session =
  | { readonly state: 'loading' }
  | { readonly state: 'signed-out' }
  | { readonly state: 'signed-in'; readonly token: () => Promise<string | null> }

/** Loads the console's own session module (and supabase-js) lazily. */
async function loadSession(): Promise<Session> {
  const env = supabaseEnv()
  if (env === null) return { state: 'signed-out' }
  const auth = await import('@/lib/supabase/modAuth')
  const token = await auth.modAccessToken(env)
  if (token === null) return { state: 'signed-out' }
  return { state: 'signed-in', token: () => auth.modAccessToken(env) }
}

async function signOut() {
  const env = supabaseEnv()
  if (env === null) return
  const auth = await import('@/lib/supabase/modAuth')
  await auth.modSignOut(env)
}

const EmailSchema = z.object({ email: z.email() })

const CASE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function SignIn() {
  const id = useId()
  const [email, setEmail] = useState('')
  const [attempted, setAttempted] = useState(false)
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle')
  const input = useRef<HTMLInputElement>(null)
  const invalid = attempted && !EmailSchema.safeParse({ email: email.trim() }).success

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setAttempted(true)
    if (!EmailSchema.safeParse({ email: email.trim() }).success) {
      input.current?.focus()
      return
    }
    setState('sending')
    const response = await fetch('/api/mod/sign-in', {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.trim() }),
    }).catch(() => null)
    setState(response?.status === 202 ? 'sent' : 'failed')
  }

  return (
    <section aria-labelledby={`${id}-title`} className="flex flex-col gap-3">
      <h2 id={`${id}-title`} className="text-xl font-bold text-fg">
        {copy('mod.signIn.title')}
      </h2>
      <p className="text-sm text-muted">{copy('mod.signIn.intro')}</p>
      <form noValidate onSubmit={onSubmit} className="flex flex-col gap-2">
        <label htmlFor={`${id}-email`} className="text-sm font-semibold text-fg">
          {copy('mod.signIn.email')}
        </label>
        <input
          ref={input}
          id={`${id}-email`}
          type="email"
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          aria-invalid={invalid ? true : undefined}
          aria-describedby={invalid ? `${id}-error` : undefined}
          className={INPUT}
        />
        {invalid ? (
          <p id={`${id}-error`} className="text-sm font-semibold text-danger">
            {copy('mod.signIn.invalid')}
          </p>
        ) : null}
        <button type="submit" className={`${BUTTON} self-start bg-taxi text-on-taxi`}>
          {state === 'sending' ? copy('mod.signIn.sending') : copy('mod.signIn.submit')}
        </button>
      </form>
      <p role="status" className="text-sm text-taxi-ink">
        {state === 'sent' ? copy('mod.signIn.sent') : null}
      </p>
      {state === 'failed' ? (
        <p role="alert" className="text-sm font-semibold text-danger">
          {copy('mod.signIn.failed')}
        </p>
      ) : null}
    </section>
  )
}

/** A refusal in plain words: 409s and the auth failures get their own message. */
function failureText(result: Extract<ModResult<unknown>, { ok: false }>): string {
  if (result.status === 401) return copy('mod.unauthorized')
  if (result.status === 403) return copy('mod.forbidden')
  if (result.code === 'already_resolved') return copy('mod.action.conflict')
  if (result.code === 'idempotency_conflict') return copy('mod.action.idempotency')
  if (result.code === 'case_not_found') return copy('mod.action.notFound')
  return copy('mod.action.failed', { code: result.code })
}

function ActionForm({
  caseId,
  onDone,
  run,
}: {
  readonly caseId: string
  readonly onDone: (text: string) => void
  readonly run: (body: Readonly<Record<string, unknown>>) => Promise<ModResult<unknown>>
}) {
  const id = useId()
  const [reason, setReason] = useState('')
  const [days, setDays] = useState('7')
  const [note, setNote] = useState('')
  const [abusive, setAbusive] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // One key per decision on this case: a double click or retry replays instead of acting twice.
  const keys = useRef(new Map<ModActionName, string>())

  async function act(action: ModActionName) {
    if (busy) return
    setError(null)
    if (REASONED_ACTIONS.has(action) && reason === '') {
      setError(copy('mod.action.reasonRequired'))
      return
    }
    const dayCount = Number(days)
    if (
      TIMED_ACTIONS.has(action) &&
      !(Number.isInteger(dayCount) && dayCount >= 1 && dayCount <= 365)
    ) {
      setError(copy('mod.action.daysInvalid'))
      return
    }
    let key = keys.current.get(action)
    if (key === undefined) {
      key = newActionKey()
      keys.current.set(action, key)
    }
    setBusy(true)
    const result = await run({
      action,
      caseId,
      idempotencyKey: key,
      ...(note.trim() === '' ? {} : { note: note.trim() }),
      ...(action === 'dismiss' ? { abusive } : {}),
      ...(REASONED_ACTIONS.has(action) ? { reason } : {}),
      ...(TIMED_ACTIONS.has(action) ? { days: dayCount } : {}),
    })
    setBusy(false)
    if (!result.ok) {
      setError(failureText(result))
      return
    }
    onDone(copy('mod.action.done', { action: actionName(action) }))
  }

  return (
    <section
      aria-labelledby={`${id}-title`}
      className="flex flex-col gap-2 rounded-xl bg-raised p-3"
    >
      <h3 id={`${id}-title`} className="font-bold text-fg">
        {copy('mod.action.title')}
      </h3>
      <label htmlFor={`${id}-reason`} className="text-sm font-semibold text-fg">
        {copy('mod.action.reason')}
      </label>
      <select
        id={`${id}-reason`}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        className={INPUT}
      >
        <option value="">{copy('mod.action.reasonRequired')}</option>
        {REPORT_REASONS.map((value) => (
          <option key={value} value={value}>
            {reasonName(value)}
          </option>
        ))}
      </select>
      <label htmlFor={`${id}-days`} className="text-sm font-semibold text-fg">
        {copy('mod.action.days')}
      </label>
      <input
        id={`${id}-days`}
        type="number"
        inputMode="numeric"
        min={1}
        max={365}
        value={days}
        onChange={(event) => setDays(event.target.value)}
        className={INPUT}
      />
      <label htmlFor={`${id}-note`} className="text-sm font-semibold text-fg">
        {copy('mod.action.note')}
      </label>
      <textarea
        id={`${id}-note`}
        rows={2}
        maxLength={500}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        className="w-full rounded-xl border border-line bg-canvas px-3 py-2 text-base text-fg"
      />
      <label className="flex min-h-11 items-center gap-3 text-sm text-fg">
        <input
          type="checkbox"
          checked={abusive}
          onChange={(event) => setAbusive(event.target.checked)}
          className="h-6 w-6"
        />
        {copy('mod.action.abusive')}
      </label>
      <div className="flex flex-wrap gap-2">
        {MOD_ACTIONS.map((action) => (
          <button
            key={action}
            type="button"
            data-mod-action={action}
            aria-disabled={busy ? true : undefined}
            onClick={() => void act(action)}
            className={`${BUTTON} ${action === 'ban' || action === 'suspend' ? 'bg-taxi text-on-taxi' : 'bg-canvas text-fg'}`}
          >
            {actionName(action)}
          </button>
        ))}
      </div>
      {error === null ? null : (
        <p role="alert" data-mod-error="" className="text-sm font-semibold text-danger">
          {error}
        </p>
      )}
    </section>
  )
}

function CaseView({
  detail,
  onBack,
  run,
  onDone,
}: {
  readonly detail: CaseDetail
  readonly onBack: () => void
  readonly run: (body: Readonly<Record<string, unknown>>) => Promise<ModResult<unknown>>
  readonly onDone: (text: string) => void
}) {
  const handle = detail.profile?.handle ?? detail.case_id
  return (
    <section
      data-mod-case={detail.case_id}
      aria-labelledby="mod-case-title"
      className="flex flex-col gap-3"
    >
      <button type="button" onClick={onBack} className={`${BUTTON} self-start bg-raised text-fg`}>
        {copy('mod.case.back')}
      </button>
      <h2 id="mod-case-title" className="text-xl font-bold text-fg">
        {copy('mod.case.title', { handle })}
      </h2>
      {detail.profile === null ? null : (
        <p className="text-sm text-muted">
          {copy('mod.case.profile', {
            level: detail.profile.public_level,
            dream: detail.profile.career_path ?? '-',
            date: formatDate(detail.profile.created_at),
          })}
        </p>
      )}
      <p className="text-sm text-muted">
        {copy('mod.queue.standing', { standing: detail.standing })}
      </p>
      <h3 className="font-bold text-fg">{copy('mod.case.reports')}</h3>
      <ul className="flex flex-col gap-2">
        {detail.reports.map((report) => (
          <li
            key={report.report_id}
            data-mod-report={report.status}
            className="rounded-xl bg-raised p-2 text-sm text-fg"
          >
            <p className="font-semibold">
              {copy('mod.case.report', {
                reason: reasonName(report.reason),
                kind: report.kind,
                status: report.status,
                date: formatDate(report.created_at),
              })}
            </p>
            <p className="text-muted">
              {copy(report.trusted ? 'mod.case.trusted' : 'mod.case.untrusted')}
              {report.brigade ? `, ${copy('mod.queue.brigade')}` : ''}
              {report.legal_hold ? `, ${copy('mod.case.legalHold')}` : ''}
            </p>
            <p>
              {report.note === null
                ? copy('mod.case.noNote')
                : copy('mod.case.note', { note: report.note })}
            </p>
            <p className="text-muted">
              {copy('mod.case.snapshot', {
                handle: String(report.snapshot.handle ?? '-'),
                level: String(report.snapshot.public_level ?? '-'),
              })}
            </p>
          </li>
        ))}
      </ul>
      <h3 className="font-bold text-fg">{copy('mod.case.sanctions')}</h3>
      {detail.sanctions.length === 0 ? (
        <p className="text-sm text-muted">{copy('mod.case.noSanctions')}</p>
      ) : (
        <ul className="flex flex-col gap-1 text-sm text-fg">
          {detail.sanctions.map((sanction) => (
            <li key={`${sanction.kind}-${sanction.starts_at}`}>
              {copy('mod.case.sanction', {
                kind: sanction.kind,
                reason: reasonName(sanction.reason),
                date: formatDate(sanction.starts_at),
              })}
            </li>
          ))}
        </ul>
      )}
      <h3 className="font-bold text-fg">{copy('mod.case.audit')}</h3>
      {detail.audit.length === 0 ? (
        <p className="text-sm text-muted">{copy('mod.case.noAudit')}</p>
      ) : (
        <ul className="flex flex-col gap-1 text-sm text-fg">
          {detail.audit.map((row) => (
            <li key={`${row.action}-${row.created_at}`}>
              {copy('mod.case.auditRow', { action: row.action, date: formatDate(row.created_at) })}
            </li>
          ))}
        </ul>
      )}
      <ActionForm caseId={detail.case_id} run={run} onDone={onDone} />
    </section>
  )
}

function QueueView({
  queue,
  onOpen,
  onAppeal,
}: {
  readonly queue: Queue
  readonly onOpen: (caseId: string) => void
  readonly onAppeal: (appealId: string, overturn: boolean) => void
}) {
  return (
    <div className="flex flex-col gap-4">
      <section aria-labelledby="mod-queue-title" className="flex flex-col gap-2">
        <h2 id="mod-queue-title" className="text-xl font-bold text-fg">
          {copy('mod.queue.title')}
        </h2>
        {queue.cases.length === 0 ? (
          <p className="text-sm text-muted">{copy('mod.queue.empty')}</p>
        ) : (
          <ol className="flex flex-col gap-2">
            {queue.cases.map((item) => (
              <li
                key={item.case_id}
                data-mod-queue-case={item.case_id}
                className="flex flex-col gap-1 rounded-xl bg-raised p-3 text-sm text-fg"
              >
                <p className="font-bold">
                  {copy('mod.queue.case', {
                    handle: item.handle ?? item.case_id,
                    count: formatCount(item.reports),
                  })}
                </p>
                <p>{copy('mod.queue.priority', { priority: formatCount(item.priority) })}</p>
                <p>
                  {copy('mod.queue.reasons', { reasons: item.reasons.map(reasonName).join(', ') })}
                </p>
                <p>
                  {copy('mod.queue.reporters', {
                    count: formatCount(item.reporters),
                    trusted: formatCount(item.trusted_reporters),
                  })}
                </p>
                {item.brigade ? (
                  <p data-mod-brigade="" className="font-semibold text-danger">
                    {copy('mod.queue.brigade')}
                  </p>
                ) : null}
                {item.held ? (
                  <p className="text-taxi-ink">{copy('mod.queue.trustedHold')}</p>
                ) : null}
                <p className="text-muted">
                  {copy('mod.queue.oldest', { date: formatDate(item.oldest_at) })}
                </p>
                <p className="text-muted">
                  {copy('mod.queue.standing', { standing: item.standing })}
                </p>
                <button
                  type="button"
                  onClick={() => onOpen(item.case_id)}
                  className={`${BUTTON} self-start bg-taxi text-on-taxi`}
                >
                  {copy('mod.queue.open')}
                </button>
              </li>
            ))}
          </ol>
        )}
      </section>
      <section aria-labelledby="mod-appeals-title" className="flex flex-col gap-2">
        <h2 id="mod-appeals-title" className="text-xl font-bold text-fg">
          {copy('mod.appeals.title')}
        </h2>
        {queue.appeals.length === 0 ? (
          <p className="text-sm text-muted">{copy('mod.appeals.empty')}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {queue.appeals.map((appeal) => (
              <li
                key={appeal.appeal_id}
                className="flex flex-col gap-1 rounded-xl bg-raised p-3 text-sm text-fg"
              >
                <p className="font-bold">
                  {copy('mod.appeals.item', {
                    handle: appeal.handle ?? appeal.user_id,
                    kind: appeal.sanction_kind,
                    reason: reasonName(appeal.sanction_reason),
                  })}
                </p>
                <p>{copy('mod.appeals.body', { body: appeal.body })}</p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => onAppeal(appeal.appeal_id, false)}
                    className={`${BUTTON} bg-canvas text-fg`}
                  >
                    {copy('mod.appeals.uphold')}
                  </button>
                  <button
                    type="button"
                    onClick={() => onAppeal(appeal.appeal_id, true)}
                    className={`${BUTTON} bg-taxi text-on-taxi`}
                  >
                    {copy('mod.appeals.overturn')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

type Loaded =
  | { readonly state: 'loading' }
  | { readonly state: 'failed'; readonly text: string }
  | { readonly state: 'queue'; readonly queue: Queue }
  | { readonly state: 'case'; readonly detail: CaseDetail }

function Console({
  token,
  onSignOut,
}: {
  readonly token: () => Promise<string | null>
  readonly onSignOut: () => void
}) {
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' })
  const [status, setStatus] = useState<string | null>(null)
  const appealKeys = useRef(new Map<string, string>())

  const withToken = useCallback(
    async <T,>(call: (token: string) => Promise<ModResult<T>>): Promise<ModResult<T>> => {
      const current = await token()
      if (current === null) return { ok: false, status: 401, code: 'not_authenticated' }
      return call(current)
    },
    [token],
  )

  const showQueue = useCallback(async () => {
    setLoaded({ state: 'loading' })
    const result = await withToken(fetchQueue)
    setLoaded(
      result.ok
        ? { state: 'queue', queue: result.data }
        : { state: 'failed', text: failureText(result) },
    )
  }, [withToken])

  const openCase = useCallback(
    async (caseId: string, keepStatus = false) => {
      if (!keepStatus) setStatus(null)
      setLoaded({ state: 'loading' })
      const result = await withToken((current) => fetchCase(current, caseId))
      setLoaded(
        result.ok
          ? { state: 'case', detail: result.data }
          : { state: 'failed', text: failureText(result) },
      )
    },
    [withToken],
  )

  // A link to one case (`/mod?case=<player id>`, from an alert or a colleague) opens it;
  // otherwise the queue. Either way the state updates arrive asynchronously.
  useEffect(() => {
    const linked = new URLSearchParams(window.location.search).get('case')
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (linked !== null && CASE_ID.test(linked)) void openCase(linked)
    else void showQueue()
  }, [openCase, showQueue])

  const run = (body: Readonly<Record<string, unknown>>) =>
    withToken((current) => postAction(current, body))

  const resolveAppeal = async (appealId: string, overturn: boolean) => {
    const id = `${appealId}:${String(overturn)}`
    let key = appealKeys.current.get(id)
    if (key === undefined) {
      key = newActionKey()
      appealKeys.current.set(id, key)
    }
    const result = await run({
      action: 'resolve_appeal',
      caseId: appealId,
      idempotencyKey: key,
      overturn,
    })
    setStatus(
      result.ok
        ? copy('mod.action.done', {
            action: copy(overturn ? 'mod.appeals.overturn' : 'mod.appeals.uphold'),
          })
        : failureText(result),
    )
    if (result.ok) void showQueue()
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void showQueue()}
          className={`${BUTTON} bg-raised text-fg`}
        >
          {copy('mod.refresh')}
        </button>
        <button type="button" onClick={onSignOut} className={`${BUTTON} bg-raised text-fg`}>
          {copy('mod.signOut')}
        </button>
      </div>
      <p role="status" data-mod-status="" className="min-h-5 text-sm text-taxi-ink">
        {status}
      </p>
      {loaded.state === 'loading' ? (
        <p className="text-sm text-muted">{copy('mod.loading')}</p>
      ) : loaded.state === 'failed' ? (
        <div className="flex flex-col items-start gap-2">
          <p role="alert" data-mod-failed="" className="text-sm font-semibold text-danger">
            {loaded.text}
          </p>
          <button
            type="button"
            onClick={() => void showQueue()}
            className={`${BUTTON} bg-raised text-fg`}
          >
            {copy('mod.retry')}
          </button>
        </div>
      ) : loaded.state === 'queue' ? (
        <QueueView
          queue={loaded.queue}
          onOpen={(id) => void openCase(id)}
          onAppeal={(id, overturn) => void resolveAppeal(id, overturn)}
        />
      ) : (
        <CaseView
          detail={loaded.detail}
          onBack={() => void showQueue()}
          run={run}
          onDone={(text) => {
            setStatus(text)
            void openCase(loaded.detail.case_id, true)
          }}
        />
      )}
    </div>
  )
}

/**
 * The moderator console at /mod (S18b part 2): sign in with an emailed link, then the queue
 * (open cases by priority, with trusted-reporter and brigade flags, and pending appeals), a
 * case's reports with notes and snapshots, and the audited actions. Every check happens on the
 * server routes; this page only shows what they answer, including 409s when another moderator
 * got there first. Its session is its own (`cloutcity-mod-auth`), never the game's.
 */
export function ModConsole() {
  const [session, setSession] = useState<Session>({ state: 'loading' })

  useEffect(() => {
    let live = true
    void loadSession().then((next) => {
      if (live) setSession(next)
    })
    return () => {
      live = false
    }
  }, [])

  return (
    <main className="h-full overflow-y-auto overscroll-contain px-4 py-6">
      <div className="mx-auto flex max-w-2xl flex-col gap-4">
        <h1 className="text-3xl font-extrabold tracking-tight text-taxi-ink">
          {copy('mod.title')}
        </h1>
        {session.state === 'loading' ? (
          <p className="text-sm text-muted">{copy('mod.loading')}</p>
        ) : session.state === 'signed-out' ? (
          <SignIn />
        ) : (
          <Console
            token={session.token}
            onSignOut={() => {
              void signOut().then(() => setSession({ state: 'signed-out' }))
            }}
          />
        )}
      </div>
    </main>
  )
}
