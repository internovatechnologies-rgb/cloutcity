import { expect, test } from './fixtures/test'
import { SILENT, audio, installAudioProbe, probeOf, trackAudioRequests } from './fixtures/audio'
import { T0, YEAR, answerWelcomeCard, welcomeDialog } from './fixtures/welcome'

// GR-13 / CLAUDE.md "Sound is the player's choice": no AudioContext is created and no audio is
// requested before the audio choice. Submitting a passing card is the deliberate tap that turns
// sound on: one context, Web Audio only (no media elements), and only our own files.

test.use({ onboarding: 'fresh' })

for (const choice of ['Play our music', "I'll bring my own"] as const) {
  test(`silent before the choice; "${choice}" turns sound on from the submit only`, async ({
    page,
    baseURL,
  }) => {
    await installAudioProbe(page)
    const requests = trackAudioRequests(page)
    await page.clock.setFixedTime(T0)
    await page.goto('/')
    await expect(welcomeDialog(page)).toBeVisible()
    expect(await probeOf(page)).toEqual(SILENT)

    // Picking a radio is a user gesture, the moment autoplay rules would allow audio.
    await welcomeDialog(page).getByRole('radio', { name: choice }).check()
    expect(await probeOf(page)).toEqual(SILENT)
    expect(requests).toEqual([])

    await answerWelcomeCard(page, { birthYear: YEAR - 30, consent: true, audio: choice })
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect.poll(() => probeOf(page)).toEqual({ contexts: 1, mediaElements: 0, plays: 0 })

    await expect.poll(() => audio.ready(page)).toBe(true)
    expect(await audio.contextState(page)).toBe('running')
    await expect.poll(() => audio.playing(page).then((p) => p.ambience)).not.toBeNull()
    if (choice === 'Play our music') {
      expect((await audio.targetGains(page)).music).toBeGreaterThan(0)
      await expect.poll(() => audio.gains(page).then((g) => g.music)).toBeGreaterThan(0)
      await expect.poll(() => audio.playing(page).then((p) => p.music)).not.toBeNull()
    }

    const origin = new URL(baseURL ?? 'http://localhost').origin
    expect(requests.length).toBeGreaterThan(0)
    for (const url of requests) {
      const parsed = new URL(url)
      expect(parsed.origin, url).toBe(origin)
      expect(parsed.pathname.startsWith('/audio/'), url).toBe(true)
    }
    expect((await probeOf(page)).contexts).toBe(1)
  })
}

test('an invalid or under-18 submit never turns sound on', async ({ page }) => {
  await installAudioProbe(page)
  const requests = trackAudioRequests(page)
  await page.clock.setFixedTime(T0)
  await page.goto('/')
  await answerWelcomeCard(page, { birthYear: YEAR - 30, audio: 'Play our music' })
  await expect(welcomeDialog(page)).toBeVisible()
  expect(await probeOf(page)).toEqual(SILENT)
  await answerWelcomeCard(page, { birthYear: YEAR - 10, consent: true, audio: 'Play our music' })
  await expect(page.getByRole('dialog', { name: "Come back when you're 18." })).toBeVisible()
  expect(await probeOf(page)).toEqual(SILENT)
  expect(requests).toEqual([])
})

test('the probe itself sees an AudioContext and an <audio> element (self-check)', async ({
  page,
}) => {
  await installAudioProbe(page)
  await page.goto('/')
  await page.evaluate(() => {
    void new AudioContext().close()
    document.body.append(document.createElement('audio'))
  })
  await expect.poll(() => probeOf(page)).toEqual({ contexts: 1, mediaElements: 1, plays: 0 })
})
