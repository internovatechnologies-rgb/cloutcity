'use client'

import { useEffect, useRef, useState } from 'react'
// Read directly (validated by LayoutConfigSchema in src/lib/data/data.test.ts): the classic-zod
// loader in src/lib/data/config.ts must stay out of client chunks.
import layoutJson from '@data/config/layout.json'
import { lazyIsland } from '@/components/overlay/lazyIsland'
import type { LevelUp } from '@/engine/clout'
import type { RentEvent } from '@/engine/rent'
import { copy } from '@/lib/copy'
import { levelUpCloseLabel, levelUpMessage, levelUpTitle, levelUpUnlocked } from '@/lib/levelUpCopy'
import { gameStore, useGameStore } from '@/state/store'
// Copy namespaces this module renders (DEC-11: they load with this module's chunk).
import '@/lib/copy/ns/clout'

const RentToast = lazyIsland(() => import('./RentToast').then((module) => module.RentToast), {
  zone: 'toast',
  labelKey: 'loading.rentNotice',
  quiet: true,
})

/** Rent events that get their own toast: a miss and an eviction (a payment does not). */
function isRentAlarm(event: RentEvent | null): event is RentEvent {
  return event !== null && (event.kind === 'missed' || event.kind === 'evicted')
}

/**
 * The toast zone's host (S13): the level-up toast, else one rent notice when rent was just
 * missed or the player evicted, whether that happened during an action or on the passive clock.
 * One toast at a time; a rent notice shows once per rent event (its Close or timer retires it),
 * and a level-up arriving meanwhile takes the zone first. The rent toast loads lazily, the first
 * time rent is missed, so the boot island gains only this check.
 */
export function LevelUpToast() {
  const levelUp = useGameStore((state) => state.lastLevelUp)
  const rent = useGameStore((state) => state.lastRentEvent)
  const [retired, setRetired] = useState<RentEvent | null>(null)
  // Keyed per level-up, so a new one starts with a fresh timer and no stale hover or focus.
  if (levelUp !== null) return <Toast key={`${levelUp.to}@${levelUp.at}`} levelUp={levelUp} />
  if (!isRentAlarm(rent) || rent === retired) return null
  return (
    <RentToast key={`${rent.kind}@${rent.day}`} event={rent} onClose={() => setRetired(rent)} />
  )
}

/**
 * A toast's timer (S13): `onTimeout` runs after `overlay.toastMs`, paused while the pointer is
 * over the toast or focus is inside it (WCAG 2.2.1), restarting in full when both leave. The
 * returned ref goes on the toast; `paused` is for its `data-paused`.
 */
export function useToastTimer(onTimeout: () => void) {
  const ref = useRef<HTMLDivElement>(null)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const paused = hovered || focused
  const timeout = useRef(onTimeout)
  useEffect(() => {
    timeout.current = onTimeout
  })

  // Listened to directly: jsx-a11y does not allow pointer or focus handlers on a static div.
  useEffect(() => {
    const toast = ref.current
    if (toast === null) return
    const enter = () => setHovered(true)
    const leave = () => setHovered(false)
    const focusIn = () => setFocused(true)
    const focusOut = (event: FocusEvent) => {
      if (!(event.relatedTarget instanceof Node && toast.contains(event.relatedTarget))) {
        setFocused(false)
      }
    }
    toast.addEventListener('pointerenter', enter)
    toast.addEventListener('pointerleave', leave)
    toast.addEventListener('focusin', focusIn)
    toast.addEventListener('focusout', focusOut)
    return () => {
      toast.removeEventListener('pointerenter', enter)
      toast.removeEventListener('pointerleave', leave)
      toast.removeEventListener('focusin', focusIn)
      toast.removeEventListener('focusout', focusOut)
    }
  }, [])

  useEffect(() => {
    if (paused) return
    const timer = window.setTimeout(() => timeout.current(), layoutJson.overlay.toastMs)
    return () => window.clearTimeout(timer)
  }, [paused])

  return { ref, paused }
}

/**
 * The level-up toast (S13), in the overlay toast zone, whose live region announces it. It
 * never takes focus (play carries on under it), closes itself after `overlay.toastMs`, and has
 * a Close button, with the pause rules of {@link useToastTimer}. Its one pop animation is off
 * under reduced motion (globals.css).
 */
function Toast({ levelUp }: { readonly levelUp: LevelUp }) {
  const { ref, paused } = useToastTimer(() => gameStore.getState().dismissLevelUp())

  const unlocked = levelUpUnlocked(levelUp)
  return (
    <div
      ref={ref}
      data-level-up={levelUp.to}
      data-cc-feature="cc-feature:level-up"
      data-cc-notice="level-up"
      data-paused={paused ? '' : undefined}
      className="level-up-pop mx-2 flex items-center gap-2 rounded-2xl border border-taxi glass px-3 py-1 shadow-lg"
    >
      {/* Title and message share one flow so the longest level-up (every unlock on the way to
          Icon) still fits the 72 px toast zone at 390 px (UX-1). */}
      <div className="min-w-0 flex-1 text-xs leading-tight">
        <p>
          <strong className="font-extrabold text-taxi-ink">{levelUpTitle(levelUp)}</strong>{' '}
          <span className="text-fg">{levelUpMessage(levelUp)}</span>
        </p>
        {unlocked === null ? null : <p className="text-taxi-ink">{unlocked}</p>}
      </div>
      <button
        type="button"
        onClick={() => gameStore.getState().dismissLevelUp()}
        aria-label={levelUpCloseLabel(levelUp)}
        className="min-h-11 min-w-11 shrink-0 rounded-xl bg-raised px-3 text-sm font-semibold text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        {copy('clout.levelUp.close')}
      </button>
    </div>
  )
}
