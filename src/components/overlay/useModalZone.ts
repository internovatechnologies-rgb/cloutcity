'use client'

import { useEffect, type RefObject } from 'react'

/**
 * Makes the overlay zone holding `ref` modal (UX-1): while mounted, the scene and every other
 * zone are `inert` (no pointer, focus or screen-reader access), so a dialog in the sheet zone
 * really is the only thing the player can use. It stays inside its own zone, so nothing is
 * drawn over the HUD or tab bar. On unmount, focus returns to where it was.
 */
export function useModalZone(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const node = ref.current
    const zone = node?.closest('[data-overlay-zone]')
    const overlayRoot = zone?.parentElement
    const shell = overlayRoot?.parentElement
    if (!node || !overlayRoot || !shell) return

    const siblings = [...Array.from(overlayRoot.children), ...Array.from(shell.children)]
    const others = siblings.filter(
      (element): element is HTMLElement =>
        element instanceof HTMLElement && !element.contains(node),
    )
    const wasInert = new Map(others.map((element) => [element, element.inert]))
    for (const element of others) element.inert = true
    const previous = document.activeElement

    return () => {
      for (const [element, inert] of wasInert) element.inert = inert
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [ref])
}
