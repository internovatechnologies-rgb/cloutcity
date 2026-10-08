import { expect, test } from './fixtures/test'

// S18b part 2: the public Code of Conduct at /conduct, linked from Terms; and /mod, which is
// staff-only, never indexed, and its API refuses everyone here (no server configuration in the
// default suite).

test.describe('Code of Conduct', () => {
  test('renders the rules, the tools, the sanction ladder, appeals and crisis lines', async ({
    page,
    checkA11y,
  }) => {
    await page.goto('/conduct')
    await expect(page.getByRole('heading', { level: 1, name: 'Code of Conduct' })).toBeVisible()
    for (const heading of [
      'Adults only',
      'Respect other players',
      'Not allowed',
      'Block, mute and report',
      'What happens when someone breaks the rules',
      'Appeals',
      'If someone might get hurt',
    ]) {
      await expect(page.getByRole('heading', { level: 2, name: heading })).toBeVisible()
    }
    await expect(page.getByText('Call or text 988')).toBeVisible()
    await expect(page.getByText('Call 911 if someone is in immediate danger.')).toBeVisible()
    await expect(page.getByRole('note')).toHaveText('Placeholder: pending legal review')
    await checkA11y()
  })

  test('Terms links to it', async ({ page }) => {
    await page.goto('/terms')
    await page.getByRole('link', { name: 'Code of Conduct' }).click()
    await expect(page).toHaveURL(/\/conduct$/)
  })
})

test.describe('/mod', () => {
  test('is not indexed and shows only the sign-in form when signed out', async ({
    page,
    checkA11y,
  }) => {
    await page.goto('/mod')
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/)
    await expect(page.getByRole('heading', { level: 1, name: 'Moderation' })).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'Email' })).toBeVisible()
    await checkA11y()
  })

  test('its API answers no-store and noindex, and serves nobody without configuration', async ({
    request,
  }) => {
    const queue = await request.get('/api/mod/queue', {
      headers: { authorization: 'Bearer anything' },
    })
    expect(queue.status()).toBe(503)
    expect(queue.headers()['cache-control']).toBe('no-store')
    expect(queue.headers()['x-robots-tag']).toMatch(/noindex/)
  })
})
