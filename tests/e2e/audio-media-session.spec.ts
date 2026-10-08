import { expect, test } from './fixtures/test'
import { audio, installAudioProbe, probeOf } from './fixtures/audio'
import { T0, YEAR, answerWelcomeCard } from './fixtures/welcome'
import { waitForMapSettled } from './helpers/scene'

// Our sounds never take over the media session: no metadata, no playback state, no media
// elements, so the player's own music app keeps its lock-screen controls (S05b).

test.use({ onboarding: 'fresh' })

test('music plays without claiming the media session', async ({ page }) => {
  await installAudioProbe(page)
  await page.clock.setFixedTime(T0)
  await page.goto('/')
  await waitForMapSettled(page)
  await answerWelcomeCard(page, { birthYear: YEAR - 30, consent: true, audio: 'Play our music' })
  await expect.poll(() => audio.ready(page)).toBe(true)
  await expect.poll(() => audio.playing(page).then((p) => p.music)).not.toBeNull()

  const session = await page.evaluate(() => ({
    metadata: navigator.mediaSession.metadata,
    playbackState: navigator.mediaSession.playbackState,
  }))
  expect(session).toEqual({ metadata: null, playbackState: 'none' })
  expect((await probeOf(page)).mediaElements).toBe(0)
  expect((await probeOf(page)).plays).toBe(0)
})

test('after a crossfade to the next track, still no media session and no media elements', async ({
  page,
}) => {
  await installAudioProbe(page)
  await page.clock.install({ time: T0 })
  await page.goto('/')
  await waitForMapSettled(page)
  await answerWelcomeCard(page, { birthYear: YEAR - 30, consent: true, audio: 'Play our music' })
  await expect.poll(() => audio.ready(page)).toBe(true)
  await expect.poll(() => audio.playing(page).then((p) => p.music)).not.toBeNull()
  const first = (await audio.playing(page)).music

  // Past the play time of a track (data/config/audio.json musicTrackPlaySeconds).
  await page.clock.fastForward('03:05')
  await expect.poll(() => audio.playing(page).then((p) => p.music)).not.toBe(first)

  const session = await page.evaluate(() => ({
    metadata: navigator.mediaSession.metadata,
    playbackState: navigator.mediaSession.playbackState,
  }))
  expect(session).toEqual({ metadata: null, playbackState: 'none' })
  expect(await probeOf(page)).toEqual({ contexts: 1, mediaElements: 0, plays: 0 })
  await expect(page.getByRole('button', { name: 'My own music' })).toHaveAccessibleDescription(
    /^♪ .+ by .+$/,
  )
})
