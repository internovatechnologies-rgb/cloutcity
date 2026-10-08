import type { Locator } from '@playwright/test'
import { expect, test } from './fixtures/test'
import { T0, YEAR, storedOnboarding, welcomeDialog } from './fixtures/welcome'

// S05a form pattern (GR-1, GR-2): noValidate, all errors at once inline with aria-invalid and
// aria-describedby, focus on the first invalid field, errors recomputed on change.

test.use({ onboarding: 'fresh' })

const ERRORS = {
  birthYear: 'Pick the year you were born to continue.',
  consent: 'Tick the box to agree to the Terms and the Privacy Policy.',
  audio: "Choose a sound option: Play our music or I'll bring my own.",
} as const

async function expectError(control: Locator, text: string) {
  await expect(control).toHaveAttribute('aria-invalid', 'true')
  const id = await control.getAttribute('aria-describedby')
  expect(id).toBeTruthy()
  await expect(control.page().locator(`[id="${id}"]`)).toHaveText(text)
  await expect(control).toHaveAccessibleDescription(text)
}

async function expectNoError(control: Locator) {
  await expect(control).not.toHaveAttribute('aria-invalid', 'true')
  await expect(control).not.toHaveAttribute('aria-describedby')
}

test('an empty submit shows every error at once; fixing them one by one completes', async ({
  page,
  checkA11y,
}) => {
  await page.clock.setFixedTime(T0)
  await page.goto('/')
  const dialog = welcomeDialog(page)
  const select = dialog.getByRole('combobox', { name: 'Year you were born' })
  const consent = dialog.getByRole('checkbox')
  const audio = dialog.getByRole('radiogroup', { name: 'Sound' })
  const submit = dialog.getByRole('button', { name: 'Start playing' })

  await expect(dialog.locator('form')).toHaveAttribute('novalidate', '')
  // No errors before the first submit.
  await expect(dialog.getByText(ERRORS.birthYear)).toHaveCount(0)

  await submit.click()
  await expectError(select, ERRORS.birthYear)
  await expectError(consent, ERRORS.consent)
  await expectError(audio, ERRORS.audio)
  await expect(select).toBeFocused()
  expect(await storedOnboarding(page)).toBeNull()
  await checkA11y()

  // Errors are recomputed on change: fixing the year removes only its error.
  await select.selectOption(String(YEAR - 30))
  await expectNoError(select)
  await expectError(consent, ERRORS.consent)
  await expectError(audio, ERRORS.audio)

  // Undoing the fix brings it back.
  await select.selectOption('')
  await expectError(select, ERRORS.birthYear)

  await select.selectOption(String(YEAR - 30))
  await consent.check()
  await expectNoError(consent)
  // Focus goes to the first field still invalid.
  await submit.click()
  await expect(dialog.getByRole('radio', { name: 'Play our music' })).toBeFocused()
  await expectError(audio, ERRORS.audio)
  expect(await storedOnboarding(page)).toBeNull()

  await dialog.getByRole('radio', { name: "I'll bring my own" }).check()
  await expectNoError(audio)
  await expect(dialog.getByText(/Pick the year|Tick the box|Choose a sound/)).toHaveCount(0)
  await submit.click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(await storedOnboarding(page)).toMatchObject({
    state: { record: { status: 'complete', audioChoice: 'own' } },
  })
})

test('unticking consent after the first submit shows its error again', async ({ page }) => {
  await page.clock.setFixedTime(T0)
  await page.goto('/')
  const dialog = welcomeDialog(page)
  const consent = dialog.getByRole('checkbox')
  await consent.check()
  await dialog.getByRole('button', { name: 'Start playing' }).click()
  await expectNoError(consent)
  await consent.uncheck()
  await expectError(consent, ERRORS.consent)
})

const FIELDS = ['birthYear', 'consent', 'audio'] as const
type Field = (typeof FIELDS)[number]

// Every non-empty set of missing fields: focus goes to the first in DOM order and exactly the
// missing fields show errors.
const MISSING_SETS: readonly (readonly Field[])[] = [1, 2, 3, 4, 5, 6, 7].map((mask) =>
  FIELDS.filter((_, index) => (mask >> index) & 1),
)

for (const missing of MISSING_SETS) {
  test(`missing ${missing.join(' + ')}: those errors only, focus on ${missing[0]}`, async ({
    page,
  }) => {
    await page.clock.setFixedTime(T0)
    await page.goto('/')
    const dialog = welcomeDialog(page)
    const controls = {
      birthYear: dialog.getByRole('combobox', { name: 'Year you were born' }),
      consent: dialog.getByRole('checkbox'),
      audio: dialog.getByRole('radiogroup', { name: 'Sound' }),
    }
    const focusTarget = {
      birthYear: controls.birthYear,
      consent: controls.consent,
      audio: dialog.getByRole('radio', { name: 'Play our music' }),
    }
    if (!missing.includes('birthYear')) await controls.birthYear.selectOption(String(YEAR - 30))
    if (!missing.includes('consent')) await controls.consent.check()
    if (!missing.includes('audio')) {
      await dialog.getByRole('radio', { name: "I'll bring my own" }).check()
    }
    await dialog.getByRole('button', { name: 'Start playing' }).click()

    const first = missing[0]
    if (first === undefined) throw new Error('empty set')
    await expect(focusTarget[first]).toBeFocused()
    for (const field of FIELDS) {
      if (missing.includes(field)) await expectError(controls[field], ERRORS[field])
      else await expectNoError(controls[field])
    }
    expect(await storedOnboarding(page)).toBeNull()
  })
}

test('after an empty submit, fixing consent or sound removes only that error', async ({ page }) => {
  await page.clock.setFixedTime(T0)
  await page.goto('/')
  const dialog = welcomeDialog(page)
  const select = dialog.getByRole('combobox', { name: 'Year you were born' })
  const consent = dialog.getByRole('checkbox')
  const audio = dialog.getByRole('radiogroup', { name: 'Sound' })
  await dialog.getByRole('button', { name: 'Start playing' }).click()

  // Click the native inputs themselves (GR-8).
  await consent.click()
  await expectNoError(consent)
  await expectError(select, ERRORS.birthYear)
  await expectError(audio, ERRORS.audio)

  await dialog.getByRole('radio', { name: 'Play our music' }).click()
  await expectNoError(audio)
  await expectError(select, ERRORS.birthYear)
  await expect(dialog.getByText(ERRORS.birthYear)).toHaveCount(1)
})
