import type { Locator, Page } from '@playwright/test'
import type { SafetyTestHook } from '@/components/safety/safetyTestHook'
import { expect, test } from './fixtures/test'
import { waitForMapSettled } from './helpers/scene'

// S18b part 2: the one PlayerActions component every player surface will use. No live player
// surface exists before S29, so the safety test hook mounts it for a fake player in the sheet
// zone, against an in-memory SafetyApi (src/components/safety/fakeSafetyApi.ts); the server side
// is covered by the integration suite and safety.supabase.spec.ts.

type MountOptions = Parameters<SafetyTestHook['mount']>[0]

async function boot(page: Page, options: MountOptions) {
  await page.addInitScript(() => {
    window.__CLOUTCITY_E2E__ = true
  })
  await page.goto('/')
  await waitForMapSettled(page)
  await page.waitForFunction(() => window.__cloutcityTest?.safety !== undefined)
  await page.evaluate((mount) => window.__cloutcityTest?.safety?.mount(mount), options)
  return page.locator('[data-safety-harness]')
}

const calls = (page: Page) => page.evaluate(() => window.__cloutcityTest?.safety?.calls() ?? [])

const toast = (page: Page) => page.locator('[data-safety-toast]')

async function tap(page: Page, locator: Locator) {
  if (test.info().project.use.hasTouch) await locator.tap()
  else await locator.click()
}

