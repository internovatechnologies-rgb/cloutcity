import type { Page } from '@playwright/test'
import { expect, test } from './fixtures/test'
import { answerWelcomeCard, YEAR } from './fixtures/welcome'
import { waitForMapSettled } from './helpers/scene'
import { database } from './helpers/seed'
import { localStack } from './helpers/stack'

// S18a part 2, opt-in (`npm run e2e:supabase`): against the local stack, a new guest's Me panel
// shows the server-generated handle; "claude qa" previews as @claude_qa and is saved exactly so
// (GR-6); a taken handle and a filtered one are refused inline; a second change inside the
// limit names the date it opens.

test.use({
  onboarding: 'fresh',
  // The refused second change is a 429 from the database; the browser itself logs that.
  injectedConsoleErrors: [/status of 429 \(handle_change_limited\)/],
})
// One project only: the spec claims @claude_qa, which two parallel browsers would race for.
test.skip(({ isMobile }) => !isMobile, 'runs once, on mobile-390')

const stack = localStack()
// Opened and closed per group of tests: with fullyParallel, one worker can run this file's
// tests in several groups, and a connection ended after the first would fail the next.
let sql: ReturnType<typeof database>
test.beforeAll(() => {
  sql = database(stack)
})
test.afterAll(async () => {
  await sql.end()
})

// The shared stack keeps every handle: free claude_qa from earlier runs of this spec first.
test.beforeAll(async () => {
  await sql`delete from auth.users where id in (select user_id from public.handles where handle_key = 'claudeqa')`
  await sql`delete from public.handles where handle_key = 'claudeqa'`
})

const session = (page: Page) =>
  page.evaluate(() => window.__cloutcityTest?.session?.state().status ?? null)

test('a guest sees their generated handle and sets @claude_qa exactly as previewed', async ({
  page,
  checkA11y,
}) => {
  test.setTimeout(90_000)
  await page.addInitScript(() => {
    window.__CLOUTCITY_E2E__ = true
  })
  await page.goto('/')
  await page.waitForFunction(() => window.__cloutcityTest?.session !== undefined)
  await answerWelcomeCard(page, { birthYear: YEAR - 30, consent: true, audio: "I'll bring my own" })
  await waitForMapSettled(page)
  await expect.poll(() => session(page), { timeout: 20_000 }).toBe('anonymous')

  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Me' }).click()
  const me = page.getByRole('dialog', { name: 'Me' })
  const handle = me.locator('[data-me-handle]')
  await expect(handle).toHaveText(/^@[A-Z][a-z]+[A-Z][a-z]+\d{2,4}$/)
  await expect(me).toContainText('Level: Nobody')
  await expect(me).toContainText('No Dream picked yet')
  await expect(me.locator('[data-handle-allowance]')).toHaveText('Your first change is free.')
  await expect(me.locator('[data-safety-lists]')).toContainText("You haven't blocked anyone.")
  await checkA11y()

  const input = me.getByRole('textbox', { name: 'New handle' })
  await input.fill('claude qa')
  await expect(me.locator('[data-handle-preview]')).toContainText('Your handle will be @claude_qa')
  await expect(me.locator('[data-handle-preview]')).toContainText('Spaces, dots and dashes')
  await expect(me.getByRole('status').filter({ hasText: '@claude_qa is free.' })).toBeVisible()
  await me.getByRole('button', { name: 'Save handle' }).click()
  await expect(me.getByText("Done. You're @claude_qa now.")).toBeVisible()
  await expect(handle).toHaveText('@claude_qa')
  const [row] = await sql<{ handle: string }[]>`
    select handle from public.handles where handle_key = 'claudeqa' and released_at is null
  `
  expect(row?.handle).toBe('claude_qa')

  // Taken: someone else's handle, found by the live check.
  const [other] = await sql<{ handle: string }[]>`
    select handle from public.profiles where handle is not null and handle <> 'claude_qa' limit 1
  `
  if (other === undefined) throw new Error('no other handle on the stack')
  await input.fill(other.handle)
  await expect(me.locator('[data-handle-error]')).toHaveText(
    'That handle is taken. Try another one.',
  )
  await expect(input).toHaveAttribute('aria-invalid', 'true')

  // Filtered: a reserved staff word.
  await input.fill('mod')
  await expect(me.locator('[data-handle-error]')).toHaveText(
    "That handle isn't allowed here. Pick something else.",
  )

  // A second change right after the free one is limited, and says when it opens.
  await expect(me.locator('[data-handle-allowance]')).toHaveText(
    /^Your next handle change opens on \w+ \d+, \d{4}\.$/,
  )
  // A generated-style name always passes the filter; the limit is checked before availability.
  await input.fill('BoldBodega77')
  await me.getByRole('button', { name: 'Save handle' }).click()
  await expect(me.locator('[data-handle-error]')).toHaveText(
    /^You changed your handle recently\. You can change it again on \w+ \d+, \d{4}\.$/,
  )
  await expect(input).toBeFocused()
})
