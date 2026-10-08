import { describe, expect, it, vi } from 'vitest'
import offlineJson from '@data/config/offline.json'
import type { QualityTier } from '@/lib/data/schemas/config'
import { WARM_TIER_DONE, WARM_TIER_MESSAGE, type WarmTierDone } from '@/sw/policy'
import {
  parseWarmDone,
  readDeviceSignals,
  requestTierWarm,
  startTierWarm,
  tierWarmDecision,
  type TierWarmDeps,
  type TierWarmSignals,
} from './tierWarm'

const CONFIG = { skipAtOrBelowDeviceMemoryGB: 2 }
const SIGNALS: TierWarmSignals = {
  tier: 'mid',
  dataSaver: false,
  saveData: null,
  deviceMemoryGb: null,
}

describe('tierWarmDecision', () => {
  it('warms the tier in use when nothing argues against it', () => {
    expect(tierWarmDecision(SIGNALS, CONFIG)).toEqual({ warm: true, tier: 'mid' })
    for (const tier of ['low', 'mid', 'high'] as const) {
      expect(tierWarmDecision({ ...SIGNALS, tier, deviceMemoryGb: 8 }, CONFIG)).toEqual({
        warm: true,
        tier,
      })
    }
  })

  it('waits for a tier', () => {
    expect(tierWarmDecision({ ...SIGNALS, tier: null }, CONFIG)).toEqual({
      warm: false,
      reason: 'no-tier',
    })
  })

  it('skips under a data-saver request, from the store or from Save-Data now', () => {
    const skip = { warm: false, reason: 'data-saver' }
    expect(tierWarmDecision({ ...SIGNALS, tier: 'low', dataSaver: true }, CONFIG)).toEqual(skip)
    expect(tierWarmDecision({ ...SIGNALS, saveData: true }, CONFIG)).toEqual(skip)
    expect(tierWarmDecision({ ...SIGNALS, saveData: false }, CONFIG)).toMatchObject({ warm: true })
  })

  it('skips at or below the memory threshold; unknown memory never blocks', () => {
    const at = (deviceMemoryGb: number | null) =>
      tierWarmDecision({ ...SIGNALS, deviceMemoryGb }, CONFIG)
    expect(at(0.5)).toEqual({ warm: false, reason: 'low-memory' })
    expect(at(2)).toEqual({ warm: false, reason: 'low-memory' })
    expect(at(4)).toMatchObject({ warm: true })
    expect(at(null)).toMatchObject({ warm: true })
  })

  it('reads its threshold from data/config/offline.json', () => {
    expect(offlineJson.tierWarm.skipAtOrBelowDeviceMemoryGB).toBeGreaterThan(0)
  })
})

describe('readDeviceSignals', () => {
  it('reads Save-Data and device memory where exposed, null otherwise', () => {
    const nav = { connection: { saveData: true }, deviceMemory: 4 } as unknown as Navigator
    expect(readDeviceSignals(nav)).toEqual({ saveData: true, deviceMemoryGb: 4 })
    expect(readDeviceSignals({} as Navigator)).toEqual({ saveData: null, deviceMemoryGb: null })
    expect(readDeviceSignals(undefined)).toEqual({ saveData: null, deviceMemoryGb: null })
    const odd = { connection: { saveData: 'yes' }, deviceMemory: -1 } as unknown as Navigator
    expect(readDeviceSignals(odd)).toEqual({ saveData: null, deviceMemoryGb: null })
  })
})

describe('parseWarmDone', () => {
  const done: WarmTierDone = { type: WARM_TIER_DONE, tier: 'low', cached: 9, failed: 0 }

  it("accepts the worker's report for the tier asked for", () => {
    expect(parseWarmDone(done, 'low')).toEqual(done)
  })

  it('refuses anything else', () => {
    for (const data of [null, 'x', {}, { ...done, tier: 'mid' }, { ...done, type: 'X' }]) {
      expect(parseWarmDone(data, 'low'), JSON.stringify(data)).toBeNull()
    }
    expect(parseWarmDone({ ...done, cached: '9' }, 'low')).toBeNull()
  })
})

