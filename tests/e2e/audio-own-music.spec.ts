import type { Page } from '@playwright/test'
import { expect, test } from './fixtures/test'
import { audio, gainOf, installAudioProbe, trackAudioRequests } from './fixtures/audio'
import { T0, YEAR, answerWelcomeCard } from './fixtures/welcome'
import { waitForMapSettled } from './helpers/scene'

// "My own music" mutes our music only: sound effects and city sounds keep playing (S05b).

test.use({ onboarding: 'fresh' })

async function start(page: Page, choice: 'Play our music' | "I'll bring my own") {
  await installAudioProbe(page)
  const requests = trackAudioRequests(page)
  await page.clock.setFixedTime(T0)
  await page.goto('/')
  await waitForMapSettled(page)
  await answerWelcomeCard(page, { birthYear: YEAR - 30, consent: true, audio: choice })
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect.poll(() => audio.ready(page)).toBe(true)
  await expect.poll(() => audio.playing(page).then((p) => p.ambience)).not.toBeNull()
  return requests
}

test('"I\'ll bring my own": music silent and never fetched; ambience and sfx play', async ({
  page,
}) => {
  const requests = await start(page, "I'll bring my own")
  const target = await audio.targetGains(page)
  expect(target.music).toBe(0)
  expect(target.sfx).toBeGreaterThan(0)
  expect(target.ambience).toBeGreaterThan(0)
  expect((await audio.gains(page)).music).toBe(0)
  expect((await audio.playing(page)).music).toBeNull()

  await audio.playSfx(page, 'ui-tap')
  await expect.poll(() => audio.sfxStarted(page)).toBeGreaterThan(0)
  expect(requests.filter((url) => url.includes('/audio/music/'))).toEqual([])

  const control = page.getByRole('button', { name: 'My own music' })
  await expect(control).toHaveAttribute('aria-pressed', 'true')
  await expect(control).toHaveAccessibleDescription('Your music')
})

test('the HUD toggle mutes only the music, shows "Your music", and toggles back', async ({
  page,
}) => {
  await start(page, 'Play our music')
  await expect.poll(() => audio.playing(page).then((p) => p.music)).not.toBeNull()
  const control = page.getByRole('button', { name: 'My own music' })
  await expect(control).toHaveAttribute('aria-pressed', 'false')
  await expect(control).toHaveAccessibleDescription(/^♪ .+ by .+$/)
  await expect.poll(() => audio.gains(page).then((g) => g.music)).toBe(gainOf(60))
  const before = await audio.gains(page)
  const targetBefore = await audio.targetGains(page)

  await control.click()
  await expect(control).toHaveAttribute('aria-pressed', 'true')
  await expect(control).toHaveAccessibleDescription('Your music')
  await expect(control).toContainText('Your music')
  expect(await audio.targetGains(page)).toEqual({ ...targetBefore, music: 0 })
  await expect.poll(() => audio.playing(page).then((p) => p.music)).toBeNull()
  // The music source stops once the ramp is down, so the browser stops processing the music
  // node and its live value freezes just above 0: the channel is silent either way.
  await expect.poll(() => audio.gains(page).then((g) => g.music)).toBeLessThan(0.001)
  const muted = await audio.gains(page)
  expect({ ...muted, music: before.music }).toEqual(before)
  await expect.poll(() => audio.sfxStarted(page)).toBeGreaterThan(0)

  await control.click()
  await expect(control).toHaveAttribute('aria-pressed', 'false')
  await expect.poll(() => audio.gains(page).then((g) => g.music)).toBe(before.music)
  await expect.poll(() => audio.playing(page).then((p) => p.music)).not.toBeNull()
  expect(await audio.gains(page)).toEqual(before)
})

test('a quick double tap on the HUD toggle while the first track loads still ends with our music', async ({
  page,
}) => {
  // A slow network: music files take a while, so the taps land while the first track loads.
  await page.route('**/audio/music/**', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    await route.continue()
  })
  await start(page, 'Play our music')
  const control = page.getByRole('button', { name: 'My own music' })
  await expect(control).toHaveAttribute('aria-pressed', 'false')
  expect((await audio.playing(page)).music).toBeNull()

  await control.click()
  await control.click()
  await expect(control).toHaveAttribute('aria-pressed', 'false')
  // targetGains() is the exact mixer value (not a float32 AudioParam).
  expect((await audio.targetGains(page)).music).toBe((60 / 100) ** 2)
  await expect.poll(() => audio.playing(page).then((p) => p.music)).not.toBeNull()
  await expect(control).toHaveAccessibleDescription(/^♪ .+ by .+$/)
})
