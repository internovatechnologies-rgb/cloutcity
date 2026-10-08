import AxeBuilder from '@axe-core/playwright'
import { test as base, expect, type ConsoleMessage, type Page } from '@playwright/test'
import { ONBOARDING_KEY, completedOnboardingSeed } from './onboarding-seed'
import { TOUR_KEY, doneTourSeed } from './tour-seed'

/**
 * Shared e2e fixture. Every spec imports `test` and `expect` from here, never from
 * @playwright/test directly, so every test gets:
 *  - a console guard (PERF-1): any console warning or error, or an uncaught page error, fails
 *    the test after it finishes, unless the test lists it in `expectedConsole` (and then it must
 *    appear);
 *  - `checkA11y()` (A11Y-2): an axe scan of the current page that fails on serious or critical
 *    violations;
 *  - a completed welcome card (S05a), so specs for other flows start like a returning player.
 *    Welcome-card specs opt out with `test.use({ onboarding: 'fresh' })`;
 *  - a finished first-run tour (S06), so no coach marks sit over other flows. Tour specs opt out
 *    with `test.use({ tour: 'fresh' })`;
 *  - a player who starts at home and must travel to a place before its actions work (S08,
 *    DEC-22). Specs about a place's own rules use `test.use({ location: 'follow' })`: every place
 *    picked (pin, Places panel, hook) then puts the player there, as if they had travelled
 *    (src/components/places/placeTestHook.ts).
 */

const FAILING_CONSOLE_TYPES = new Set<ReturnType<ConsoleMessage['type']>>([
  'warning',
  'error',
  'assert',
])

/**
 * Messages the browser itself emits that real players never see. Keep this list tiny and exact:
 * every entry must name the source and why it cannot reach a player.
 */
const IGNORED_CONSOLE_MESSAGES: readonly {
  readonly type: ReturnType<ConsoleMessage['type']>
  readonly text: RegExp
}[] = [
  // ANGLE performance note from SwiftShader, the CPU renderer headless Chromium uses for WebGL.
  // The software compositor reads every WebGL frame back, so any visible canvas logs it, even
  // with no readPixels call. Absent on a hardware GPU (checked with ANGLE Metal, 2026-10-06).
  // Ignored only at warning level: the same text as an error still fails. ANGLE appends
  // "(this message will no longer repeat)" to its last repeat, so that exact suffix is allowed.
  {
    type: 'warning',
    text: /^\[\.WebGL-0x[0-9a-f]+\]GL Driver Message \(OpenGL, Performance, GL_CLOSE_PATH_NV, High\): GPU stall due to ReadPixels(?: \(this message will no longer repeat\))?$/,
  },
  // Playwright's own stand-in for navigator.serviceWorker.register under `serviceWorkers:
  // 'block'` (playwright.config.ts, S04e). Only test browsers run it; the app logs the refused
  // registration at info and plays on.
  { type: 'warning', text: /^Service Worker registration blocked by Playwright$/ },
]

function isIgnored(message: ConsoleMessage): boolean {
  return IGNORED_CONSOLE_MESSAGES.some(
    (entry) => entry.type === message.type() && entry.text.test(message.text()),
  )
}

/**
 * A console message a test expects on purpose (a failure path it provokes). Matching messages
 * do not fail the guard, but each entry must actually appear, so an expectation can never hide
 * a path that silently stopped logging. Matched on the exact console type, and on the text:
 * a string must equal it exactly, a RegExp must match it. The text is the console text and,
 * for an object argument (a src/lib/log.ts record), that argument as JSON.
 */
export interface ExpectedConsoleMessage {
  readonly type: ReturnType<ConsoleMessage['type']>
  readonly text: string | RegExp
  /** How many times it must appear. Default: at least once. */
  readonly count?: number
}

function matchesText(expected: string | RegExp, text: string): boolean {
  return typeof expected === 'string' ? text === expected : expected.test(text)
}

