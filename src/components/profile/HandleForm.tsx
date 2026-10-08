'use client'

import profileConfigJson from '@data/config/profile.json'
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react'
import { PANEL_BUTTON, PanelStatus } from '@/components/hud/PanelDialog'
import { copy } from '@/lib/copy'
import { fieldErrors } from '@/lib/forms/errors'
import {
  createHandleSchema,
  handleCheckError,
  handleServerError,
  handlesConfig,
  type HandleServerError,
  type MyProfile,
} from '@/lib/forms/handle'
import { formatCount, formatDate } from '@/lib/format'
import { normaliseHandleInput } from '@/lib/handles/normalise'
import { log } from '@/lib/log'
import type { ProfileApi } from '@/lib/supabase/profileApi'
// Copy namespaces this module renders (DEC-11: they load with this module's chunk).
import '@/lib/copy/ns/profile'

/** data/config/profile.json, validated by ProfileConfigSchema in src/lib/data/data.test.ts. */
const DEBOUNCE_MS = profileConfigJson.handleCheckDebounceMs

/** The live check's last answer, for the handle it was about. */
type Availability =
  | { readonly state: 'available'; readonly handle: string }
  | { readonly state: 'refused'; readonly handle: string; readonly error: HandleServerError }
  | { readonly state: 'unknown'; readonly handle: string }

/** The allowance line: a free first change, when the next one opens, or how many are left. */
function allowanceText(profile: MyProfile): string {
  if (profile.free_handle_change) return copy('profile.handle.freeChange')
  if (profile.next_handle_change_at !== null) {
    return copy('profile.handle.nextChange', { date: formatDate(profile.next_handle_change_at) })
  }
  return copy('profile.handle.changesLeft', { count: formatCount(profile.handle_changes_left) })
}

/**
 * The handle form (S18a; GR-1, GR-2, GR-6, GR-8): a native input whose live preview always shows
 * the exact handle that would be saved ("Your handle will be @claude_qa"), never a silent
 * rewrite. Errors come from the shared schema, recomputed on every change, and show together
 * after the first submit; the server's refusals (taken, not allowed, changed too recently, rate
 * limited) show under the field too. Once the preview passes the rules, a debounced
 * `check_handle` says whether it is free.
 */
