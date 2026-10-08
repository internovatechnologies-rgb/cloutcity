import { expect, test } from './fixtures/test'
import { answerWelcomeCard, supabaseStorageKeys, YEAR } from './fixtures/welcome'
import { waitForMapSettled } from './helpers/scene'

// S05, opt-in (`npm run e2e:supabase`, playwright.supabase.config.ts): against the local
// Supabase stack, the welcome card leads to an anonymous session with the attestation recorded,
// once the map is playable; a reload reuses it instead of signing in again. The stack is shared
// by every checkout: this only creates anonymous users and never resets it.

test.use({ onboarding: 'fresh' })

const session = (page: import('@playwright/test').Page) =>
  page.evaluate(() => window.__cloutcityTest?.session?.state() ?? null)

test('an adult guest gets one anonymous session, reused after a reload', async ({ page }) => {
  await page.addInitScript(() => {
    window.__CLOUTCITY_E2E__ = true
  })
  const signUps: string[] = []
  const attests: number[] = []
  page.on('response', (response) => {
    const url = new URL(response.url())
    if (url.pathname === '/auth/v1/signup') signUps.push(url.pathname)
    if (url.pathname === '/rest/v1/rpc/attest_and_consent') attests.push(response.status())
  })

  await page.goto('/')
  await page.waitForFunction(() => window.__cloutcityTest?.session !== undefined)
  expect((await session(page))?.status).not.toBe('anonymous')
  await answerWelcomeCard(page, { birthYear: YEAR - 30, consent: true, audio: "I'll bring my own" })
  await waitForMapSettled(page)

  await expect
    .poll(async () => (await session(page))?.status, { timeout: 20_000 })
    .toBe('anonymous')
  expect(await session(page)).toEqual({ status: 'anonymous', reason: null, reused: false })
  expect(signUps).toHaveLength(1)
  expect(attests).toEqual([200])
  const keys = await supabaseStorageKeys(page)
  expect(keys).toEqual([expect.stringMatching(/^sb-.+-auth-token$/)])

  await page.reload()
  await waitForMapSettled(page)
  await expect
    .poll(async () => (await session(page))?.status, { timeout: 20_000 })
    .toBe('anonymous')
  expect(await session(page)).toEqual({ status: 'anonymous', reason: null, reused: true })
  expect(signUps).toHaveLength(1)
  expect(attests).toEqual([200, 200])
})
