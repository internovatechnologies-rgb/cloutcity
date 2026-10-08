/**
 * The tier warm (S04e): once the map is playable and the service worker is active, the page asks
 * the worker to fetch its quality tier's district assets into the worker's cache
 * (`CC_WARM_TIER`, src/sw/sw.ts), so the next load, or a reload offline, finds them on the
 * device. The page sends only the tier; the worker fetches its own build-time URL list.
 *
 * A warm costs data and memory for a later load, so it is skipped when the player has asked to
 * save data (Save-Data, or the data-saver flag the quality picker recorded) and on a device that
 * reports little memory. Whatever the scene itself loads is still cached as it goes.
 */
import type { QualityTier } from '@/lib/data/schemas/config'
import type { Logger } from '@/lib/log'
import { WARM_TIER_DONE, WARM_TIER_MESSAGE, type WarmTierDone } from '@/sw/policy'

/** What the warm needs of the active worker. */
export interface WarmWorker {
  postMessage(message: unknown, transfer: Transferable[]): void
}

export interface TierWarmSignals {
  /** The tier in use, or null before the shell has probed the device. */
  readonly tier: QualityTier | null
  /** The quality store's data-saver flag (Save-Data or prefers-reduced-data at probe time). */
  readonly dataSaver: boolean
  /** `navigator.connection.saveData` now, when the browser exposes it. */
  readonly saveData: boolean | null
  /** `navigator.deviceMemory` in GB, when the browser exposes it. */
  readonly deviceMemoryGb: number | null
}

export interface TierWarmConfig {
  readonly skipAtOrBelowDeviceMemoryGB: number
}

export type TierWarmDecision =
  | { readonly warm: true; readonly tier: QualityTier }
  | { readonly warm: false; readonly reason: 'no-tier' | 'data-saver' | 'low-memory' }

/** Whether to warm, and which tier. Pure: unknown signals never block a warm. */
export function tierWarmDecision(
  signals: TierWarmSignals,
  config: TierWarmConfig,
): TierWarmDecision {
  if (signals.tier === null) return { warm: false, reason: 'no-tier' }
  if (signals.dataSaver || signals.saveData === true) return { warm: false, reason: 'data-saver' }
  if (
    signals.deviceMemoryGb !== null &&
    signals.deviceMemoryGb <= config.skipAtOrBelowDeviceMemoryGB
  ) {
    return { warm: false, reason: 'low-memory' }
  }
  return { warm: true, tier: signals.tier }
}

/** The browser's live data-saver and memory signals (null where not exposed). */
export function readDeviceSignals(nav: Navigator | undefined): {
  saveData: boolean | null
  deviceMemoryGb: number | null
} {
  const extended = nav as
    (Navigator & { connection?: { saveData?: unknown }; deviceMemory?: unknown }) | undefined
  const saveData = extended?.connection?.saveData
  const memory = extended?.deviceMemory
  return {
    saveData: typeof saveData === 'boolean' ? saveData : null,
    deviceMemoryGb: typeof memory === 'number' && memory > 0 ? memory : null,
  }
}

/** Reads the worker's reply: a done report for `tier`, or null for anything else. */
export function parseWarmDone(data: unknown, tier: QualityTier): WarmTierDone | null {
  if (typeof data !== 'object' || data === null) return null
  const reply = data as Partial<WarmTierDone>
  if (reply.type !== WARM_TIER_DONE || reply.tier !== tier) return null
  if (typeof reply.cached !== 'number' || typeof reply.failed !== 'number') return null
  return { type: WARM_TIER_DONE, tier, cached: reply.cached, failed: reply.failed }
}

/**
 * Asks the active worker to warm `tier` and resolves with its report, or null when there is no
 * active worker or no MessageChannel.
 */
export function requestTierWarm(
  worker: WarmWorker | null | undefined,
  tier: QualityTier,
): Promise<WarmTierDone | null> {
  if (worker === null || worker === undefined || typeof MessageChannel !== 'function') {
    return Promise.resolve(null)
  }
  const channel = new MessageChannel()
  return new Promise((resolve) => {
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      channel.port1.close()
      resolve(parseWarmDone(event.data, tier))
    }
    worker.postMessage({ type: WARM_TIER_MESSAGE, tier }, [channel.port2])
  })
}

export interface TierWarmDeps {
  /** Resolves with the registration once a worker is active (navigator.serviceWorker.ready). */
  readonly ready: Promise<{ readonly active: WarmWorker | null }>
  /** The quality store, read now. */
  readonly quality: () => { readonly tier: QualityTier | null; readonly dataSaver: boolean }
  /** Subscribes to quality changes (a settings override, a runtime step-down). */
  readonly subscribe: (listener: () => void) => () => void
  readonly device: () => {
    readonly saveData: boolean | null
    readonly deviceMemoryGb: number | null
  }
  readonly config: TierWarmConfig
  readonly request?: typeof requestTierWarm
  readonly logger: Pick<Logger, 'info'>
}

/**
 * Warms the tier in use once the worker is active, and again whenever the tier changes to one
 * not warmed yet this session. Returns a stop function.
 */
export function startTierWarm(deps: TierWarmDeps): () => void {
  const request = deps.request ?? requestTierWarm
  const warmed = new Set<QualityTier>()
  let lastSkip: string | null = null
  let stopped = false
  let unsubscribe = () => {}

  const evaluate = (worker: WarmWorker | null) => {
    if (stopped) return
    const { tier, dataSaver } = deps.quality()
    const decision = tierWarmDecision({ tier, dataSaver, ...deps.device() }, deps.config)
    if (!decision.warm) {
      if (decision.reason !== 'no-tier' && decision.reason !== lastSkip) {
        deps.logger.info('Tier warm skipped', { reason: decision.reason })
      }
      lastSkip = decision.reason
      return
    }
    lastSkip = null
    if (warmed.has(decision.tier)) return
    warmed.add(decision.tier)
    void request(worker, decision.tier).then((done) => {
      if (done === null) return
      deps.logger.info('Tier warmed', { tier: done.tier, cached: done.cached, failed: done.failed })
      // A tier that could not be fully fetched (offline) is tried again on the next change.
      if (done.failed > 0) warmed.delete(done.tier)
    })
  }

  void deps.ready.then((registration) => {
    if (stopped) return
    const worker = registration.active
    evaluate(worker)
    unsubscribe = deps.subscribe(() => evaluate(worker))
  })

  return () => {
    stopped = true
    unsubscribe()
  }
}