export function HandleForm({
  api,
  profile,
  onSaved,
}: {
  readonly api: ProfileApi
  readonly profile: MyProfile
  readonly onSaved: (profile: MyProfile) => void
}) {
  const inputId = useId()
  const hintId = useId()
  const previewId = useId()
  const errorId = useId()
  const input = useRef<HTMLInputElement>(null)
  const [raw, setRaw] = useState('')
  const [attempted, setAttempted] = useState(false)
  const [serverError, setServerError] = useState<HandleServerError | null>(null)
  const [availability, setAvailability] = useState<Availability | null>(null)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<string | null>(null)

  const schema = useMemo(() => createHandleSchema(handlesConfig), [])
  const preview = normaliseHandleInput(raw)
  const errors = useMemo(() => fieldErrors(schema, { handle: preview }), [schema, preview])
  const valid = errors.handle === undefined
  const sameAsCurrent = valid && preview === profile.handle

  // Live availability, once the preview passes the rules: debounced, and only the answer for
  // the current preview counts. A failed check shows nothing; saving still gets the server's
  // real answer.
  const wantsCheck = valid && preview !== '' && !sameAsCurrent
  useEffect(() => {
    if (!wantsCheck) return
    let live = true
    const timer = window.setTimeout(() => {
      void api.checkHandle(preview).then((result) => {
        if (!live) return
        if (!result.ok) {
          setAvailability({ state: 'unknown', handle: preview })
          return
        }
        const error = handleCheckError(result.data, profile.next_handle_change_at)
        setAvailability(
          error === null
            ? { state: 'available', handle: preview }
            : { state: 'refused', handle: preview, error },
        )
      })
    }, DEBOUNCE_MS)
    return () => {
      live = false
      window.clearTimeout(timer)
    }
  }, [api, preview, wantsCheck, profile.next_handle_change_at])
  const answer = wantsCheck && availability?.handle === preview ? availability : null
  const checking = wantsCheck && answer === null

  // What sits under the field: the rule broken, else the server's refusal of this exact preview.
  const shownError: HandleServerError | null = (() => {
    if (attempted && errors.handle !== undefined) return { key: errors.handle }
    if (serverError !== null) return serverError
    if (attempted && sameAsCurrent) return handleServerError('current', null)
    if (answer?.state === 'refused') return answer.error
    return null
  })()

  const update = (value: string) => {
    setRaw(value)
    setServerError(null)
    setStatus(null)
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (saving) return
    setAttempted(true)
    setStatus(null)
    if (!valid || sameAsCurrent) {
      input.current?.focus()
      return
    }
    setSaving(true)
    const handle = preview
    const result = await api.setHandle(handle)
    setSaving(false)
    if (result.ok) {
      setRaw('')
      setAttempted(false)
      setServerError(null)
      setStatus(copy('profile.handle.saved', { handle: result.data.handle ?? handle }))
      onSaved(result.data)
      return
    }
    log.info('A handle change was refused', { code: result.code })
    setServerError(handleServerError(result.code, profile.next_handle_change_at))
    input.current?.focus()
  }

  const describedBy = [hintId, raw === '' ? null : previewId, shownError === null ? null : errorId]
    .filter((id) => id !== null)
    .join(' ')

  return (
    <section aria-labelledby={`${inputId}-title`} className="flex flex-col gap-2">
      <h3 id={`${inputId}-title`} className="font-bold text-fg">
        {copy('profile.handle.title')}
      </h3>
      {profile.handle_generated ? (
        <p className="text-sm text-muted">{copy('profile.handle.generated')}</p>
      ) : null}
      <p data-handle-allowance="" className="text-sm text-muted">
        {allowanceText(profile)}
      </p>
      <form noValidate onSubmit={onSubmit} className="flex flex-col gap-2">
        <label htmlFor={inputId} className="text-sm font-semibold text-fg">
          {copy('profile.handle.label')}
        </label>
        <input
          ref={input}
          id={inputId}
          name="handle"
          type="text"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          value={raw}
          onChange={(event) => update(event.target.value)}
          aria-describedby={describedBy}
          aria-invalid={shownError === null ? undefined : true}
          className="min-h-11 w-full rounded-xl border border-line bg-canvas px-3 text-base text-fg focus-visible:outline-2 focus-visible:outline-focus"
        />
        <p id={hintId} className="text-xs text-muted">
          {copy('profile.handle.hint', {
            min: formatCount(handlesConfig.minLength),
            max: formatCount(handlesConfig.maxLength),
          })}
        </p>
        {raw === '' ? null : (
          <div id={previewId} data-handle-preview={preview} className="text-sm">
            <p className="font-semibold text-taxi-ink">
              {copy('profile.handle.preview', { handle: preview })}
            </p>
            {preview === raw ? null : (
              <p className="text-muted">{copy('profile.handle.previewChanged')}</p>
            )}
          </div>
        )}
        {shownError === null ? null : (
          <p id={errorId} data-handle-error="" className="text-sm font-semibold text-danger">
            {copy(shownError.key, shownError.vars)}
          </p>
        )}
        <p role="status" className="min-h-5 text-sm text-muted">
          {checking
            ? copy('profile.handle.checking', { handle: preview })
            : answer?.state === 'available'
              ? copy('profile.handle.available', { handle: preview })
              : null}
        </p>
        <button
          type="submit"
          aria-disabled={saving ? true : undefined}
          className={`${PANEL_BUTTON} self-start bg-taxi text-on-taxi`}
        >
          {saving ? copy('profile.handle.saving') : copy('profile.handle.save')}
        </button>
      </form>
      <PanelStatus text={status} />
    </section>
  )
}
