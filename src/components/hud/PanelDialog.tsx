'use client'

import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react'
import { HUD_MORE_SELECTOR, focusFirstVisible } from '@/components/overlay/focusVisible'
import { copy } from '@/lib/copy'
// Copy namespaces this module renders (DEC-11: they load with this module's chunk).
import '@/lib/copy/ns/place'

export const PANEL_BUTTON =
  'min-h-11 min-w-11 rounded-xl px-3 py-2 font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus'

/** Short screens (the sheet zone is tiny): a tighter frame for a scrolling panel. */
const SHORT_SCREEN_FRAME =
  '[@media(max-height:480px)]:m-1 [@media(max-height:480px)]:max-h-[calc(100%-0.5rem)] [@media(max-height:480px)]:gap-1 [@media(max-height:480px)]:p-2'
const SHORT_SCREEN_BODY = '[@media(max-height:480px)]:gap-1'

/**
 * The frame of a HUD panel in the sheet zone (S10a): a non-modal dialog like the place sheet,
 * so the map and HUD stay usable. Focus moves to the title on open and back to its HUD button
 * (or the More button, where that button is hidden) on close; Escape and the Close button close it.
 */
export function PanelDialog({
  title,
  panel,
  feature,
  onClose,
  scrollBody = false,
  children,
}: {
  readonly title: string
  readonly panel: string
  /** The panel's lazy-feature marker (`cc-feature:<id>`, DEC-11), written literally by the caller. */
  readonly feature: string
  readonly onClose: () => void
  /**
   * A long panel (the goals list): the dialog fits its zone and its body scrolls under the
   * title and Close button, which stay in view. On a short screen (a phone held sideways, where
   * the sheet zone is about 90 px since S04a reserved room for the map) the frame's margin,
   * padding and gaps tighten, so the body keeps a strip that scrolls instead of none.
   */
  readonly scrollBody?: boolean
  readonly children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const scrolls = useScrolls(bodyRef, scrollBody)

  // On close, focus goes back to the panel's own HUD button rather than whatever was focused
  // on open: switching panels would otherwise hand it to the other panel's button.
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('h2')?.focus()
    // On phones the panel's own button may be hidden behind More (S05): then More takes focus.
    return () => {
      focusFirstVisible([`[data-hud-panel="${CSS.escape(panel)}"]`, HUD_MORE_SELECTOR, 'main'])
    }
  }, [panel])

  // Listened to directly: jsx-a11y does not allow key handlers on a non-interactive role.
  useEffect(() => {
    const dialog = ref.current
    if (dialog === null) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    dialog.addEventListener('keydown', onKeyDown)
    return () => dialog.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div
      ref={ref}
      role="dialog"
      aria-labelledby={titleId}
      data-hud-panel-dialog={panel}
      data-cc-feature={feature}
      className={`m-2 flex flex-col gap-2 rounded-2xl border border-line glass p-3 shadow-lg ${
        scrollBody ? `max-h-[calc(100%-1rem)] min-h-0 ${SHORT_SCREEN_FRAME}` : ''
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <h2
          id={titleId}
          tabIndex={-1}
          className="text-base leading-tight font-extrabold text-fg focus:outline-none"
        >
          {title}
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={copy('place.sheet.closeLabel', { place: title })}
          className={`${PANEL_BUTTON} shrink-0 bg-raised text-center text-fg`}
        >
          {copy('place.sheet.close')}
        </button>
      </div>
      {scrollBody ? (
        <div
          ref={bodyRef}
          // A body that scrolls is a named, focusable region, so a keyboard can scroll it
          // (axe scrollable-region-focusable, UI-6); one that fits stays out of the tab order.
          {...(scrolls ? { tabIndex: 0, role: 'region', 'aria-labelledby': titleId } : {})}
          className={`flex min-h-0 flex-col gap-2 overflow-y-auto overscroll-contain rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus ${SHORT_SCREEN_BODY}`}
        >
          {children}
        </div>
      ) : (
        children
      )}
    </div>
  )
}

/** Whether the element's content is taller than its box (it scrolls), kept current on resize. */
function useScrolls(ref: RefObject<HTMLElement | null>, enabled: boolean): boolean {
  const [scrolls, setScrolls] = useState(false)
  useEffect(() => {
    const element = ref.current
    if (!enabled || element === null) return
    const measure = () => setScrolls(element.scrollHeight > element.clientHeight)
    measure()
    if (typeof ResizeObserver !== 'function') return
    // The box changes with the zone; the content with what the panel lists.
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    for (const child of element.children) observer.observe(child)
    const mutations = new MutationObserver(() => {
      for (const child of element.children) observer.observe(child)
      measure()
    })
    mutations.observe(element, { childList: true })
    return () => {
      observer.disconnect()
      mutations.disconnect()
    }
  }, [ref, enabled])
  return enabled && scrolls
}

/** The panel's live result line: what the last action did, in voice. */
export function PanelStatus({ text }: { readonly text: string | null }) {
  return (
    <p role="status" data-panel-status="" className="min-h-5 text-sm font-semibold text-taxi-ink">
      {text}
    </p>
  )
}
