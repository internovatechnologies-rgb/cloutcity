import { expect, test } from './fixtures/test'
import {
  DAY_MS,
  LOCK_TITLE,
  T0,
  YEAR,
  answerWelcomeCard,
  lockDialog,
  storedOnboarding,
  supabaseStorageKeys,
  trackCrossOriginRequests,
  welcomeDialog,
} from './fixtures/welcome'

// S05a: under 18 sees an in-voice screen, the gate locks on this device for 24 hours, and no
// Supabase user is created.

test.use({ onboarding: 'fresh' })

test('an under-18 answer locks the gate for 24 hours, then the card returns', async ({
  page,
  baseURL,
  checkA11y,
}) => {
  const crossOrigin = trackCrossOriginRequests(page, baseURL)
  await page.clock.setFixedTime(T0)
  await page.goto('/')

  await answerWelcomeCard(page, { birthYear: YEAR - 5, consent: true, audio: 'Play our music' })

  const lock = lockDialog(page)
  await expect(lock).toBeVisible()
  await expect(lock.getByRole('heading', { name: LOCK_TITLE })).toBeFocused()
  await expect(lock).toContainText(
    'Clout City is for grown folks only. The city will still be here.',
  )
  await expect(lock.getByRole('combobox')).toHaveCount(0)
  await expect(lock.getByRole('button')).toHaveCount(0)
  await expect(welcomeDialog(page)).toHaveCount(0)
  await checkA11y()

  // Only the lock is stored: no birth year, no consent, no sound choice.
  expect(await storedOnboarding(page)).toEqual({
    state: { record: { status: 'locked', lockedUntil: T0 + DAY_MS } },
    version: 1,
  })

  // Escape and Tab do not get past the lock screen.
  await page.keyboard.press('Escape')
  await page.keyboard.press('Tab')
  await expect(lock).toBeVisible()

  await page.reload()
  await expect(lockDialog(page)).toBeVisible()

  // Setting the clock back does not unlock it.
  await page.clock.setFixedTime(T0 - DAY_MS)
  await page.reload()
  await expect(lockDialog(page)).toBeVisible()

  // Once 24 hours have passed the card is back, fresh.
  await page.clock.setFixedTime(T0 + DAY_MS + 60_000)
  await page.reload()
  await expect(welcomeDialog(page)).toBeVisible()
  await expect(welcomeDialog(page).getByRole('combobox')).toHaveValue('')
  await expect(lockDialog(page)).toHaveCount(0)
  expect(await storedOnboarding(page)).toEqual({ state: { record: null }, version: 1 })

  expect(crossOrigin).toEqual([])
  expect(await supabaseStorageKeys(page)).toEqual([])
})

test('the birth year just under the line (Y-18) is refused', async ({ page }) => {
  await page.clock.setFixedTime(T0)
  await page.goto('/')
  await answerWelcomeCard(page, { birthYear: YEAR - 18, consent: true, audio: "I'll bring my own" })
  await expect(lockDialog(page)).toBeVisible()
})
