/**
 * Opt-in e2e of offline support under Vercel Skew Protection (F1): `npm run e2e:dpl` builds with
 * NEXT_DEPLOYMENT_ID set, so Next adds `?dpl=<id>` to every build asset URL as it does on Vercel,
 * and runs the service worker and offline specs against that build, on their own port and build
 * directory. The default `npm run e2e` is unchanged (no deployment id).
 */
import { defineConfig } from '@playwright/test'
import base, { DPL_SPECS, E2E_DIST_DIR, SUPABASE_BLANK_ENV } from './playwright.config'

const PORT = Number(process.env.E2E_DPL_PORT ?? 3111)
const BASE_URL = `http://localhost:${PORT}`
export const E2E_DPL_DIST_DIR = `${E2E_DIST_DIR}-dpl`
/** The deployment id the build carries; tests/e2e/deployment-id.dpl.spec.ts checks it is used. */
export const E2E_DEPLOYMENT_ID = 'dpl_e2e'

export default defineConfig({
  ...base,
  testIgnore: undefined,
  testMatch: [DPL_SPECS, '**/offline.spec.ts', '**/service-worker.spec.ts'],
  use: { ...base.use, baseURL: BASE_URL },
  webServer: {
    command: `npm run build && npm run start -- --port ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
    env: {
      NEXT_PUBLIC_TEST_HOOKS: '1',
      NEXT_DIST_DIR: E2E_DPL_DIST_DIR,
      NEXT_DEPLOYMENT_ID: E2E_DEPLOYMENT_ID,
      ...SUPABASE_BLANK_ENV,
    },
  },
})
