/**
 * Applies a perf.json throttle profile (CLAUDE.md "Reference throttle profile `cc-mid-4g`") to a
 * Chromium page through the Chrome DevTools Protocol, before the page navigates:
 * - Network.emulateNetworkConditionsByRule with one global rule (empty `urlPattern` matches every
 *   request): latency and up/down throughput. It replaces the deprecated
 *   Network.emulateNetworkConditions and leaves `navigator.onLine` alone.
 * - Emulation.setCPUThrottlingRate: the CPU slowdown factor.
 * The viewport comes from the Playwright project (playwright.perf.config.ts).
 * Definitions: node_modules/playwright-core/types/protocol.d.ts (Playwright 1.63).
 */
import type { CDPSession, Page } from '@playwright/test'
import type { ThrottleProfile } from '@/lib/data/schemas/config'

/** CDP throughput is bytes per second; perf.json uses kilobits per second (1 kbit = 1000 bit). */
export function kbpsToBytesPerSecond(kbps: number): number {
  return Math.round((kbps * 1000) / 8)
}

/** The `Network.emulateNetworkConditionsByRule` parameters for a profile. */
export function networkRule(profile: ThrottleProfile) {
  return {
    matchedNetworkConditions: [
      {
        urlPattern: '',
        latency: profile.rttMs,
        downloadThroughput: kbpsToBytesPerSecond(profile.downloadKbps),
        uploadThroughput: kbpsToBytesPerSecond(profile.uploadKbps),
        connectionType: 'cellular4g' as const,
      },
    ],
  }
}

/** Throttles `page`'s network and CPU. Call before `page.goto`; keep the session open. */
export async function applyThrottle(page: Page, profile: ThrottleProfile): Promise<CDPSession> {
  const session = await page.context().newCDPSession(page)
  await session.send('Network.enable')
  const { ruleIds } = await session.send(
    'Network.emulateNetworkConditionsByRule',
    networkRule(profile),
  )
  if (ruleIds.length !== 1) {
    throw new Error(`Chromium accepted ${ruleIds.length} network rules, expected 1`)
  }
  await session.send('Emulation.setCPUThrottlingRate', { rate: profile.cpuSlowdown })
  return session
}