describe('requestTierWarm', () => {
  it('sends only the message type and tier, and resolves with the reply', async () => {
    const postMessage = vi.fn((message: unknown, transfer: Transferable[]) => {
      const port = transfer[0] as MessagePort
      expect(message).toEqual({ type: WARM_TIER_MESSAGE, tier: 'high' })
      port.postMessage({ type: WARM_TIER_DONE, tier: 'high', cached: 3, failed: 1 })
    })
    await expect(requestTierWarm({ postMessage }, 'high')).resolves.toEqual({
      type: WARM_TIER_DONE,
      tier: 'high',
      cached: 3,
      failed: 1,
    })
    expect(postMessage).toHaveBeenCalledTimes(1)
  })

  it('resolves null without an active worker', async () => {
    await expect(requestTierWarm(null, 'low')).resolves.toBeNull()
  })
})

describe('startTierWarm', () => {
  function harness(initial: { tier: QualityTier | null; dataSaver?: boolean }) {
    let quality = { tier: initial.tier, dataSaver: initial.dataSaver ?? false }
    const listeners = new Set<() => void>()
    let device = { saveData: null as boolean | null, deviceMemoryGb: null as number | null }
    const replies: { failed: number }[] = []
    const request = vi.fn((_worker: unknown, tier: QualityTier) =>
      Promise.resolve<WarmTierDone>({
        type: WARM_TIER_DONE,
        tier,
        cached: 9,
        failed: replies.shift()?.failed ?? 0,
      }),
    )
    const info = vi.fn()
    const worker = { postMessage: vi.fn() }
    const deps: TierWarmDeps = {
      ready: Promise.resolve({ active: worker }),
      quality: () => quality,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      device: () => device,
      config: CONFIG,
      request,
      logger: { info },
    }
    return {
      deps,
      request,
      info,
      replies,
      set(next: Partial<typeof quality>) {
        quality = { ...quality, ...next }
        for (const listener of listeners) listener()
      },
      setDevice(next: Partial<typeof device>) {
        device = { ...device, ...next }
      },
      listeners,
    }
  }

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

  it('warms once the worker is active, then each new tier once', async () => {
    const h = harness({ tier: 'mid' })
    const stop = startTierWarm(h.deps)
    expect(h.request).not.toHaveBeenCalled()
    await flush()
    expect(h.request.mock.calls.map(([, tier]) => tier)).toEqual(['mid'])
    h.set({ tier: 'mid' })
    h.set({ tier: 'low' })
    h.set({ tier: 'mid' })
    await flush()
    expect(h.request.mock.calls.map(([, tier]) => tier)).toEqual(['mid', 'low'])
    expect(h.info).toHaveBeenCalledWith('Tier warmed', { tier: 'mid', cached: 9, failed: 0 })
    stop()
    expect(h.listeners.size).toBe(0)
  })

  it('waits for the tier to be known', async () => {
    const h = harness({ tier: null })
    startTierWarm(h.deps)
    await flush()
    expect(h.request).not.toHaveBeenCalled()
    h.set({ tier: 'low' })
    await flush()
    expect(h.request).toHaveBeenCalledTimes(1)
  })

  it('never warms under data saver or on low memory, and logs each skip once', async () => {
    const h = harness({ tier: 'low', dataSaver: true })
    startTierWarm(h.deps)
    await flush()
    h.set({ tier: 'low' })
    expect(h.request).not.toHaveBeenCalled()
    expect(h.info.mock.calls).toEqual([['Tier warm skipped', { reason: 'data-saver' }]])

    const m = harness({ tier: 'mid' })
    m.setDevice({ deviceMemoryGb: 1 })
    startTierWarm(m.deps)
    await flush()
    expect(m.request).not.toHaveBeenCalled()
    expect(m.info).toHaveBeenCalledWith('Tier warm skipped', { reason: 'low-memory' })
  })

  it('tries a tier again after a warm that could not fetch everything', async () => {
    const h = harness({ tier: 'mid' })
    h.replies.push({ failed: 2 })
    startTierWarm(h.deps)
    await flush()
    h.set({ tier: 'mid' })
    await flush()
    expect(h.request).toHaveBeenCalledTimes(2)
  })

  it('does nothing once stopped before the worker is ready', async () => {
    const h = harness({ tier: 'mid' })
    const stop = startTierWarm(h.deps)
    stop()
    await flush()
    expect(h.request).not.toHaveBeenCalled()
    expect(h.listeners.size).toBe(0)
  })
})
