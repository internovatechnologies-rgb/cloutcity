/**
 * A finished first-run tour, as src/state/tour.ts persists it. The shared e2e fixture writes it
 * before every page load (unless a spec opts out with `tour: 'fresh'`), so specs for other flows
 * start like a player who has already taken the tour and never see its coach marks.
 *
 * Pure data with no imports: Playwright's loader cannot load the store's JSON imports.
 * src/state/tour.test.ts proves it parses with the real schema and that the key matches the app.
 */

export const TOUR_KEY = 'cloutcity:tour'

export function doneTourSeed() {
  return { state: { record: { status: 'done' } }, version: 1 } as const
}
