'use client'

import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react'
import { SHELL_INTERACTIVE_MARK, perfMark } from '@/lib/perfMarks'
import { useModalHold, useModalOpen } from './modalState'

/**
 * The scene and every overlay zone. While a modal is open it is inert (no focus, clicks or
 * screen-reader access) and dimmed, but still mounted: the map keeps loading behind the modal.
 * When the last modal closes and focus went with it, focus moves to the scene's <main> so
 * keyboard and screen-reader users are not left on a removed element. Focus that something else
 * has already taken (a dialog restored behind the welcome island's loading card) stays put.
 * With a modal slot it is inert from the first server-rendered byte until that slot's island
 * has decided, so nothing behind the 18+ gate is reachable before hydration either.
 *
 * The dimming is a scrim (a translucent night layer over everything, PERF-2) rather than
 * opacity on the whole group: group opacity makes the browser composite the scene, the WebGL
 * canvas included, into an offscreen layer on every frame. The scrim's 60 % night over the
 * content looks the same as the content at 40 % opacity over the night page background.
 *
 * The release of the boot hold is the moment the shell is interactive (`cc:shell-interactive`,
 * timed by `npm run e2e:perf`).
 */
export function OverlayBackground({
  children,
  scrimZIndex,
  holdForModal = false,
}: {
  readonly children: ReactNode
  /** Stacking order of the scrim: above every zone inside the background (layers.ts). */
  readonly scrimZIndex: number
  /** The page has a modal slot: stay inert until its island has decided (modalState.ts). */
  readonly holdForModal?: boolean
}) {
  const held = useModalHold(holdForModal)
  const modalOpen = useModalOpen() || held
  const root = useRef<HTMLDivElement>(null)
  const wasOpen = useRef(false)

  useEffect(() => {
    if (!held) perfMark(SHELL_INTERACTIVE_MARK)
  }, [held])

  useEffect(() => {
    // Runs after the commit that removed `inert`, so <main> can take focus.
    const active = document.activeElement
    const focusLost = active === null || active === document.body
    if (wasOpen.current && !modalOpen && focusLost) root.current?.querySelector('main')?.focus()
    wasOpen.current = modalOpen
  }, [modalOpen])

  return (
    <div
      ref={root}
      data-overlay-background=""
      inert={modalOpen}
      style={{ '--overlay-scrim-z': scrimZIndex } as CSSProperties}
      className="absolute inset-0 isolate after:pointer-events-none after:absolute after:inset-0 after:z-(--overlay-scrim-z) after:bg-canvas/60 after:opacity-0 inert:after:opacity-100 motion-safe:after:transition-opacity"
    >
      {children}
    </div>
  )
}
