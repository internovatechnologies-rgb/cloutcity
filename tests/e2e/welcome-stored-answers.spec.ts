import { completedOnboardingSeed } from './fixtures/onboarding-seed'
import { expect, test } from './fixtures/test'
import {
  DAY_MS,
  T0,
  captureConsole,
  lockDialog,
  passWelcomeCard,
  seedOnboardingOnce,
  storedOnboarding,
  welcomeDialog,
} from './fixtures/welcome'

// S05a: what the welcome gate does with what this device already stored. Stored data is
// untrusted: a newer build's record is respected but never overwritten, a lock is never
// weakened, and anything unreadable shows the card (logged at info, never a warning).

test.use({ onboarding: 'fresh' })

const LOCKED_UNTIL = T0 + DAY_MS
const lockedRecord = { status: 'locked', lockedUntil: LOCKED_UNTIL } as const

test.describe('a record written by a newer build (version 2)', () => {
  test('a complete record skips the card and is never overwritten', async ({ page }) => {
    const value = {
      state: { record: { ...completedOnboardingSeed().state.record, futureField: 'x' }, more: 1 },
      version: 2,
    }
    await seedOnboardingOnce(page, value)
    await page.clock.setFixedTime(T0)
    await page.goto('/')
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await page.reload()
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(await storedOnboarding(page)).toEqual(value)
  })

  test('a lock holds, survives the clock going back, and is never overwritten', async ({
    page,
  }) => {
    const value = { state: { record: { ...lockedRecord, reason: 'future' } }, version: 2 }
    await seedOnboardingOnce(page, value)
    await page.clock.setFixedTime(T0)
    await page.goto('/')
    await expect(lockDialog(page)).toBeVisible()
    await page.clock.setFixedTime(T0 - 30 * DAY_MS)
    await page.reload()
    await expect(lockDialog(page)).toBeVisible()
    expect(await storedOnboarding(page)).toEqual(value)
  })

  test('once its lock has run out the card shows; completing it stays in memory only', async ({
    page,
  }) => {
    const value = { state: { record: lockedRecord }, version: 2 }
    await seedOnboardingOnce(page, value)
    await page.clock.setFixedTime(LOCKED_UNTIL)
    await page.goto('/')
    await passWelcomeCard(page)
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible()
    // The newer build's record is left as it was.
    expect(await storedOnboarding(page)).toEqual(value)
  })
})

test('the lock holds 1 ms before lockedUntil and ends exactly at it', async ({ page }) => {
  await seedOnboardingOnce(page, { state: { record: lockedRecord }, version: 1 })
  await page.clock.setFixedTime(LOCKED_UNTIL - 1)
  await page.goto('/')
  await expect(lockDialog(page)).toBeVisible()
  expect(await storedOnboarding(page)).toEqual({ state: { record: lockedRecord }, version: 1 })

  await page.clock.setFixedTime(LOCKED_UNTIL)
  await page.reload()
  await expect(welcomeDialog(page)).toBeVisible()
  await expect(lockDialog(page)).toHaveCount(0)
  await expect(welcomeDialog(page).getByRole('combobox')).toHaveValue('')
  expect(await storedOnboarding(page)).toEqual({ state: { record: null }, version: 1 })
})

const CORRUPT: readonly (readonly [string, unknown])[] = [
  ['not JSON', '{not json'],
  ['a wrong envelope', { nope: true }],
  ['an unknown status', { state: { record: { status: 'maybe' } }, version: 1 }],
  [
    'a stored birth year',
    {
      state: { record: { ...completedOnboardingSeed().state.record, birthYear: 1990 } },
      version: 1,
    },
  ],
  ['a negative lock', { state: { record: { status: 'locked', lockedUntil: -5 } }, version: 1 }],
  ['a string version', { state: { record: null }, version: 'two' }],
]

for (const [label, value] of CORRUPT) {
  test(`a stored record with ${label} shows the card, logged at info only`, async ({ page }) => {
    const console = captureConsole(page)
    await seedOnboardingOnce(page, value)
    await page.clock.setFixedTime(T0)
    await page.goto('/')
    await expect(welcomeDialog(page)).toBeVisible()
    await console.settle()
    // The console guard fails the test on any warning or error; there is an info record.
    expect(console.calls.filter((call) => call.type === 'info').length).toBeGreaterThan(0)
    await passWelcomeCard(page)
    expect(await storedOnboarding(page)).toMatchObject({
      state: { record: { status: 'complete' } },
      version: 1,
    })
  })
}

test('when saving throws (full quota) the card still completes, and shows again next load', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const setItem = Storage.prototype.setItem
    Storage.prototype.setItem = function (this: Storage, key: string, value: string) {
      if (key.startsWith('cloutcity:')) {
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
      }
      setItem.call(this, key, value)
    }
  })
  await page.clock.setFixedTime(T0)
  await page.goto('/')
  await passWelcomeCard(page)
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible()
  expect(await storedOnboarding(page)).toBeNull()
  await page.reload()
  await expect(welcomeDialog(page)).toBeVisible()
})
