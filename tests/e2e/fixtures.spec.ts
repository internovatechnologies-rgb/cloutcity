import type { Page } from '@playwright/test'
import { completedOnboardingSeed } from './fixtures/onboarding-seed'
import { expect, test } from './fixtures/test'
import { storedOnboarding, welcomeDialog } from './fixtures/welcome'

// Self-tests for the shared fixture: a guard that never fires is worse than none.

test.describe('shared e2e fixture', () => {
  test('console guard fails a test that logs a warning (PERF-1)', async ({ page }) => {
    // Expected to fail: if the guard ever stops catching warnings, this test "passes" and the
    // run goes red.
    test.fail()
    await page.goto('/')
    await page.evaluate(() => {
      // eslint-disable-next-line no-console -- deliberately provoking the guard
      console.warn('fixture self-test warning')
    })
  })

  test('console guard fails a test with an uncaught page error (PERF-1)', async ({ page }) => {
    test.fail()
    await page.goto('/')
    await page.evaluate(() => {
      setTimeout(() => {
        throw new Error('fixture self-test error')
      }, 0)
    })
    await page.waitForTimeout(50)
  })

  test('checkA11y rejects a serious violation (A11Y-2)', async ({ page, checkA11y }) => {
    await page.setContent(
      '<!doctype html><html lang="en"><head><title>probe</title></head><body><main><button></button></main></body></html>',
    )
    await expect(checkA11y()).rejects.toThrow(/button-name/)
  })
})

// The real SwiftShader note the guard ignores, with a sample context address.
const SWIFTSHADER_NOTE =
  '[.WebGL-0x7a1c00b9e300]GL Driver Message (OpenGL, Performance, GL_CLOSE_PATH_NV, High): GPU stall due to ReadPixels'

test.describe('console guard coverage (PERF-1)', () => {
  test('fails on a warning logged after a client-side navigation', async ({ page }) => {
    test.fail()
    await page.goto('/')
    await page.evaluate(() => {
      history.pushState({}, '', '/?tab=shop')
      // eslint-disable-next-line no-console -- deliberately provoking the guard
      console.warn('warning after client-side navigation')
    })
    await expect(page).toHaveURL(/\?tab=shop$/)
  })

  test('fails on a warning logged after a second full navigation', async ({ page }) => {
    test.fail()
    await page.goto('/')
    await page.goto('/?again=1')
    await page.evaluate(() => {
      // eslint-disable-next-line no-console -- deliberately provoking the guard
      console.warn('warning after reload')
    })
  })

  test('fails on an uncaught promise rejection', async ({ page }) => {
    test.fail()
    await page.goto('/')
    await page.evaluate(() => {
      void Promise.reject(new Error('fixture self-test rejection'))
    })
    await page.waitForTimeout(50)
  })

  test('fails on a failed console.assert', async ({ page }) => {
    test.fail()
    await page.goto('/')
    await page.evaluate(() => {
      // eslint-disable-next-line no-console -- deliberately provoking the guard
      console.assert(false, 'fixture self-test assert')
    })
  })

  test('fails on console.error emitted as the test body ends (teardown)', async ({ page }) => {
    test.fail()
    await page.goto('/')
    // Scheduled, not awaited: the error lands while the fixture is tearing down.
    await page.evaluate(() => {
      setTimeout(() => {
        // eslint-disable-next-line no-console -- deliberately provoking the guard
        console.error('fixture self-test late error')
      }, 0)
    })
  })

  test('ignores the exact SwiftShader ReadPixels note', async ({ page }) => {
    await page.goto('/')
    await page.evaluate((note) => {
      // eslint-disable-next-line no-console -- reproducing the browser's own message
      console.warn(note)
    }, SWIFTSHADER_NOTE)
  })

  test('ignores the SwiftShader note with the exact ANGLE "no longer repeat" suffix', async ({
    page,
  }) => {
    await page.goto('/')
    await page.evaluate((note) => {
      // eslint-disable-next-line no-console -- reproducing the browser's own message
      console.warn(note)
    }, `${SWIFTSHADER_NOTE} (this message will no longer repeat)`)
  })

  test('does not ignore the suffixed note when logged as an error', async ({ page }) => {
    test.fail()
    await page.goto('/')
    await page.evaluate((note) => {
      // eslint-disable-next-line no-console -- deliberately provoking the guard
      console.error(note)
    }, `${SWIFTSHADER_NOTE} (this message will no longer repeat)`)
  })

  const nearMisses: ReadonlyArray<readonly [string, string]> = [
    [
      'a different GL Driver Message',
      SWIFTSHADER_NOTE.replace('GPU stall due to ReadPixels', 'GPU stall due to glFinish'),
    ],
    ['the note with trailing content', `${SWIFTSHADER_NOTE}; then something else broke`],
    ['the note with leading content', `Error: ${SWIFTSHADER_NOTE}`],
    ['the note followed by a second line', `${SWIFTSHADER_NOTE}\nTypeError: x is undefined`],
    ['the note with another severity', SWIFTSHADER_NOTE.replace('High)', 'Medium)')],
    ['the note without a context address', SWIFTSHADER_NOTE.replace(/^\[[^\]]+\]/, '')],
    [
      'the suffixed note with trailing content',
      `${SWIFTSHADER_NOTE} (this message will no longer repeat); then something else broke`,
    ],
    ['a different parenthesised suffix', `${SWIFTSHADER_NOTE} (this message will repeat)`],
    ['the suffix without its space', `${SWIFTSHADER_NOTE}(this message will no longer repeat)`],
    [
      'the suffix twice',
      `${SWIFTSHADER_NOTE} (this message will no longer repeat) (this message will no longer repeat)`,
    ],
  ]
  for (const [label, text] of nearMisses) {
    test(`does not ignore ${label}`, async ({ page }) => {
      test.fail()
      await page.goto('/')
      await page.evaluate((message) => {
        // eslint-disable-next-line no-console -- deliberately provoking the guard
        console.warn(message)
      }, text)
    })
  }
})

