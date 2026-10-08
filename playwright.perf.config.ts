import { readFileSync } from 'node:fs'
import { defineConfig } from '@playwright/test'
import { E2E_DIST_DIR, SUPABASE_BLANK_ENV, WEBGL_LAUNCH_ARGS } from './playwright.config'
import { PerfConfigSchema } from './src/lib/data/schemas/config'

/**
 * `npm run e2e:perf` (S04b): load timings and render budgets under a perf.json throttle profile.
 * Timings are only meaningful with one browser on the machine, so: one worker, no parallel
 * tests, no retries (a retry would hide a slow run), and a global setup that takes the
 * machine-wide perf lock and waits for a quiet CPU (tests/perf/global-setup.ts). Each spec
 * applies the network and CPU throttle itself (tests/perf/throttle.ts) before navigating.
 *
 * It serves the e2e build (the scene test hooks report draw calls and triangles) on the lane's
 * E2E_PORT, like playwright.config.ts, local-only (blank Supabase variables), so no sign-in
 * traffic competes with the load being measured. The specs (`tests/perf/*.perf.ts`) write
 * their medians to test-results/perf/report.json.
 */
const perf = PerfConfigSchema.parse(JSON.parse(readFileSync('data/config/perf.json', 'utf8')))
// PerfConfigSchema checks that perfRun.profile names a throttle profile.
const profileName = perf.perfRun.profile as keyof typeof perf.throttleProfiles
const profile = perf.throttleProfiles[profileName]

const PORT = Number(process.env.E2E_PORT ?? 3100)
const BASE_URL = `http://localhost:${PORT}`

export default defineConfig({
  testDir: 'tests/perf',
  testMatch: '**/*.perf.ts',
  globalSetup: './tests/perf/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: 'list',
  use: {
    baseURL: BASE_URL,
    browserName: 'chromium',
    trace: 'retain-on-failure',
    launchOptions: { args: WEBGL_LAUNCH_ARGS },
  },
  projects: [
    {
      name: profileName,
      use: {
        viewport: profile.viewport,
        // A phone-class screen, as in the mobile-390 e2e project: the tier's DPR cap must apply.
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
  webServer: {
    command: `npm run build && npm run start -- --port ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
    env: { NEXT_PUBLIC_TEST_HOOKS: '1', NEXT_DIST_DIR: E2E_DIST_DIR, ...SUPABASE_BLANK_ENV },
  },
})
