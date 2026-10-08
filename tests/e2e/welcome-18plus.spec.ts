import { expect, test } from './fixtures/test'
import {
  T0,
  YEAR,
  storedOnboarding,
  supabaseStorageKeys,
  trackCrossOriginRequests,
  welcomeDialog,
} from './fixtures/welcome'

// S05a: an 18+ answer stores the attestation (not the year), consent and sound choice, and the
// card never shows again.

test.use({ onboarding: 'fresh' })

test('an adult passes the card, which never shows again', async ({ page, baseURL }) => {
  const crossOrigin = trackCrossOriginRequests(page, baseURL)
  await page.clock.setFixedTime(T0)
  await page.goto('/')

  const dialog = welcomeDialog(page)
  await dialog.getByRole('combobox', { name: 'Year you were born' }).selectOption(String(YEAR - 30))
  // Click the native controls themselves: nothing may be layered over them (GR-8).
  await dialog.getByRole('checkbox').click()
  await dialog.getByRole('radio', { name: 'Play our music' }).click()
  await expect(dialog.getByRole('checkbox')).toBeChecked()
  await expect(dialog.getByRole('radio', { name: 'Play our music' })).toBeChecked()
  await dialog.getByRole('button', { name: 'Start playing' }).click()

  await expect(dialog).toHaveCount(0)
  await expect(page.locator('main')).toBeFocused()
  const hud = page.getByRole('heading', { level: 1, name: 'Clout City: NYC' })
  await expect(hud).toBeVisible()
  expect(await hud.evaluate((el) => el.closest('[inert]') === null)).toBe(true)
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('button', { name: 'Map', exact: true })
    .click()

  const stored = (await storedOnboarding(page)) as { state: { record: Record<string, unknown> } }
  const record = stored.state.record
  expect(Object.keys(record).sort()).toEqual(
    ['attested', 'attestedAt', 'audioChoice', 'consentVersion', 'consentedAt', 'status'].sort(),
  )
  expect(record).toEqual({
    status: 'complete',
    attested: true,
    attestedAt: T0,
    consentVersion: '2026-10-06',
    consentedAt: T0,
    audioChoice: 'ours',
  })
  expect(JSON.stringify(stored)).not.toContain(String(YEAR - 30))

  await page.reload()
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)

  expect(crossOrigin).toEqual([])
  expect(await supabaseStorageKeys(page)).toEqual([])
})

test('Y-19 is old enough', async ({ page }) => {
  await page.clock.setFixedTime(T0)
  await page.goto('/')
  const dialog = welcomeDialog(page)
  await dialog.getByRole('combobox').selectOption(String(YEAR - 19))
  await dialog.getByRole('checkbox').check()
  await dialog.getByRole('radio', { name: "I'll bring my own" }).check()
  await dialog.getByRole('button', { name: 'Start playing' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(await storedOnboarding(page)).toMatchObject({
    state: { record: { status: 'complete', audioChoice: 'own' } },
  })
})
