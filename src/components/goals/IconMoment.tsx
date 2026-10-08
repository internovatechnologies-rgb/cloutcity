'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { useModalPresence } from '@/components/overlay/modalState'
import { trapTab } from '@/components/overlay/trapTab'
import { engineConfig } from '@/engine/config'
import { claimableCount } from '@/engine/goals'
import { prestigeBadge } from '@/engine/grants'
import { copy } from '@/lib/copy'
import { cloutLevelName } from '@/lib/economyCopy'
import { formatCount } from '@/lib/format'
import { badgeName, prestigePartName } from '@/lib/goalsCopy'
import { log } from '@/lib/log'
import { shareMoment, type ShareOutcome } from '@/lib/share/shareMoment'
import { closePrestigeConfirm } from '@/state/iconMoment'
import { gameStore, useGameStore } from '@/state/store'
// Copy namespaces this module renders (DEC-11: they load with this module's chunk).
import '@/lib/copy/ns/goals'
import '@/lib/copy/ns/share'

const BUTTON =
  'min-h-11 min-w-11 rounded-xl px-4 py-2 font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus'

/**
 * Where focus goes when the moment closes: the Goals panel's Prestige entry (when the confirm
 * was opened from there and it is still shown), the HUD's Goals button, else the map.
 */
function returnFocus() {
  const target =
    document.querySelector<HTMLElement>('[data-goals-prestige]') ??
    document.querySelector<HTMLElement>('[data-hud-panel="goals"]') ??
    document.querySelector<HTMLElement>('main')
  target?.focus()
}

/**
 * The Icon moment (S15): the victory screen shown once a run reaches the victory goal, over
 * everything (a modal; the page behind is inert). It offers Share (src/lib/share/shareMoment.ts),
 * Prestige (a second step that lists, from config, what starts over and what is kept, and names
 * the effect on its button) and Keep playing, which closes it for the rest of the run. Escape
 * keeps playing (or steps back from the confirm). Focus starts on the title and stays inside.
 * The celebration is CSS only and off under reduced motion. Loaded lazily by IconMomentMount
 * (DEC-11) only while the moment is pending, or with `confirmOnly` when the Goals panel's
 * Prestige entry opens the confirm by itself (backing out then closes it, back to Goals).
 */