test.describe('checkA11y coverage (A11Y-2)', () => {
  const page_ = (body: string) =>
    `<!doctype html><html lang="en"><head><title>probe</title></head><body>${body}</body></html>`

  test('rejects a serious colour-contrast violation', async ({ page, checkA11y }) => {
    await page.setContent(
      page_('<main><p style="color:#777;background:#888">low contrast text</p></main>'),
    )
    await expect(checkA11y()).rejects.toThrow(/color-contrast/)
  })

  test('rejects a critical image-alt violation', async ({ page, checkA11y }) => {
    await page.setContent(
      page_(
        '<main><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="10" height="10"></main>',
      ),
    )
    await expect(checkA11y()).rejects.toThrow(/image-alt/)
  })

  test('allows moderate-only findings', async ({ page, checkA11y }) => {
    // Content outside any landmark is "region" (moderate): reported by axe, not blocking.
    await page.setContent(page_('<main><h1>ok</h1></main><div>outside a landmark</div>'))
    await expect(checkA11y()).resolves.toBeUndefined()
  })

  test('exclude leaves only the named subtree out of the scan', async ({ page, checkA11y }) => {
    await page.setContent(
      page_('<main><div id="skip"><button></button></div><button id="keep"></button></main>'),
    )
    await expect(checkA11y({ exclude: ['#skip'] })).rejects.toThrow(/#keep/)
    await page.evaluate(() => document.getElementById('keep')?.remove())
    await expect(checkA11y({ exclude: ['#skip'] })).resolves.toBeUndefined()
  })
})

test('console guard fails on console.error emitted 100 ms after the test body ends (PERF-1)', async ({
  page,
}) => {
  // A late async error (a failed fetch, an effect warning after the last assertion) must still
  // fail the test: the guard has to let the page settle before it judges.
  test.fail()
  await page.goto('/')
  await page.evaluate(() => {
    setTimeout(() => {
      // eslint-disable-next-line no-console -- deliberately provoking the guard
      console.error('fixture self-test error after the body ended')
    }, 100)
  })
})

// `expectedConsole`: an expected message is let through only if it really appears (exact type
// and text), and anything else still fails.
const EXPECTED_WARNING = 'fixture self-test: expected warning'

const logWarning = (page: Page, text: string, times = 1) =>
  page.evaluate(
    ([message, n]) => {
      // eslint-disable-next-line no-console -- reproducing an expected warning
      for (let i = 0; i < n; i++) console.warn(message)
    },
    [text, times] as const,
  )

test.describe('console guard expectedConsole (PERF-1)', () => {
  test.describe('with one expected warning', () => {
    test.use({ expectedConsole: [{ type: 'warning', text: EXPECTED_WARNING }] })

    test('lets the expected warning through', async ({ page }) => {
      await page.goto('/')
      await logWarning(page, EXPECTED_WARNING)
    })

    test('fails when the expected warning never appears', async ({ page }) => {
      test.fail()
      await page.goto('/')
    })

    test('still fails on an unexpected warning next to the expected one', async ({ page }) => {
      test.fail()
      await page.goto('/')
      await logWarning(page, EXPECTED_WARNING)
      await logWarning(page, 'fixture self-test: something else')
    })

    test('does not match the same text at another level', async ({ page }) => {
      test.fail()
      await page.goto('/')
      await page.evaluate((text) => {
        // eslint-disable-next-line no-console -- deliberately provoking the guard
        console.error(text)
      }, EXPECTED_WARNING)
    })

    test('does not match a string expectation by substring', async ({ page }) => {
      test.fail()
      await page.goto('/')
      await logWarning(page, `${EXPECTED_WARNING}!`)
    })

    test('still fails on an uncaught page error', async ({ page }) => {
      test.fail()
      await page.goto('/')
      await logWarning(page, EXPECTED_WARNING)
      await page.evaluate(() => {
        setTimeout(() => {
          throw new Error('fixture self-test error')
        }, 0)
      })
      await page.waitForTimeout(50)
    })
  })

  test.describe('with an exact count', () => {
    test.use({ expectedConsole: [{ type: 'warning', text: EXPECTED_WARNING, count: 1 }] })

    test('fails when the warning appears more often than expected', async ({ page }) => {
      test.fail()
      await page.goto('/')
      await logWarning(page, EXPECTED_WARNING, 2)
    })
  })

  test.describe('with two expected messages', () => {
    test.use({
      expectedConsole: [
        [
          { type: 'warning', text: EXPECTED_WARNING },
          { type: 'error', text: 'fixture self-test: expected error' },
        ],
        { scope: 'test' },
      ],
    })

    test('lets both through when both appear', async ({ page }) => {
      await page.goto('/')
      await logWarning(page, EXPECTED_WARNING)
      await page.evaluate(() => {
        // eslint-disable-next-line no-console -- reproducing an expected error
        console.error('fixture self-test: expected error')
      })
    })

    test('fails when only one of them appears', async ({ page }) => {
      test.fail()
      await page.goto('/')
      await logWarning(page, EXPECTED_WARNING)
    })
  })

  test.describe('with a pattern for a structured logger record', () => {
    test.use({
      expectedConsole: [{ type: 'warning', text: /^\{"level":"warn","msg":"probe record"\}$/ }],
    })

    test('matches an object argument by its JSON', async ({ page }) => {
      await page.goto('/')
      await page.evaluate(() => {
        // eslint-disable-next-line no-console -- reproducing a log.ts record
        console.warn({ level: 'warn', msg: 'probe record' })
      })
    })
  })
})

test.describe('onboarding seed (S05a)', () => {
  test('by default a page starts past the welcome card', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(await storedOnboarding(page)).toEqual(completedOnboardingSeed())
  })

  test.describe('with onboarding: fresh', () => {
    test.use({ onboarding: 'fresh' })

    test('the welcome card shows', async ({ page }) => {
      await page.goto('/')
      await expect(welcomeDialog(page)).toBeVisible()
      expect(await storedOnboarding(page)).toBeNull()
    })
  })
})