/** The texts an expectation is matched against: the console text plus object arguments as JSON. */
async function candidateTexts(message: ConsoleMessage): Promise<string[]> {
  const texts = [message.text()]
  for (const arg of message.args()) {
    const value: unknown = await arg.jsonValue().catch(() => undefined)
    if (typeof value === 'object' && value !== null) texts.push(JSON.stringify(value))
  }
  return texts
}

const BLOCKING_IMPACTS = new Set(['serious', 'critical'])

export interface A11yOptions {
  /** CSS selectors to leave out of the scan. Use sparingly and say why at the call site. */
  readonly exclude?: readonly string[]
}

interface Fixtures {
  /**
   * `complete` (default) seeds a passed welcome card before every page load, unless the spec has
   * already stored its own; `fresh` leaves storage alone so the card shows.
   */
  onboarding: 'complete' | 'fresh'
  onboardingSeed: void
  /**
   * `done` (default) seeds a finished tour before every page load, unless the spec has already
   * stored its own; `fresh` leaves storage alone, so a fresh game starts the tour.
   */
  tour: 'done' | 'fresh'
  tourSeed: void
  /**
   * `home` (default): the player is where the save says (a new game starts at home) and travels
   * like a player. `follow`: picking a place puts the player there first.
   */
  location: 'home' | 'follow'
  locationSeed: void
  /**
   * How long the guard keeps listening after the test body ends, so late async warnings
   * (a failed fetch, an effect after the last assertion) still fail the test. Override with
   * `use: { consoleSettleMs }` in playwright.config.ts or `test.use()`.
   */
  consoleSettleMs: number
  /**
   * Console messages this test provokes on purpose (see {@link ExpectedConsoleMessage}).
   * Default none. Set with `test.use()` around the tests that need it. Playwright reads a
   * two-element array whose second element is an object as a `[value, options]` tuple, so wrap
   * the list: `test.use({ expectedConsole: [[first, second], { scope: 'test' }] })` (one entry
   * may be written `[entry]`).
   */
  expectedConsole: readonly ExpectedConsoleMessage[]
  /**
   * Console errors a spec causes on purpose, matched against the message text (errors only).
   * Only for a failure the test itself injects, such as a request it aborts: Chromium reports
   * that as "Failed to load resource". Set with `test.use()` around that test alone.
   */
  injectedConsoleErrors: readonly RegExp[]
  consoleGuard: void
  checkA11y: (options?: A11yOptions) => Promise<void>
}