test.describe('player actions', () => {
  test('inline: Mute, Block and Report are each one tap away, in that order', async ({
    page,
    checkA11y,
  }) => {
    const harness = await boot(page, { handle: 'Rival', layout: 'inline' })
    const group = harness.getByRole('list', { name: 'Actions for @Rival' })
    await expect(group.getByRole('button')).toHaveText(['Mute', 'Block', 'Report'])
    await expect(harness.getByRole('button', { name: 'Add friend' })).toHaveCount(0)
    await checkA11y()
  })

  test('menu: Options then any action, two taps; Escape closes the menu', async ({ page }) => {
    const harness = await boot(page, { handle: 'Rival', layout: 'menu' })
    const options = harness.getByRole('button', { name: 'Options for @Rival' })
    await expect(harness.getByRole('button', { name: 'Mute @Rival' })).toHaveCount(0)
    await tap(page, options)
    await expect(options).toHaveAttribute('aria-expanded', 'true')
    await expect(
      harness.getByRole('list', { name: 'Actions for @Rival' }).getByRole('button'),
    ).toHaveText(['Mute', 'Block', 'Report'])
    await tap(page, harness.getByRole('button', { name: 'Mute @Rival' }))
    await expect(toast(page)).toContainText('@Rival is muted.')
    expect(await calls(page)).toEqual(['mute:fake-Rival'])

    await harness.getByRole('button', { name: 'Unmute @Rival' }).focus()
    await page.keyboard.press('Escape')
    await expect(options).toHaveAttribute('aria-expanded', 'false')
    await expect(options).toBeFocused()
  })

  test('Mute shows a toast whose Undo unmutes', async ({ page, checkA11y }) => {
    const harness = await boot(page, { handle: 'Rival', layout: 'inline' })
    await tap(page, harness.getByRole('button', { name: 'Mute @Rival' }))
    await expect(toast(page)).toContainText(
      '@Rival is muted. Their avatar and emotes are hidden for you.',
    )
    await expect(harness.getByRole('button', { name: 'Unmute @Rival' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await checkA11y()
    await tap(page, toast(page).getByRole('button', { name: 'Undo and bring @Rival back' }))
    await expect(toast(page)).toContainText('@Rival is unmuted.')
    await expect(harness.getByRole('button', { name: 'Mute @Rival' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    expect(await calls(page)).toEqual(['mute:fake-Rival', 'unmute:fake-Rival'])
  })

  test('Block asks first, says what ends, and Undo brings it back', async ({ page, checkA11y }) => {
    const harness = await boot(page, { handle: 'Rival', layout: 'inline', endsFriendship: true })
    await tap(page, harness.getByRole('button', { name: 'Block @Rival' }))
    const confirm = harness.locator('[data-block-confirm]')
    await expect(confirm.getByRole('heading', { name: 'Block @Rival?' })).toBeFocused()
    await expect(confirm).toContainText('ends your friendship and any roommate link')
    await expect(confirm).toContainText("They won't be told you blocked them.")
    expect(await calls(page)).toEqual([])
    await checkA11y()

    await confirm.getByRole('button', { name: 'Cancel' }).click()
    await expect(confirm).toHaveCount(0)
    await expect(harness.getByRole('button', { name: 'Block @Rival' })).toBeFocused()

    await tap(page, harness.getByRole('button', { name: 'Block @Rival' }))
    await tap(
      page,
      harness.locator('[data-block-confirm]').getByRole('button', { name: 'Block @Rival' }),
    )
    await expect(toast(page)).toContainText(
      '@Rival is blocked. Your friendship and roommate link ended.',
    )
    await expect(harness.getByRole('button', { name: 'Unblock @Rival' })).toBeVisible()
    await tap(page, toast(page).getByRole('button', { name: 'Undo and bring @Rival back' }))
    await expect(toast(page)).toContainText('@Rival is unblocked, and what blocking ended is back.')
    expect(await calls(page)).toEqual(['block:fake-Rival', 'unblock:fake-Rival'])
  })

  test("Undo closes when the server's undo window does, not the local default", async ({
    page,
  }) => {
    // The server's window (undo_expires_at) is 1 s; moderation.json says 10 s. An Undo offered
    // past the server's window would unblock without restoring what the block ended.
    const harness = await boot(page, {
      handle: 'Rival',
      layout: 'inline',
      endsFriendship: true,
      undoSeconds: 1,
    })
    await tap(page, harness.getByRole('button', { name: 'Block @Rival' }))
    await tap(
      page,
      harness.locator('[data-block-confirm]').getByRole('button', { name: 'Block @Rival' }),
    )
    await expect(toast(page)).toContainText('@Rival is blocked.')
    await expect(
      toast(page).getByRole('button', { name: 'Undo and bring @Rival back' }),
    ).toHaveCount(0, { timeout: 3_000 })
  })

  test('a refused action says why in plain words', async ({ page }) => {
    const harness = await boot(page, {
      handle: 'Rival',
      layout: 'inline',
      failures: { mute: 'account_suspended' },
    })
    await tap(page, harness.getByRole('button', { name: 'Mute @Rival' }))
    await expect(harness.getByRole('alert')).toHaveText(
      "Your account is suspended for now, so you can't do that.",
    )
    await expect(toast(page)).toHaveCount(0)
  })
})

test.describe('report form', () => {
  test('an empty submit shows every error at once and focuses the first (GR-1, GR-2)', async ({
    page,
    checkA11y,
  }) => {
    const harness = await boot(page, { handle: 'Rival', layout: 'inline' })
    await tap(page, harness.getByRole('button', { name: 'Report @Rival' }))
    const form = harness.locator('[data-report-form="player"]')
    await expect(form.getByRole('heading', { name: 'Report @Rival' })).toBeFocused()

    const note = form.getByRole('textbox', { name: /Anything else/ })
    await note.fill('find me at cloutcity.com')
    await expect(form.locator('[data-note-count]')).toHaveText('24 of 280 characters')
    await form.getByRole('button', { name: 'Send report' }).click()
    await expect(form.getByText('Pick a reason for your report.')).toBeVisible()
    await expect(
      form.getByText('Leave out links, emails, phone numbers, @handles and hidden characters.'),
    ).toBeVisible()
    await expect(form.getByRole('radio').first()).toBeFocused()
    await expect(form.getByRole('radiogroup')).toHaveAttribute('aria-invalid', 'true')
    await expect(note).toHaveAttribute('aria-invalid', 'true')
    await checkA11y()

    // Errors recompute on change: fixing the note clears its error, the reason's stays.
    await note.fill('kept following me around')
    await expect(
      form.getByText('Leave out links, emails, phone numbers, @handles and hidden characters.'),
    ).toHaveCount(0)
    await expect(form.getByText('Pick a reason for your report.')).toBeVisible()
    await form.getByRole('radio', { name: 'Harassment or bullying' }).check()
    await expect(form.getByText('Pick a reason for your report.')).toHaveCount(0)
    await form.getByRole('button', { name: 'Send report' }).click()
    await expect(toast(page)).toContainText('Thanks. Your report about @Rival is in')
    await expect(harness.getByRole('button', { name: 'Report @Rival' })).toBeFocused()
    expect(await calls(page)).toEqual(['report:fake-Rival'])
  })

  test('"Someone might hurt themselves" shows the crisis lines at once', async ({ page }) => {
    const harness = await boot(page, { handle: 'Rival', layout: 'inline' })
    await tap(page, harness.getByRole('button', { name: 'Report @Rival' }))
    const form = harness.locator('[data-report-form="player"]')
    await expect(form.locator('[data-crisis-panel]')).toHaveCount(0)
    await form.getByRole('radio', { name: 'Someone might hurt themselves' }).check()
    const crisis = form.locator('[data-crisis-panel]')
    await expect(crisis).toContainText('Call or text 988 for the Suicide and Crisis Lifeline (US).')
    await expect(crisis).toContainText('Call 911 if someone is in immediate danger.')
  })

  test('works with the keyboard alone, and "Also block" blocks after reporting', async ({
    page,
  }) => {
    const harness = await boot(page, { handle: 'Rival', layout: 'inline' })
    await harness.getByRole('button', { name: 'Report @Rival' }).focus()
    await page.keyboard.press('Enter')
    const form = harness.locator('[data-report-form="player"]')
    await expect(form.getByRole('heading', { name: 'Report @Rival' })).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(form.getByRole('radio').first()).toBeFocused()
    await page.keyboard.press('Space')
    await expect(form.getByRole('radio', { name: 'Harassment or bullying' })).toBeChecked()
    await page.keyboard.press('Tab')
    await expect(form.getByRole('textbox')).toBeFocused()
    await page.keyboard.type('they keep spamming me')
    await page.keyboard.press('Tab')
    await expect(form.getByRole('checkbox', { name: 'Also block @Rival' })).toBeFocused()
    await page.keyboard.press('Space')
    await page.keyboard.press('Tab')
    await expect(form.getByRole('link', { name: 'Code of Conduct' })).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(form.getByRole('button', { name: 'Send report' })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(toast(page)).toContainText(
      "Thanks. Your report about @Rival is in, and they're blocked.",
    )
    expect(await calls(page)).toEqual(['report:fake-Rival', 'block:fake-Rival'])
    await expect(harness.getByRole('button', { name: 'Unblock @Rival' })).toBeVisible()
  })

  test('stays inside the sheet zone at every width (UX-1)', async ({ page }) => {
    const harness = await boot(page, { handle: 'Rival', layout: 'inline' })
    await tap(page, harness.getByRole('button', { name: 'Report @Rival' }))
    const sheet = await page.locator('[data-overlay-zone="sheet"]').boundingBox()
    const tabs = await page.locator('[data-overlay-zone="tabs"]').boundingBox()
    if (sheet === null || tabs === null) throw new Error('zones are not rendered')
    expect(sheet.y + sheet.height).toBeLessThanOrEqual(tabs.y + 1)
    // The form scrolls inside the zone: its submit button is reachable without leaving it.
    const submit = harness.getByRole('button', { name: 'Send report' })
    await submit.scrollIntoViewIfNeeded()
    const button = await submit.boundingBox()
    if (button === null) throw new Error('submit is not rendered')
    expect(button.y).toBeGreaterThanOrEqual(sheet.y - 1)
    expect(button.y + button.height).toBeLessThanOrEqual(sheet.y + sheet.height + 1)
    expect(button.height).toBeGreaterThanOrEqual(44)
  })
})

test.describe('account notices', () => {
  test('a suspension notice shows at session start; it can be appealed once, then acknowledged', async ({
    page,
    checkA11y,
  }) => {
    await boot(page, { handle: 'Rival', layout: 'inline' })
    await page.evaluate(() =>
      window.__cloutcityTest?.safety?.showNotices([
        {
          id: 'n1',
          kind: 'suspension',
          reason: 'harassment',
          endsAt: '2026-11-01T12:00:00Z',
          createdAt: '2026-10-07T12:00:00Z',
          sanctionId: 's1',
        },
      ]),
    )
    const dialog = page.getByRole('dialog', { name: 'A message from the moderators' })
    await expect(dialog).toContainText('A moderator suspended your account.')
    await expect(dialog).toContainText('Reason: Harassment or bullying')
    await expect(dialog).toContainText(/Until (October 31|November 1), 2026\./)
    await checkA11y()

    await dialog.getByRole('button', { name: 'Appeal' }).click()
    const appeal = page.getByRole('dialog', { name: 'Appeal this decision' })
    await appeal.getByRole('button', { name: 'Send appeal' }).click()
    await expect(appeal.getByText('Write a few words about why this was a mistake.')).toBeVisible()
    await expect(appeal.getByRole('textbox')).toBeFocused()
    await appeal.getByRole('textbox').fill('That was my cousin on my phone.')
    await appeal.getByRole('button', { name: 'Send appeal' }).click()
    await expect(dialog.getByRole('status')).toHaveText(
      "Your appeal is in. We'll tell you here what we decide.",
    )
    await expect(dialog.getByRole('button', { name: 'Appeal' })).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Got it' }).click()
    await expect(dialog).toHaveCount(0)
    expect(await calls(page)).toEqual(['appeal:n1', 'acknowledgeNotice:n1'])
  })
})
