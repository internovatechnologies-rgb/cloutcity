import { defineConfig, devices } from '@playwright/test'

const PORT = Number(process.env.E2E_PORT ?? 3100)
const BASE_URL = `http://localhost:${PORT}`
/** Build directory of the e2e (test-hook) build. */
export const E2E_DIST_DIR = '.next-e2e'

/**
 * Headless Chromium gets no GPU, so WebGL runs on SwiftShader (ANGLE's CPU Vulkan backend).
 * Chromium has deprecated *automatic* SwiftShader fallback for WebGL; these switches opt in
 * explicitly and silence the deprecation console warning that would trip PERF-1.
 * Source: https://chromium.googlesource.com/chromium/src/+/main/docs/gpu/swiftshader.md
 * README "Headless WebGL in Playwright" explains them.
 */
export const WEBGL_LAUNCH_ARGS = [
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
]

/**
 * The default e2e suite runs local-only: the build gets blank Supabase variables, so a
 * developer's .env.local can never make it sign in (S05). Specs that need the local Supabase
 * stack are named `*.supabase.spec.ts` and run with `npm run e2e:supabase`
 * (playwright.supabase.config.ts).
 */
export const SUPABASE_BLANK_ENV = {
  NEXT_PUBLIC_SUPABASE_URL: '',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: '',
}

export const SUPABASE_SPECS = '**/*.supabase.spec.ts'
/** Specs that only make sense in the NEXT_DEPLOYMENT_ID build (playwright.dpl.config.ts). */
export const DPL_SPECS = '**/*.dpl.spec.ts'

export default defineConfig({
  testDir: 'tests/e2e',
  testIgnore: [SUPABASE_SPECS, DPL_SPECS],
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  snapshotPathTemplate:
    '{testDir}/__screenshots__/{testFilePath}/{arg}-{projectName}-{platform}{ext}',
  expect: {
    toHaveScreenshot: { maxDiffPixelRatio: 0.01, animations: 'disabled' },
  },
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    launchOptions: { args: WEBGL_LAUNCH_ARGS },
    // The production build registers a service worker (S04e) that precaches the app: left on,
    // every spec would fetch the whole precache and could be served from it. Specs that test
    // offline support opt in with `test.use({ serviceWorkers: 'allow' })`.
    serviceWorkers: 'block',
  },
  projects: [
    {
      name: 'mobile-390',
      use: {
        browserName: 'chromium',
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: 'desktop-1280',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 720 } },
    },
  ],
  // e2e runs against the production build: dev-mode overlays and HMR logs are not what ships.
  // It builds with the scene test hooks (src/scene/testHooks.tsx) into its own distDir
  // (next.config.ts), so the shipped `.next` build never contains them (`npm run budget` checks).
  webServer: {
    command: `npm run build && npm run start -- --port ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
    env: { NEXT_PUBLIC_TEST_HOOKS: '1', NEXT_DIST_DIR: E2E_DIST_DIR, ...SUPABASE_BLANK_ENV },
  },
})