export const test = base.extend<Fixtures>({
  consoleSettleMs: [250, { option: true }],
  expectedConsole: [[], { option: true }],

  injectedConsoleErrors: [[], { option: true }],

  onboarding: ['complete', { option: true }],

  onboardingSeed: [
    async ({ page, onboarding }, use) => {
      if (onboarding === 'complete') {
        await page.addInitScript(
          ({ key, value }) => {
            // Storage can throw (opaque origins, specs that make it throw on purpose).
            try {
              if (localStorage.getItem(key) === null) localStorage.setItem(key, value)
            } catch {
              // Nothing to seed: the app shows the card, as it would for that player.
            }
          },
          { key: ONBOARDING_KEY, value: JSON.stringify(completedOnboardingSeed()) },
        )
      }
      await use()
    },
    { auto: true },
  ],

  tour: ['done', { option: true }],

  tourSeed: [
    async ({ page, tour }, use) => {
      if (tour === 'done') {
        await page.addInitScript(
          ({ key, value }) => {
            // Storage can throw (opaque origins, specs that make it throw on purpose).
            try {
              if (localStorage.getItem(key) === null) localStorage.setItem(key, value)
            } catch {
              // Nothing to seed: a fresh game starts the tour, as it would for that player.
            }
          },
          { key: TOUR_KEY, value: JSON.stringify(doneTourSeed()) },
        )
      }
      await use()
    },
    { auto: true },
  ],

  location: ['home', { option: true }],

  locationSeed: [
    async ({ page, location }, use) => {
      if (location === 'follow') {
        // The follow mode lives in the place test hook, which installs only on an e2e page.
        await page.addInitScript(() => {
          window.__CLOUTCITY_E2E__ = true
          window.__CLOUTCITY_E2E_LOCATION__ = 'follow'
        })
      }
      await use()
    },
    { auto: true },
  ],

  consoleGuard: [
    async ({ page, consoleSettleMs, expectedConsole, injectedConsoleErrors }, use) => {
      const problems: string[] = []
      // Messages checked against `expectedConsole` once the test ends (their JSON arguments are
      // read asynchronously, so they are collected as promises while the page is open).
      const candidates: Promise<{ type: string; texts: string[]; report: string }>[] = []
      page.on('console', (message) => {
        if (!FAILING_CONSOLE_TYPES.has(message.type())) return
        if (isIgnored(message)) return
        if (
          message.type() === 'error' &&
          injectedConsoleErrors.some((pattern) => pattern.test(message.text()))
        ) {
          return
        }
        const { url, lineNumber } = message.location()
        const report = `console.${message.type()}: ${message.text()} (${url}:${lineNumber})`
        if (expectedConsole.length === 0) {
          problems.push(report)
          return
        }
        candidates.push(
          candidateTexts(message).then((texts) => ({ type: message.type(), texts, report })),
        )
      })
      page.on('pageerror', (error) => problems.push(`uncaught: ${error.name}: ${error.message}`))

      await use()

      // Let the page settle while it is still open: two animation frames flush pending
      // renders and effects, then a short fixed window catches timers and network callbacks.
      if (!page.isClosed()) {
        await page
          .evaluate(
            () =>
              new Promise<void>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
              ),
          )
          // A test may leave the page mid-navigation; the timed wait below still applies.
          .catch(() => undefined)
        await page.waitForTimeout(consoleSettleMs)
      }

      const seen = expectedConsole.map(() => 0)
      for (const candidate of await Promise.all(candidates)) {
        const index = expectedConsole.findIndex(
          (entry) =>
            entry.type === candidate.type &&
            candidate.texts.some((text) => matchesText(entry.text, text)),
        )
        if (index === -1) problems.push(candidate.report)
        else seen[index] = (seen[index] ?? 0) + 1
      }
      expectedConsole.forEach((entry, index) => {
        const times = seen[index] ?? 0
        const ok = entry.count === undefined ? times > 0 : times === entry.count
        if (!ok) {
          problems.push(
            `expected console.${entry.type} ${String(entry.text)} ${entry.count ?? 'at least 1'} time(s), saw ${times}`,
          )
        }
      })

      expect(problems, 'console warnings/errors are not allowed (PERF-1)').toEqual([])
    },
    { auto: true },
  ],

  checkA11y: async ({ page }, use) => {
    await use(async (options = {}) => {
      let builder = new AxeBuilder({ page })
      for (const selector of options.exclude ?? []) builder = builder.exclude(selector)
      const { violations } = await builder.analyze()
      const blocking = violations
        .filter((violation) => BLOCKING_IMPACTS.has(violation.impact ?? ''))
        .map((violation) => ({
          rule: violation.id,
          impact: violation.impact,
          help: violation.help,
          targets: violation.nodes.map((node) => node.target.join(' ')),
        }))
      expect(blocking, 'serious or critical accessibility violations (A11Y-2)').toEqual([])
    })
  },
})

/**
 * Waits until the welcome boot island has loaded and decided (S05c): until then the page is
 * inert behind its loading card, so keyboard and hit-testing steps must wait for this. Clicks
 * wait on their own (Playwright retries until the target receives the click).
 */
export async function waitForWelcomeGate(page: Page): Promise<void> {
  await page.locator('[data-welcome-gate]').waitFor({ state: 'attached' })
  // The marker commits before the loading card's modal presence is released (a later effect),
  // so for a closed gate also wait for the page to leave `inert`: a focus() in between is lost.
  await page.waitForFunction(
    () =>
      document.querySelector('[data-welcome-dialog]') !== null ||
      document.querySelector('[data-overlay-background]:not([inert])') !== null,
  )
}

export { expect }
