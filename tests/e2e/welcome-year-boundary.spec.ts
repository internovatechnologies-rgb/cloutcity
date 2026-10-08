import type { Page } from '@playwright/test'
import { expect, test } from './fixtures/test'
import { answerWelcomeCard, lockDialog, storedOnboarding, welcomeDialog } from './fixtures/welcome'

// S05a: the age rule and the year list use New York's year, not the device's or UTC's. Only a
// birth year at least 19 back passes (born in Y-18, the birthday may not have come yet).

test.use({ onboarding: 'fresh' })

async function yearOptions(page: Page): Promise<string[]> {
  return welcomeDialog(page)
    .getByRole('combobox', { name: 'Year you were born' })
    .locator('option')
    .evaluateAll((els) => els.map((el) => (el as HTMLOptionElement).value).filter(Boolean))
}

const CASES = [
  // 23:30 on New Year's Eve in New York; already 2027 in UTC and on the device.
  { instant: '2026-12-31T23:30:00-05:00', timezoneId: 'UTC', nyYear: 2026 },
  { instant: '2026-12-31T23:30:00-05:00', timezoneId: 'Pacific/Kiritimati', nyYear: 2026 },
  // 03:00 UTC on 1 January: still 22:00 on 31 December in New York.
  { instant: '2027-01-01T03:00:00Z', timezoneId: 'UTC', nyYear: 2026 },
  // Just past midnight in New York; still 2026 on a device in Honolulu.
  { instant: '2027-01-01T05:00:30Z', timezoneId: 'Pacific/Honolulu', nyYear: 2027 },
] as const

for (const { instant, timezoneId, nyYear } of CASES) {
  test.describe(`${instant} on a device in ${timezoneId}`, () => {
    test.use({ timezoneId })

    test.beforeEach(async ({ page }) => {
      await page.clock.setFixedTime(new Date(instant))
      await page.goto('/')
      await expect(welcomeDialog(page)).toBeVisible()
    })

    test(`the list starts at ${nyYear}, the New York year`, async ({ page }) => {
      const years = await yearOptions(page)
      expect(years[0]).toBe(String(nyYear))
      expect(years).toHaveLength(101)
      expect(years.at(-1)).toBe(String(nyYear - 100))
    })

    test(`${nyYear - 19} passes`, async ({ page }) => {
      await answerWelcomeCard(page, {
        birthYear: nyYear - 19,
        consent: true,
        audio: 'Play our music',
      })
      await expect(page.getByRole('dialog')).toHaveCount(0)
      expect(await storedOnboarding(page)).toMatchObject({
        state: { record: { status: 'complete' } },
      })
    })

    test(`${nyYear - 18} is refused`, async ({ page }) => {
      await answerWelcomeCard(page, {
        birthYear: nyYear - 18,
        consent: true,
        audio: 'Play our music',
      })
      await expect(lockDialog(page)).toBeVisible()
    })
  })
}

test.describe('the New York year changes while the card is open', () => {
  test.use({ timezoneId: 'America/New_York' })

  test('the list keeps the year it opened with; the age rule uses the time of submit', async ({
    page,
  }) => {
    await page.clock.setFixedTime(new Date('2026-12-31T23:59:00-05:00'))
    await page.goto('/')
    // 2008 is refused in 2026 but passes in 2027.
    const dialog = welcomeDialog(page)
    await dialog.getByRole('combobox').selectOption('2008')
    await dialog.getByRole('checkbox').check()
    await dialog.getByRole('radio', { name: "I'll bring my own" }).check()

    await page.clock.setFixedTime(new Date('2027-01-01T00:01:00-05:00'))
    // Captured once per mount: no 2027 option appears.
    expect((await yearOptions(page))[0]).toBe('2026')
    await dialog.getByRole('button', { name: 'Start playing' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(await storedOnboarding(page)).toMatchObject({
      state: { record: { status: 'complete', attestedAt: Date.parse('2027-01-01T05:01:00Z') } },
    })
  })
})
