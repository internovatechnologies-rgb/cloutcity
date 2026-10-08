'use client'

import { useEffect, useId, useRef, type ReactNode } from 'react'
import { useModalOpen } from '@/components/overlay/modalState'
import { useModalZone } from '@/components/overlay/useModalZone'
import { engineConfig } from '@/engine/config'
import { canAffordChoice, findEvent } from '@/engine/events'
import type { GameEvent } from '@/lib/data/schemas/content'
import { copy } from '@/lib/copy'
import { gameStore, useGameStore } from '@/state/store'
import { appliedEffects, effectsSummary, eventText } from './effectLabels'
// Copy namespaces this module renders (DEC-11: they load with this module's chunk).
import '@/lib/copy/ns/events'

/**
 * The event modal, in the overlay `sheet` zone. It shows the open event (its choices), then
 * what the chosen option did, until the player continues. Renders nothing when no event is
 * open, so the empty sheet zone lets touches through to the map. Loaded on first use by
 * EventSheetHost (DEC-11: feature UI stays out of the shell).
 */
export function EventSheet() {
  const activeId = useGameStore((state) => state.events.active)
  const outcome = useGameStore((state) => state.eventOutcome)

  const event = findEvent(outcome?.eventId ?? activeId ?? '', engineConfig)
  if (event === undefined) return null
  return <EventDialog key={event.id} event={event} />
}

function EventDialog({ event }: { readonly event: GameEvent }) {
  const outcome = useGameStore((state) => state.eventOutcome)
  const cash = useGameStore((state) => state.player.cash)
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const bodyId = useId()
  useModalZone(ref)

  const resolved = outcome?.eventId === event.id ? outcome : null
  const view = resolved === null ? 'choices' : 'outcome'
  const landed =
    resolved === null ? '' : effectsSummary(appliedEffects(resolved.effects, resolved.cloutApplied))

  // Listened to directly: jsx-a11y does not allow key handlers on a non-interactive role.
  useEffect(() => {
    const dialog = ref.current
    if (dialog === null) return
    const onKeyDown = (keyEvent: KeyboardEvent) => moveFocus(keyEvent, dialog)
    dialog.addEventListener('keydown', onKeyDown)
    return () => dialog.removeEventListener('keydown', onKeyDown)
  }, [])

  // Focus the first button of each view: the choices on open, Continue after a choice. While a
  // modal (the welcome card, or its loading state at boot) holds the page inert, focus cannot
  // land here; it does once the modal closes.
  const blocked = useModalOpen()
  useEffect(() => {
    if (blocked) return
    ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [view, blocked])

  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      data-event={event.id}
      data-cc-feature="cc-feature:event-sheet"
      data-cc-notice="event"
      className="m-2 flex flex-col gap-2 rounded-2xl border border-line glass p-3 shadow-lg"
    >
      <h2 id={titleId} className="text-base leading-tight font-extrabold text-fg">
        {eventText(event.titleKey)}
      </h2>
      {resolved === null ? (
        <>
          <p id={bodyId} className="text-sm text-fg">
            {eventText(event.bodyKey)}
          </p>
          <ul className="flex flex-col gap-1.5">
            {event.choices.map((choice) => {
              const affordable = canAffordChoice(choice, cash)
              const effects = effectsSummary(choice.effects)
              return (
                <li key={choice.id}>
                  <ChoiceButton
                    choiceId={choice.id}
                    disabled={!affordable}
                    onChoose={() => gameStore.getState().chooseEventOption(choice.id)}
                  >
                    <span className="block text-sm font-bold">{eventText(choice.labelKey)}</span>
                    {effects === '' && affordable ? null : (
                      <span className="block text-xs text-muted">
                        {affordable ? effects : copy('events.ui.cantAfford')}
                      </span>
                    )}
                  </ChoiceButton>
                </li>
              )
            })}
          </ul>
        </>
      ) : (
        <>
          <p id={bodyId} className="text-sm text-fg">
            {eventText(resolved.resultKey)}
            {landed === '' ? null : <span className="mt-1 block text-xs text-muted">{landed}</span>}
          </p>
          <ChoiceButton
            choiceId="continue"
            onChoose={() => gameStore.getState().dismissEventOutcome()}
          >
            <span className="block text-sm font-bold">{copy('events.ui.continue')}</span>
          </ChoiceButton>
        </>
      )}
    </div>
  )
}

function ChoiceButton({
  choiceId,
  disabled = false,
  onChoose,
  children,
}: {
  readonly choiceId: string
  readonly disabled?: boolean
  readonly onChoose: () => void
  readonly children: ReactNode
}) {
  return (
    <button
      type="button"
      data-choice={choiceId}
      disabled={disabled}
      onClick={onChoose}
      className="min-h-11 w-full rounded-xl bg-raised px-3 py-1.5 text-left text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus enabled:active:scale-[0.98] disabled:opacity-60"
    >
      {children}
    </button>
  )
}

/**
 * Keyboard inside the dialog: Tab and Shift+Tab cycle through its buttons and never leave it
 * (focus trap); the arrow keys move between them too. Enter and Space are the buttons' own.
 */
function moveFocus(keyEvent: KeyboardEvent, dialog: HTMLDivElement) {
  const step =
    keyEvent.key === 'Tab'
      ? keyEvent.shiftKey
        ? -1
        : 1
      : keyEvent.key === 'ArrowDown'
        ? 1
        : keyEvent.key === 'ArrowUp'
          ? -1
          : 0
  if (step === 0) return
  const buttons = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
  if (buttons.length === 0) return
  keyEvent.preventDefault()
  const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
  const next = current === -1 ? 0 : (current + step + buttons.length) % buttons.length
  buttons[next]?.focus()
}
