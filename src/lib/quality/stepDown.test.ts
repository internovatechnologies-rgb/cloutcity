import { describe, expect, it } from 'vitest'
import perfJson from '@data/config/perf.json'
import { FpsStepDownSchema, type FpsStepDown } from '@/lib/data/schemas/config'
import { lower, resolveActive, stepDecision, type StepInput } from './stepDown'

const cfg: FpsStepDown = FpsStepDownSchema.parse(perfJson.fpsStepDown)
const NOW = 100_000

/** A decline that steps down; each case changes one input. */
const STEPS: StepInput = {
  event: 'decline',
  nowMs: NOW,
  continuousSinceMs: NOW - cfg.sustainMs,
  lastStepAtMs: null,
  steps: 0,
  active: 'high',
  overrideActive: false,
  dataSaver: false,
}

describe('lower', () => {
  it('drops one tier and stops at low', () => {
    expect(lower('high')).toBe('mid')
    expect(lower('mid')).toBe('low')
    expect(lower('low')).toBe('low')
  })
})

describe('stepDecision', () => {
  it('steps one tier down on a decline after a full continuous window', () => {
    expect(stepDecision(STEPS, cfg)).toEqual({ action: 'step-down', to: 'mid' })
    expect(stepDecision({ ...STEPS, active: 'mid' }, cfg)).toEqual({
      action: 'step-down',
      to: 'low',
    })
  })

  it.each<[string, Partial<StepInput>, string]>([
    ['an incline (never an automatic step up)', { event: 'incline' }, 'incline'],
    ['a settings override', { overrideActive: true }, 'override'],
    ['a data-saver request', { dataSaver: true }, 'data-saver'],
    ['no continuous rendering now', { continuousSinceMs: null }, 'gap'],
    [
      'a continuous window 1 ms shorter than sustainMs',
      { continuousSinceMs: NOW - cfg.sustainMs + 1 },
      'gap',
    ],
    ['a step 1 ms inside the cooldown', { lastStepAtMs: NOW - cfg.cooldownMs + 1 }, 'cooldown'],
    ['a step just now', { lastStepAtMs: NOW }, 'cooldown'],
    ['maxSteps already taken', { steps: cfg.maxSteps }, 'max-steps'],
    ['more than maxSteps taken', { steps: cfg.maxSteps + 1 }, 'max-steps'],
    ['the low tier', { active: 'low' }, 'at-low'],
  ])('ignores %s', (_label, change, reason) => {
    expect(stepDecision({ ...STEPS, ...change }, cfg)).toEqual({ action: 'ignore', reason })
  })

  it('steps again exactly when the cooldown ends', () => {
    expect(
      stepDecision({ ...STEPS, lastStepAtMs: NOW - cfg.cooldownMs, steps: 1, active: 'mid' }, cfg),
    ).toEqual({ action: 'step-down', to: 'low' })
  })

  it('steps with a continuous window longer than sustainMs', () => {
    expect(stepDecision({ ...STEPS, continuousSinceMs: 0 }, cfg).action).toBe('step-down')
  })

  it('allows the last step below maxSteps', () => {
    expect(stepDecision({ ...STEPS, steps: cfg.maxSteps - 1 }, cfg).action).toBe('step-down')
  })

  it('never steps when maxSteps is 0', () => {
    expect(stepDecision(STEPS, { ...cfg, maxSteps: 0 })).toEqual({
      action: 'ignore',
      reason: 'max-steps',
    })
  })
})

describe('resolveActive', () => {
  const base = { auto: 'high', steps: 0, override: null, dataSaver: false } as const

  it('uses the picked tier lowered once per step-down, never below low', () => {
    expect(resolveActive(base)).toBe('high')
    expect(resolveActive({ ...base, steps: 1 })).toBe('mid')
    expect(resolveActive({ ...base, steps: 2 })).toBe('low')
    expect(resolveActive({ ...base, steps: 5 })).toBe('low')
    expect(resolveActive({ ...base, auto: 'mid', steps: 1 })).toBe('low')
  })

  it('uses the settings choice over the picked tier and step-downs', () => {
    expect(resolveActive({ ...base, auto: 'low', override: 'high' })).toBe('high')
    expect(resolveActive({ ...base, steps: 2, override: 'mid' })).toBe('mid')
  })

  it('forces low on a data-saver request, even over the settings choice', () => {
    expect(resolveActive({ ...base, dataSaver: true })).toBe('low')
    expect(resolveActive({ ...base, override: 'high', dataSaver: true })).toBe('low')
  })
})
