'use client'

import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from 'react'
import layoutJson from '@data/config/layout.json'
import type { LayoutConfig } from '@/lib/data/schemas/config'

// Read directly rather than through src/lib/data/config.ts (or ./layers, which uses it), so
// browser code stays off classic zod (src/lib/client-imports.test.ts). LayoutConfigSchema
// validates the file in src/lib/data/data.test.ts.
const layout: LayoutConfig = layoutJson

/**
 * A button's `onKeyDown`: a held Enter or Space auto-repeats keydown, and each repeated Enter
 * would activate the focused button again. Cancelling the repeats means a held key activates
 * exactly once.
 */
export function ignoreKeyRepeat(event: KeyboardEvent<HTMLElement>): void {
  if (event.repeat && (event.key === 'Enter' || event.key === ' ')) event.preventDefault()
}

export interface ActionGuard {
  /**
   * Wraps a button's click: runs `action` only when the guard lets the activation through.
   * `target` names what the button acts on (an item id), so a repeat on the same thing is told
   * apart from a tap that reached a different row.
   */
  readonly guard: (event: MouseEvent<HTMLElement>, target: string, action: () => void) => void
  /** Each guarded button's `onKeyDown`: {@link ignoreKeyRepeat}. */
  readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void
  /**
   * Each guarded button's `onPointerDown`: records the pointer type of the press, since a click
   * carries no reliable pointer type of its own (Safari's is a plain MouseEvent).
   */
  readonly onPointerDown: (event: PointerEvent<HTMLElement>) => void
  /** True while the pointer cooldown runs; put it on the action list as `aria-busy`. */
  readonly coolingDown: boolean
}

interface LastTap {
  readonly target: string
  readonly rect: DOMRect
  /**
   * End of the cooldown: `actionCooldownMs` after the action ran, on the clock that
   * `event.timeStamp` and `performance.now()` share.
   */
  readonly until: number
}

const inside = (rect: DOMRect, x: number, y: number) =>
  x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom

/**
 * Guards a panel's action buttons (S10a) against taps that were not meant for the action now
 * under them. An action can swap its button in place (Wear becomes Take off) or remove its row
 * (the next row's button slides under the finger), so:
 * - a key held down activates once;
 * - the second click of a mouse double click (`detail > 1`) is ignored (a touch tap's count
 *   spans more than the cooldown, so touch relies on the cooldown);
 * - while the last action settles (until the frame after it commits, or the cooldown's end if
 *   that comes first), every activation is ignored;
 * - for `layout.json overlay.actionCooldownMs` after an action ran, a pointer activation whose
 *   press (pointerdown) came in that time and lands inside the rect of the button just tapped is
 *   ignored when:
 *   - it is a touch or pen tap (from its `onPointerDown`), whatever the target: on a slow phone the
 *     two taps of a double tap arrive frames apart as two `detail === 1` clicks, and the second
 *     would hit the button that replaced the first (Wear → Take off) or the row that slid in
 *     (UX-6);
 *   - it is a mouse click on a different target (the drifting second click of a double click).
 *     A mouse click again on the same target (selling a second copy from a stack) still acts.
 *   A tap elsewhere always acts, and keyboard activations (`detail === 0`) are never delayed.
 * Buttons stay enabled throughout, so focus is never dropped.
 */
export function useActionGuard(): ActionGuard {
  const cooldownMs = layout.overlay.actionCooldownMs
  const busy = useRef(false)
  const last = useRef<LastTap | null>(null)
  const [runs, setRuns] = useState(0)
  const press = useRef<{ readonly type: string; readonly at: number } | null>(null)
  const [coolingDown, setCoolingDown] = useState(false)

  // Released on the frame after the action's state change commits (the effect runs after it).
  useEffect(() => {
    if (runs === 0) return
    const frame = requestAnimationFrame(() => {
      busy.current = false
    })
    return () => cancelAnimationFrame(frame)
  }, [runs])

  // Restarts with every action, so the list stays busy until the last cooldown ends. The settle
  // flag is released here too: on a starved main thread the next frame can come later than the
  // cooldown, and a deliberate tap after it must still act.
  useEffect(() => {
    if (runs === 0) return
    const timer = setTimeout(() => {
      busy.current = false
      setCoolingDown(false)
    }, cooldownMs)
    return () => clearTimeout(timer)
  }, [runs, cooldownMs])

  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    press.current = { type: event.pointerType, at: event.timeStamp }
  }

  const guard = (event: MouseEvent<HTMLElement>, target: string, action: () => void) => {
    if (busy.current) return
    const pointer = event.detail > 0
    const previous = last.current
    // When the finger or button went down, on the input-event clock. A click synthesized from a
    // touch tap can be stamped late on a busy phone, but its pointerdown never is.
    const at = pointer && press.current !== null ? press.current.at : event.timeStamp
    // Touch and pen taps can arrive slowly and twice on one spot (UX-6); a mouse click cannot.
    const touchLike = pointer && (press.current?.type === 'touch' || press.current?.type === 'pen')
    // A mouse double click's second click is never meant. A touch tap's `detail` counts taps
    // over a window longer than the cooldown, so a deliberate tap can carry 2: touch relies on
    // the cooldown below instead.
    if (event.detail > 1 && !touchLike) return
    if (
      pointer &&
      previous !== null &&
      // The press's own timestamp, not this handler's time: on a busy phone the handlers of two
      // quick taps can run late and far apart, though the second finger came down at once.
      at < previous.until &&
      (touchLike || previous.target !== target) &&
      inside(previous.rect, event.clientX, event.clientY)
    ) {
      return
    }
    // The cooldown runs from when the action ran (when what is under the finger changed), not
    // from the press, which on a busy phone can be long before.
    const ranAt = performance.now()
    busy.current = true
    const rect = event.currentTarget.getBoundingClientRect()
    try {
      action()
    } catch (error) {
      busy.current = false
      throw error
    }
    last.current = { target, rect, until: ranAt + cooldownMs }
    setCoolingDown(true)
    setRuns((count) => count + 1)
  }

  return { guard, onKeyDown: ignoreKeyRepeat, onPointerDown, coolingDown }
}
