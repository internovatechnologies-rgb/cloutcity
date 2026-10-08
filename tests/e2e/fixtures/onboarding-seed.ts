/**
 * A completed welcome card, as src/state/onboarding.ts persists it. The shared e2e fixture
 * writes it before every page load (unless a spec opts out with `onboarding: 'fresh'`), so specs
 * for other flows start past the card like a returning player.
 *
 * Pure data with no imports: Playwright's loader cannot load the store's JSON imports.
 * src/state/onboarding.test.ts proves it parses with the real schema and that the key and
 * consent version match the app.
 */

export const ONBOARDING_KEY = 'cloutcity:onboarding'

export const SEED_CONSENT_VERSION = '2026-10-06'

/** A fixed past instant, so the seed is deterministic. */
const SEEDED_AT = Date.UTC(2026, 0, 1)

export function completedOnboardingSeed() {
  return {
    state: {
      record: {
        status: 'complete',
        attested: true,
        attestedAt: SEEDED_AT,
        consentVersion: SEED_CONSENT_VERSION,
        consentedAt: SEEDED_AT,
        audioChoice: 'own',
      },
    },
    version: 1,
  } as const
}
