import type { Page } from '@playwright/test'
import { expect, test, waitForWelcomeGate } from './fixtures/test'
import { SILENT, audio, installAudioProbe, probeOf, trackAudioRequests } from './fixtures/audio'
import { T0, YEAR, welcomeDialog } from './fixtures/welcome'
import { waitForMapSettled } from './helpers/scene'
import { openFromHud } from './helpers/hud'

// GR-13 edges (S05b): which gestures count as the deliberate tap on the sound choice, and how
// sound comes back after the browser suspends it. The shared fixture seeds a returning player
// with "I'll bring my own"; fresh-card tests opt out.

/** Keeps every AudioContext the page creates, so a test can suspend it like the OS would. */
async function keepContexts(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const kept: AudioContext[] = []
    Object.defineProperty(window, '__keptContexts', { value: kept })
    const Original = window.AudioContext
    window.AudioContext = class extends Original {
      constructor(options?: AudioContextOptions) {
        super(options)
        kept.push(this)
      }
    }
  })
}

const turnOn = (page: Page) => page.getByRole('button', { name: 'Turn on sound' })

for (const key of ['Enter', 'Space'] as const) {
  test(`${key} on the focused sound control turns sound on`, async ({ page }) => {
    await installAudioProbe(page)
    await page.goto('/')
    await waitForMapSettled(page)
    // The page is inert until the welcome island decides; a focus() before that is lost.
    await waitForWelcomeGate(page)
    await turnOn(page).focus()
    expect(await probeOf(page)).toEqual(SILENT)
    await page.keyboard.press(key)
    await expect.poll(() => probeOf(page).then((p) => p.contexts)).toBe(1)
    await expect.poll(() => audio.ready(page)).toBe(true)
    expect(await audio.contextState(page)).toBe('running')
    // The first press only turns sound on; it does not flip the remembered choice.
    await expect(page.getByRole('button', { name: 'My own music' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })
}

test('under "My own music" no music file is fetched, even after sound is on', async ({ page }) => {
  await installAudioProbe(page)
  const requests = trackAudioRequests(page)
  await page.goto('/')
  await waitForMapSettled(page)
  await turnOn(page).click()
  await expect.poll(() => audio.ready(page)).toBe(true)
  await expect.poll(() => audio.playing(page).then((p) => p.ambience)).not.toBeNull()
  await audio.playSfx(page, 'ui-tap')
  await expect.poll(() => audio.sfxStarted(page)).toBeGreaterThan(0)
  expect(requests.length).toBeGreaterThan(0)
  expect(requests.filter((url) => url.includes('/audio/music/'))).toEqual([])
})

test('keyboard arrows on a volume slider while sound is off are a deliberate choice', async ({
  page,
}) => {
  await installAudioProbe(page)
  await page.goto('/')
  await waitForMapSettled(page)
  await openFromHud(page, 'Settings')
  const sheet = page.getByRole('region', { name: 'Settings' })
  await expect(sheet).toBeVisible()
  expect(await probeOf(page)).toEqual(SILENT)
  const voice = sheet.getByRole('slider', { name: 'Voice' })
  await voice.focus()
  expect(await probeOf(page), 'focusing a slider is not a change').toEqual(SILENT)
  await page.keyboard.press('ArrowRight')
  await expect(voice).toHaveValue('85')
  await expect.poll(() => probeOf(page).then((p) => p.contexts)).toBe(1)
  await expect.poll(() => audio.ready(page)).toBe(true)
  expect(await audio.contextState(page)).toBe('running')
})

test('the "My own music" checkbox while sound is off turns sound on with music playing', async ({
  page,
}) => {
  await installAudioProbe(page)
  await page.goto('/')
  await waitForMapSettled(page)
  await openFromHud(page, 'Settings')
  const checkbox = page
    .getByRole('region', { name: 'Settings' })
    .getByRole('checkbox', { name: 'My own music' })
  await expect(checkbox).toBeChecked()
  await checkbox.uncheck()
  await expect.poll(() => probeOf(page).then((p) => p.contexts)).toBe(1)
  await expect.poll(() => audio.ready(page)).toBe(true)
  await expect.poll(() => audio.playing(page).then((p) => p.music)).not.toBeNull()
  expect((await audio.targetGains(page)).music).toBeGreaterThan(0)
})

test('after the browser suspends sound, the control offers "Tap for sound" and one tap resumes', async ({
  page,
}) => {
  await keepContexts(page)
  await installAudioProbe(page)
  await page.goto('/')
  await waitForMapSettled(page)
  await turnOn(page).click()
  await expect.poll(() => audio.ready(page)).toBe(true)
  const toggle = page.getByRole('button', { name: 'My own music' })
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')

  // What iOS does for a phone call or Safari for a backgrounded tab.
  await page.evaluate(() =>
    (window as unknown as { __keptContexts: AudioContext[] }).__keptContexts[0]?.suspend(),
  )
  await expect(turnOn(page)).toContainText('Tap for sound')
  await expect(turnOn(page)).toHaveAccessibleDescription('Your music')
  expect(await audio.contextState(page)).toBe('suspended')

  await turnOn(page).click()
  await expect.poll(() => audio.contextState(page)).toBe('running')
  // That tap only resumed: the choice is unchanged and there is still one context.
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  expect((await probeOf(page)).contexts).toBe(1)
})

test.describe('first visit', () => {
  test.use({ onboarding: 'fresh' })

  test('a double-clicked submit creates exactly one audio context', async ({ page }) => {
    await installAudioProbe(page)
    await page.clock.setFixedTime(T0)
    await page.goto('/')
    await waitForMapSettled(page)
    const dialog = welcomeDialog(page)
    await dialog.getByRole('combobox', { name: 'Year you were born' }).selectOption(`${YEAR - 30}`)
    await dialog.getByRole('checkbox').check()
    await dialog.getByRole('radio', { name: 'Play our music' }).check()
    await dialog.getByRole('button', { name: 'Start playing' }).dblclick()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect.poll(() => audio.ready(page)).toBe(true)
    await expect.poll(() => audio.playing(page).then((p) => p.music)).not.toBeNull()
    expect(await probeOf(page)).toEqual({ contexts: 1, mediaElements: 0, plays: 0 })
  })

  test('the HUD sound control and settings never unlock behind the welcome card', async ({
    page,
  }) => {
    await installAudioProbe(page)
    const requests = trackAudioRequests(page)
    await page.clock.setFixedTime(T0)
    await page.goto('/')
    await waitForMapSettled(page)
    await expect(welcomeDialog(page)).toBeVisible()
    // The control is there (its boot island has loaded), but the card is modal: the HUD behind
    // it is inert, so these clicks cannot reach it.
    await expect(turnOn(page)).toBeAttached()
    await turnOn(page)
      .click({ timeout: 1000, force: true })
      .catch(() => undefined)
    await page.keyboard.press('Tab')
    await page.keyboard.press('Enter')
    expect(await probeOf(page)).toEqual(SILENT)
    expect(requests).toEqual([])
  })
})
