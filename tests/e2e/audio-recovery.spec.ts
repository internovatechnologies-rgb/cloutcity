import { expect, test } from './fixtures/test'
import { audio, installAudioProbe } from './fixtures/audio'
import { T0, YEAR, answerWelcomeCard } from './fixtures/welcome'
import { waitForMapSettled } from './helpers/scene'

// When music or the audio runtime cannot load, the sound control says so instead of
// "Loading…" forever, and a tap retries (S05b fix cycle 1).

test.use({
  onboarding: 'fresh',
  // The specs cut the network on purpose; the browser reports each refused request.
  injectedConsoleErrors: [/^Failed to load resource: net::ERR_INTERNET_DISCONNECTED$/],
})

test('music that fails to load offers a retry that plays it', async ({ page }) => {
  await installAudioProbe(page)
  await page.route('**/audio/music/**', (route) => route.abort('internetdisconnected'))
  await page.clock.setFixedTime(T0)
  await page.goto('/')
  await waitForMapSettled(page)
  await answerWelcomeCard(page, { birthYear: YEAR - 30, consent: true, audio: 'Play our music' })

  const retry = page.getByRole('button', { name: /Tap to retry$/ })
  await expect(retry).toBeVisible()
  await expect.poll(() => audio.playing(page).then((p) => p.ambience)).not.toBeNull()

  await page.unroute('**/audio/music/**')
  await retry.click()
  await expect.poll(() => audio.playing(page).then((p) => p.music)).not.toBeNull()
  await expect(page.getByRole('button', { name: 'My own music' })).toHaveAccessibleDescription(
    /^♪ /,
  )
})

test('a runtime chunk that fails to load offers a retry that starts sound', async ({ page }) => {
  await installAudioProbe(page)
  await page.clock.setFixedTime(T0)
  await page.goto('/')
  await waitForMapSettled(page)
  await page.waitForLoadState('networkidle')
  // Offline from here on for scripts: the lazy runtime chunk cannot arrive.
  await page.route('**/_next/static/chunks/**', (route) => route.abort('internetdisconnected'))
  await answerWelcomeCard(page, { birthYear: YEAR - 30, consent: true, audio: "I'll bring my own" })

  const retry = page.getByRole('button', { name: /Tap to retry$/ })
  await expect(retry).toBeVisible()
  expect(await audio.ready(page)).toBe(false)

  await page.unroute('**/_next/static/chunks/**')
  await retry.click()
  await expect.poll(() => audio.ready(page)).toBe(true)
  await expect(page.getByRole('button', { name: 'My own music' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
})
