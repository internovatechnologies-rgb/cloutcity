import { expect, test } from './fixtures/test'

// S05: the page title and share metadata carry the name and the tagline "Tap In. Blow Up."

const TITLE = 'Clout City: NYC | Tap In. Blow Up.'
const DESCRIPTION = 'Tap In. Blow Up. Make it in New York.'

test('the title and every share tag use the name and the tagline', async ({ page }) => {
  await page.goto('/')
  await expect(page).toHaveTitle(TITLE)
  const meta = (selector: string) => page.locator(`head meta[${selector}]`)
  await expect(meta('name="description"')).toHaveAttribute('content', DESCRIPTION)
  await expect(meta('property="og:title"')).toHaveAttribute('content', TITLE)
  await expect(meta('property="og:description"')).toHaveAttribute('content', DESCRIPTION)
  await expect(meta('property="og:site_name"')).toHaveAttribute('content', 'Clout City: NYC')
  await expect(meta('property="og:type"')).toHaveAttribute('content', 'website')
  await expect(meta('name="twitter:card"')).toHaveAttribute('content', 'summary')
  await expect(meta('name="twitter:title"')).toHaveAttribute('content', TITLE)
  await expect(meta('name="twitter:description"')).toHaveAttribute('content', DESCRIPTION)
})

test.describe('first visit', () => {
  test.use({ onboarding: 'fresh' })
  test('shows the tagline on the welcome card', async ({ page }) => {
    await page.goto('/')
    await expect(
      page.getByRole('dialog', { name: 'Welcome to Clout City' }),
    ).toHaveAccessibleDescription(/^Tap in\. Blow up\./)
  })
})
