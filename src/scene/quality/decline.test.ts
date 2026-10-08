import { afterEach, describe, expect, it } from 'vitest'
import { perf } from '@/lib/data/config'
import { createLogger, type LogRecord } from '@/lib/log'
import { createQualityStore, selectActiveTier, type PersistedQuality } from '@/state/quality'
import { createSafeJsonStorage } from '@/state/storage'
import { beginContinuous, endContinuous } from './continuity'
import { onMonitorDecline } from './decline'

const rule = perf.fpsStepDown

function setup() {
  const records: LogRecord[] = []
  const logger = createLogger({ level: 'debug', sink: (record) => records.push(record) })
  const store = createQualityStore(
    createSafeJsonStorage<PersistedQuality>(() => undefined, logger),
    logger,
  )
  store.getState().setDetected({ tier: 'high', reasons: ['high-capable'] }, false)
  return { store, logger, records }
}

afterEach(() => endContinuous('gesture'))

describe('a PerformanceMonitor decline', () => {
  it('steps down one tier after sustainMs of continuous rendering, and logs it', () => {
    const { store, logger, records } = setup()
    beginContinuous('gesture', 0)
    expect(onMonitorDecline(store, rule, rule.sustainMs, logger)).toEqual({
      action: 'step-down',
      to: 'mid',
    })
    expect(selectActiveTier(store.getState())).toBe('mid')
    expect(records.map((record) => record.level)).toEqual(['info'])
  })

  it('is ignored outside the continuous window (idle time is not a low frame rate)', () => {
    const { store, logger } = setup()
    expect(onMonitorDecline(store, rule, 60_000, logger)).toEqual({
      action: 'ignore',
      reason: 'gap',
    })
    beginContinuous('gesture', 1_000)
    expect(onMonitorDecline(store, rule, 1_000 + rule.sustainMs - 1, logger)).toEqual({
      action: 'ignore',
      reason: 'gap',
    })
    expect(store.getState().steps).toBe(0)
  })

  it('keeps the cooldown, the step limit and a settings choice', () => {
    const { store, logger } = setup()
    beginContinuous('gesture', 0)
    onMonitorDecline(store, rule, rule.sustainMs, logger)
    expect(onMonitorDecline(store, rule, rule.sustainMs + 1, logger)).toEqual({
      action: 'ignore',
      reason: 'cooldown',
    })
    store.getState().setOverride('high')
    expect(onMonitorDecline(store, rule, rule.sustainMs + rule.cooldownMs, logger)).toEqual({
      action: 'ignore',
      reason: 'override',
    })
    expect(selectActiveTier(store.getState())).toBe('high')
  })

  it('does nothing before the device has been probed', () => {
    const { logger } = setup()
    const empty = createQualityStore(
      createSafeJsonStorage<PersistedQuality>(() => undefined, logger),
      logger,
    )
    expect(onMonitorDecline(empty, rule, 10_000, logger)).toBeNull()
  })
})

describe('whether the monitor runs', () => {
  it('only while an automatic step-down is possible', async () => {
    const { canStepDown } = await import('./decline')
    const { store } = setup()
    expect(canStepDown(store.getState(), rule)).toBe(true)
    store.getState().setOverride('high')
    expect(canStepDown(store.getState(), rule)).toBe(false)
    store.getState().setOverride(null)
    store.getState().setDetected({ tier: 'low', reasons: ['low-renderer'] }, false)
    expect(canStepDown(store.getState(), rule)).toBe(false)
    store.getState().setDetected({ tier: 'high', reasons: ['high-capable'] }, true)
    expect(canStepDown(store.getState(), rule)).toBe(false)
    store.getState().setDetected({ tier: 'high', reasons: ['high-capable'] }, false)
    for (let step = 0; step < rule.maxSteps; step += 1) store.getState().recordStepDown(step)
    expect(canStepDown(store.getState(), rule)).toBe(false)
  })
})
