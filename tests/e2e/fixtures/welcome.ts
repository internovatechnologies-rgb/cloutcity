import type { Locator, Page } from '@playwright/test'
import { ONBOARDING_KEY } from './onboarding-seed'

/**
 * Helpers for welcome-card specs (S05a). Specs that use them run with
 * `test.use({ onboarding: 'fresh' })` so the card shows.
 */

/** Midday in New York on 15 June 2026: the year is 2026 in every time zone. */
export const T0 = Date.UTC(2026, 5, 15, 16)
export const YEAR = 2026
export const DAY_MS = 86_400_000

export const WELCOME_TITLE = 'Welcome to Clout City'
export const LOCK_TITLE = "Come back when you're 18."

export const welcomeDialog = (page: Page): Locator =>
  page.getByRole('dialog', { name: WELCOME_TITLE })
export const lockDialog = (page: Page): Locator => page.getByRole('dialog', { name: LOCK_TITLE })

export interface WelcomeAnswers {
  readonly birthYear?: number
  readonly consent?: boolean
  readonly audio?: 'Play our music' | "I'll bring my own"
}

/** Fills the card by clicking the native controls, then submits it. */
export async function answerWelcomeCard(page: Page, answers: WelcomeAnswers): Promise<void> {
  const dialog = welcomeDialog(page)
  if (answers.birthYear !== undefined) {
    await dialog
      .getByRole('combobox', { name: 'Year you were born' })
      .selectOption(String(answers.birthYear))
  }
  if (answers.consent) await dialog.getByRole('checkbox').check()
  if (answers.audio !== undefined) await dialog.getByRole('radio', { name: answers.audio }).check()
  await dialog.getByRole('button', { name: 'Start playing' }).click()
}

/** Passes the card as an adult (used where a spec needs the shell behind it). */
export async function passWelcomeCard(page: Page): Promise<void> {
  await answerWelcomeCard(page, { birthYear: YEAR - 30, consent: true, audio: "I'll bring my own" })
  await welcomeDialog(page).waitFor({ state: 'detached' })
}

/** The stored onboarding envelope, or null. */
export async function storedOnboarding(page: Page): Promise<unknown> {
  return page.evaluate((key) => {
    const raw = localStorage.getItem(key)
    return raw === null ? null : (JSON.parse(raw) as unknown)
  }, ONBOARDING_KEY)
}

/** Collects every request to another origin (the app must make none here). */
export function trackCrossOriginRequests(page: Page, baseURL: string | undefined): string[] {
  const origin = new URL(baseURL ?? 'http://localhost').origin
  const found: string[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return
    if (url.origin !== origin) found.push(request.url())
  })
  return found
}

/** Keys a Supabase client would write (`sb-<ref>-auth-token`, ...). */
export async function supabaseStorageKeys(page: Page): Promise<string[]> {
  return page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith('sb-')))
}

/** One console call as the page made it: its type and its arguments as JSON text. */
export interface ConsoleCall {
  readonly type: string
  readonly text: string
}

/**
 * Records every console call with its arguments serialised (the app logs structured objects,
 * whose `text()` is only a preview). Await `settle()` before reading `calls`.
 */
export function captureConsole(page: Page): { calls: ConsoleCall[]; settle: () => Promise<void> } {
  const calls: ConsoleCall[] = []
  const pending: Promise<void>[] = []
  page.on('console', (message) => {
    pending.push(
      Promise.all(message.args().map((arg) => arg.jsonValue().catch(() => message.text())))
        .then((args) => {
          calls.push({ type: message.type(), text: JSON.stringify(args) })
        })
        .catch(() => {
          calls.push({ type: message.type(), text: message.text() })
        }),
    )
  })
  return { calls, settle: async () => void (await Promise.all(pending)) }
}

/** Writes `value` under the onboarding key before the first load only (later loads keep what the app stored). */
export async function seedOnboardingOnce(page: Page, value: unknown): Promise<void> {
  await page.addInitScript(
    ({ key, raw }) => {
      if (sessionStorage.getItem('__seeded__') !== null) return
      sessionStorage.setItem('__seeded__', '1')
      localStorage.setItem(key, raw)
    },
    { key: ONBOARDING_KEY, raw: typeof value === 'string' ? value : JSON.stringify(value) },
  )
}
