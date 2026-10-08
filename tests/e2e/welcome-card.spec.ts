import { expect, test } from './fixtures/test'
import { T0, YEAR, welcomeDialog } from './fixtures/welcome'

// S05a: on first visit one welcome card sits over the already-loading map.

test.use({ onboarding: 'fresh' })

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(T0)
})

test('the card sits over the mounted, inert map with a neutral year picker', async ({ page }) => {
  await page.goto('/')
  const dialog = welcomeDialog(page)
  await expect(dialog).toBeVisible()
  await expect(dialog).toHaveAttribute('aria-modal', 'true')
  await expect(dialog.getByRole('heading', { name: 'Welcome to Clout City' })).toBeFocused()
  await expect(dialog).toHaveAccessibleDescription(/Tap in\. Blow up\./)

  // The scene and the zones stay mounted and rendered behind the card, but inert.
  const main = page.locator('main')
  await expect(main).toBeAttached()
  expect(await main.boundingBox()).not.toBeNull()
  expect(await main.evaluate((el) => el.closest('[inert]') !== null)).toBe(true)
  expect(
    await page
      .locator('[data-overlay-zone="hud"]')
      .evaluate((el) => el.closest('[inert]') !== null),
  ).toBe(true)

  // No default, and nothing in the list or around it hints at the threshold.
  const select = dialog.getByRole('combobox', { name: 'Year you were born' })
  await expect(select).toHaveValue('')
  const options = await select
    .locator('option')
    .evaluateAll((els) =>
      els.map((el) => ({ value: (el as HTMLOptionElement).value, text: el.textContent ?? '' })),
    )
  expect(options[0]).toEqual({ value: '', text: 'Select a year' })
  expect(options[1]?.value).toBe(String(YEAR))
  expect(options.map((option) => option.value)).toContain(String(YEAR - 5))
  for (const option of options.slice(1)) expect(option.text).toBe(option.value)
  await expect(select).not.toHaveAttribute('aria-describedby')

  // Every text in the card except the year list itself (years such as 2018 contain "18").
  const text = await dialog.evaluate((el) => {
    const clone = el.cloneNode(true) as HTMLElement
    clone.querySelectorAll('option').forEach((option) => option.remove())
    return clone.textContent ?? ''
  })
  expect(text).not.toMatch(/18|eighteen|adult|old enough/i)
  // Nor in any attribute a screen reader or tooltip could read out.
  const attributes = await dialog.evaluate((el) =>
    Array.from(el.querySelectorAll('*'))
      .filter((node) => node.tagName !== 'OPTION')
      .flatMap((node) =>
        ['aria-label', 'title', 'placeholder', 'alt', 'aria-description', 'min', 'max'].map(
          (name) => node.getAttribute(name) ?? '',
        ),
      )
      .join(' '),
  )
  expect(attributes).not.toMatch(/18|eighteen|adult|old enough/i)
  // No option is pre-selected in the markup either.
  expect(await select.locator('option[selected]').count()).toBe(0)

  // Sound choice: two native radios, neither checked.
  const ours = dialog.getByRole('radio', { name: 'Play our music' })
  const own = dialog.getByRole('radio', { name: "I'll bring my own" })
  await expect(ours).not.toBeChecked()
  await expect(own).not.toBeChecked()
  await expect(dialog.getByRole('checkbox')).not.toBeChecked()
})

test('Terms and Privacy links open their placeholder pages in a new tab', async ({
  page,
  request,
  checkA11y,
}) => {
  await page.goto('/')
  const dialog = welcomeDialog(page)
  const terms = dialog.getByRole('link', { name: /^Terms/ })
  const privacy = dialog.getByRole('link', { name: /^Privacy Policy/ })
  for (const [link, href] of [
    [terms, '/terms'],
    [privacy, '/privacy'],
  ] as const) {
    await expect(link).toHaveAttribute('href', href)
    await expect(link).toHaveAttribute('target', '_blank')
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    await expect(link).toHaveAccessibleName(/\(opens in a new tab\)$/)
  }
  await checkA11y()

  for (const [path, title] of [
    ['/terms', 'Terms'],
    ['/privacy', 'Privacy Policy'],
  ] as const) {
    expect((await request.get(path)).status()).toBe(200)
    await page.goto(path)
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible()
    await expect(page.getByText('Placeholder: pending legal review')).toBeVisible()
    // The legal pages are never behind the card.
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await checkA11y()
  }
  await expect(page.getByText(/never store, log or send the year you were born/)).toBeVisible()
})

test('the Terms link opens a new tab and leaves the card in place', async ({ page, context }) => {
  await page.goto('/')
  const [tab] = await Promise.all([
    context.waitForEvent('page'),
    welcomeDialog(page)
      .getByRole('link', { name: /^Terms/ })
      .click(),
  ])
  await tab.waitForLoadState()
  expect(new URL(tab.url()).pathname).toBe('/terms')
  await expect(welcomeDialog(page)).toBeVisible()
  await expect(welcomeDialog(page).getByRole('checkbox')).not.toBeChecked()
  await tab.close()
})
