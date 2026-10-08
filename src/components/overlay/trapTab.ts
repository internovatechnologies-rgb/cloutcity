const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Keeps Tab and Shift+Tab inside a modal dialog (the welcome card, the Icon moment). The rest of
 * the page is inert, but without this focus would leave for the browser's own UI after the last
 * control.
 */
export function trapTab(dialog: HTMLElement, event: KeyboardEvent): void {
  if (event.key !== 'Tab') return
  const focusables = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE))
  const first = focusables[0]
  const last = focusables.at(-1)
  if (first === undefined || last === undefined) {
    event.preventDefault()
    return
  }
  const active = document.activeElement
  const inside = focusables.some((element) => element === active)
  if (event.shiftKey && (active === first || !inside)) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && active === last) {
    event.preventDefault()
    first.focus()
  }
}
