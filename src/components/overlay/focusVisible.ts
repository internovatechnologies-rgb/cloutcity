/**
 * Moves focus to the first element, in selector order, that is rendered and visible. The HUD
 * shows different controls at different widths (S05: Inventory and Rent on wide screens, the
 * More button on phones), so a panel or sheet closing hands focus back to whichever of its
 * openers the player can see, instead of to a hidden one (which would drop focus to the body).
 * Returns false when nothing matched.
 */
export function focusFirstVisible(selectors: readonly string[]): boolean {
  for (const selector of selectors) {
    for (const element of document.querySelectorAll<HTMLElement>(selector)) {
      // A display:none element (or one inside one) has no layout boxes.
      if (element.getClientRects().length === 0) continue
      element.focus()
      return true
    }
  }
  return false
}

/** The HUD's More button: the opener of last resort for every HUD panel on narrow screens. */
export const HUD_MORE_SELECTOR = '[data-hud-panel="more"]'
