/**
 * The tour's target and its link to the screen (S06), shared by the tour host and the More
 * panel's Help item, which resumes the tour from wherever the player is.
 */
// Read directly (validated by TourConfigSchema in src/lib/data/data.test.ts): the classic-zod
// loader in src/lib/data/config.ts must stay out of client chunks.
import tourJson from '@data/config/tour.json'
import { hudPanelStore } from '@/state/hudPanel'
import { currentPlaceId } from '@/state/placeSheet'
import { placesPanelShown, placesPanelStore } from '@/state/placesPanel'
import { tourStore, type TourStep, type TourTarget, type TourUi } from '@/state/tour'

export const tourConfig = tourJson

export const TOUR_TARGET: TourTarget = { placeId: tourJson.placeId, actionId: tourJson.actionId }

/** What the tour reads from the screen right now (outside React). */
export function currentTourUi(): TourUi {
  const openPlaceId = currentPlaceId()
  return {
    panelShown: placesPanelShown(
      placesPanelStore.getState(),
      openPlaceId,
      hudPanelStore.getState().panel,
    ),
    openPlaceId,
  }
}

/** More, Help: resumes a skipped tour where it stopped, or replays a finished one. */
export function resumeTour(): void {
  tourStore.getState().dispatch({ type: 'resume', ui: currentTourUi() }, TOUR_TARGET)
}

/**
 * The element each step rings: the HUD, the Places button, the place in the Places panel, its
 * "Walk there" row and then its action in the place sheet, the cash in the HUD, and the More button that holds Help.
 * `escape` is CSS.escape in the browser.
 */
export function tourHighlightSelector(
  step: TourStep,
  target: TourTarget,
  escape: (value: string) => string,
): string {
  const place = escape(target.placeId)
  switch (step) {
    case 'hud':
      return '[data-hud]'
    case 'find':
      return '[data-places-button]'
    case 'pick':
      return `[data-place-button="${place}"]`
    case 'buy':
      // Away from the place (S08) the step rings "Walk there" first, then the purchase.
      return [
        `[data-place-sheet="${place}"]:not([data-player-here]) [data-trip-mode="walk"]`,
        `[data-place-sheet="${place}"][data-player-here] [data-place-action="${escape(target.actionId)}"]`,
      ].join(',')
    case 'cash':
      return '[data-hud-cell="money"]'
    case 'done':
      return '[data-hud-panel="more"]'
  }
}

/**
 * The ring's style sheet: an inset ring, so a zone's clipping never cuts it off, that pulses
 * only when the player has not asked for reduced motion.
 */
export function tourHighlightCss(selector: string): string {
  return [
    `${selector}{box-shadow:inset 0 0 0 3px var(--color-focus)}`,
    '@keyframes cc-tour-pulse{50%{box-shadow:inset 0 0 0 3px transparent}}',
    `@media (prefers-reduced-motion:no-preference){${selector}{animation:cc-tour-pulse 1.4s ease-in-out infinite}}`,
  ].join('\n')
}