export function IconMoment({ confirmOnly = false }: { readonly confirmOnly?: boolean }) {
  useModalPresence(true)
  const dialog = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const bodyId = useId()
  const [step, setStep] = useState<'moment' | 'confirm'>(confirmOnly ? 'confirm' : 'moment')
  // Opened from the Goals panel, the confirm has no moment to step back to: backing out closes.
  const back = () => (confirmOnly ? closePrestigeConfirm() : setStep('moment'))
  const [shared, setShared] = useState<ShareOutcome | null>(null)
  const [refused, setRefused] = useState(false)
  const run = useGameStore((state) => state.goals.run)
  // Rewards reached and not claimed: prestige starts the goals over, so they would be lost.
  // Grants are always the player's explicit claim, never automatic, so the confirm warns.
  const unclaimed = useGameStore((state) => claimableCount(state, engineConfig))

  useEffect(() => {
    dialog.current?.querySelector<HTMLElement>('h2')?.focus()
  }, [step])

  // On close, after the page behind stops being inert (the next frame): the Goals button.
  useEffect(
    () => () => {
      requestAnimationFrame(returnFocus)
    },
    [],
  )

  useEffect(() => {
    const element = dialog.current
    if (element === null) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        if (step === 'confirm') back()
        else gameStore.getState().acknowledgeIconMoment()
        return
      }
      trapTab(element, event)
    }
    element.addEventListener('keydown', onKeyDown)
    return () => element.removeEventListener('keydown', onKeyDown)
  })

  const share = () => {
    const text = `${copy('share.icon.text')} ${copy('share.footer')}`
    void shareMoment(text, window.location.origin).then(setShared)
  }

  const confirmPrestige = () => {
    const result = gameStore.getState().startPrestige()
    if (!result.ok) {
      log.info('Prestige was refused', { code: result.error.code })
      setRefused(true)
      return
    }
    closePrestigeConfirm()
  }

  const startLevel = cloutLevelName(engineConfig.clout.levels[0]?.id ?? '')
  const badge = badgeName(prestigeBadge(run, engineConfig))

  return (
    <div
      ref={dialog}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      data-icon-moment={step}
      data-cc-feature="cc-feature:icon-moment"
      data-cc-notice="icon"
      className="pointer-events-auto relative max-h-full w-full max-w-[var(--overlay-sheet-max-w)] self-center overflow-y-auto overscroll-contain rounded-3xl border border-taxi glass p-5 shadow-2xl"
    >
      <div aria-hidden="true" className="icon-moment-burst pointer-events-none absolute inset-0" />
      {step === 'moment' ? (
        <div className="relative flex flex-col gap-3">
          <h2
            id={titleId}
            tabIndex={-1}
            className="text-2xl font-extrabold text-fg focus:outline-none"
          >
            {copy('goals.icon.title')}
          </h2>
          <p id={bodyId} className="text-base text-fg">
            {copy('goals.icon.body')}
          </p>
          <p role="status" className="min-h-5 text-sm font-semibold text-taxi-ink">
            {shared === null || shared.kind === 'cancelled'
              ? null
              : shared.kind === 'shared'
                ? copy('goals.icon.shared')
                : shared.kind === 'copied'
                  ? copy('goals.icon.copied')
                  : copy('goals.icon.copyThis')}
          </p>
          {shared?.kind === 'shown' ? (
            <p data-share-text="" className="rounded-xl bg-canvas p-2 text-sm text-fg select-all">
              {shared.text}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={share} className={`${BUTTON} bg-taxi text-on-taxi`}>
              {copy('goals.icon.share')}
            </button>
            <button
              type="button"
              onClick={() => setStep('confirm')}
              className={`${BUTTON} bg-taxi text-on-taxi`}
            >
              {copy('goals.icon.prestige')}
            </button>
            <button
              type="button"
              onClick={() => gameStore.getState().acknowledgeIconMoment()}
              className={`${BUTTON} bg-raised text-fg`}
            >
              {copy('goals.icon.keepPlaying')}
            </button>
          </div>
        </div>
      ) : (
        <div className="relative flex flex-col gap-3">
          <h2
            id={titleId}
            tabIndex={-1}
            className="text-2xl font-extrabold text-fg focus:outline-none"
          >
            {copy('goals.icon.confirm.title')}
          </h2>
          <div id={bodyId} className="flex flex-col gap-2 text-sm text-fg">
            <p>{copy('goals.icon.confirm.body')}</p>
            <p className="font-semibold text-taxi-ink">
              {copy('goals.icon.confirm.badge', { badge })}
            </p>
            {unclaimed === 0 ? null : (
              <p data-prestige-unclaimed={unclaimed} className="font-semibold text-taxi-ink">
                {copy(
                  unclaimed === 1
                    ? 'goals.icon.confirm.unclaimedOne'
                    : 'goals.icon.confirm.unclaimed',
                  { count: formatCount(unclaimed) },
                )}
              </p>
            )}
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <section aria-label={copy('goals.icon.confirm.resets')}>
              <h3 className="text-xs font-bold text-muted uppercase">
                {copy('goals.icon.confirm.resets')}
              </h3>
              <ul data-prestige-resets="" className="list-inside list-disc text-sm text-fg">
                {engineConfig.prestige.resets.map((part) => (
                  <li key={part}>{prestigePartName(part)}</li>
                ))}
              </ul>
            </section>
            <section aria-label={copy('goals.icon.confirm.keeps')}>
              <h3 className="text-xs font-bold text-muted uppercase">
                {copy('goals.icon.confirm.keeps')}
              </h3>
              <ul data-prestige-keeps="" className="list-inside list-disc text-sm text-fg">
                {engineConfig.prestige.keeps.map((part) => (
                  <li key={part}>{prestigePartName(part)}</li>
                ))}
              </ul>
            </section>
          </div>
          <p role="status" className="min-h-5 text-sm font-semibold text-taxi-ink">
            {refused ? copy('goals.icon.confirm.refused') : null}
          </p>
          {/* Pinned to the bottom of the scrolling dialog, "Not yet" first, so the way out is
              always on screen above the tab bar at 390 x 844, however long the lists run. */}
          <div
            data-prestige-actions=""
            className="sticky -bottom-5 -mx-5 -mb-5 flex flex-wrap gap-2 rounded-b-3xl glass px-5 pt-2 pb-5"
          >
            <button type="button" onClick={back} className={`${BUTTON} bg-raised text-fg`}>
              {copy('goals.icon.confirm.back')}
            </button>
            <button
              type="button"
              onClick={confirmPrestige}
              className={`${BUTTON} flex-1 bg-taxi text-on-taxi`}
            >
              {copy('goals.icon.confirm.go', { level: startLevel })}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
