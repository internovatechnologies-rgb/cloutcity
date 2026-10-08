import { describe, expect, it } from 'vitest'
import perfJson from '@data/config/perf.json'
import { TierPickerSchema, type TierPicker } from '@/lib/data/schemas/config'
import { dataSaverRequested, pickTier, TIER_ORDER, type TierSignals } from './tier'

const cfg: TierPicker = TierPickerSchema.parse(perfJson.tierPicker)
const { lowBelow, highAtLeast } = cfg

/** A device every check calls high; tests change one signal at a time. */
const HIGH: TierSignals = {
  webgl2: true,
  renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
  maxTextureSize: highAtLeast.maxTextureSize,
  deviceMemoryGb: highAtLeast.deviceMemoryGb,
  cores: highAtLeast.cores,
  saveData: false,
  prefersReducedData: false,
}

/** Every signal unknown except WebGL2. */
const UNKNOWN: TierSignals = {
  webgl2: true,
  renderer: null,
  maxTextureSize: null,
  deviceMemoryGb: null,
  cores: null,
  saveData: null,
  prefersReducedData: null,
}

const tierOf = (signals: Partial<TierSignals>, base: TierSignals = HIGH) =>
  pickTier({ ...base, ...signals }, cfg).tier

describe('TIER_ORDER', () => {
  it('lists the tiers from lowest to highest, like perf.json', () => {
    expect(TIER_ORDER).toEqual(Object.keys(perfJson.dprCap))
  })
})

describe('pickTier', () => {
  it('picks high when every check passes, and mid when nothing is known', () => {
    expect(pickTier(HIGH, cfg)).toEqual({ tier: 'high', reasons: ['high-capable'] })
    expect(pickTier(UNKNOWN, cfg)).toEqual({ tier: 'mid', reasons: ['default'] })
  })

  it('picks low without WebGL2, before every other check', () => {
    expect(pickTier({ ...HIGH, webgl2: false, saveData: true }, cfg)).toEqual({
      tier: 'low',
      reasons: ['no-webgl2'],
    })
  })

  it('forces low on Save-Data or prefers-reduced-data, even on a high device', () => {
    expect(pickTier({ ...HIGH, saveData: true }, cfg)).toEqual({
      tier: 'low',
      reasons: ['data-saver'],
    })
    expect(tierOf({ prefersReducedData: true })).toBe('low')
    expect(tierOf({ saveData: false, prefersReducedData: false })).toBe('high')
    expect(tierOf({ saveData: null, prefersReducedData: null })).toBe('high')
  })

  it.each([
    'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
    'llvmpipe (LLVM 15.0.7, 256 bits)',
    'Mali-400 MP',
    'Mali-T720',
    'Adreno (TM) 506',
    'PowerVR SGX 544MP',
    'ANGLE (Intel, Intel(R) HD Graphics 520 Direct3D11 vs_5_0 ps_5_0, D3D11)',
  ])('picks low for the low renderer %s', (renderer) => {
    expect(pickTier({ ...HIGH, renderer }, cfg)).toEqual({
      tier: 'low',
      reasons: ['low-renderer'],
    })
  })

  it.each([
    'Apple M2',
    'ANGLE (AMD, AMD Radeon RX 6700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)',
    'Adreno (TM) 740',
    'Mali-G710 MC10',
  ])('picks high for the high renderer %s with high signals', (renderer) => {
    expect(tierOf({ renderer })).toBe('high')
  })

  it.each(['Apple GPU', 'Adreno (TM) 650', 'Mali-G68', 'Intel(R) UHD Graphics 620'])(
    'picks mid for the middling renderer %s even with high signals',
    (renderer) => {
      expect(pickTier({ ...HIGH, renderer }, cfg)).toEqual({ tier: 'mid', reasons: ['default'] })
    },
  )

  it('needs a known renderer for high', () => {
    expect(tierOf({ renderer: null })).toBe('mid')
  })

  it('matches renderer patterns case-insensitively', () => {
    expect(tierOf({ renderer: 'GOOGLE SWIFTSHADER' })).toBe('low')
    expect(tierOf({ renderer: 'nvidia geforce gtx 1080' })).toBe('high')
  })

  describe.each([
    ['maxTextureSize', 'low-max-texture-size'],
    ['deviceMemoryGb', 'low-device-memory'],
    ['cores', 'low-cores'],
  ] as const)('%s', (signal, reason) => {
    const step = signal === 'deviceMemoryGb' ? 0.25 : 1

    it('is low below the low threshold, not at or above it', () => {
      expect(pickTier({ ...HIGH, [signal]: lowBelow[signal] - step }, cfg)).toEqual({
        tier: 'low',
        reasons: [reason],
      })
      expect(tierOf({ [signal]: lowBelow[signal] })).toBe('mid')
      expect(tierOf({ [signal]: lowBelow[signal] + step })).toBe('mid')
    })

    it('allows high at the high threshold and above, not below it', () => {
      expect(tierOf({ [signal]: highAtLeast[signal] - step })).toBe('mid')
      expect(tierOf({ [signal]: highAtLeast[signal] })).toBe('high')
      expect(tierOf({ [signal]: highAtLeast[signal] + step })).toBe('high')
    })

    it('is neutral when unknown', () => {
      expect(tierOf({ [signal]: null })).toBe('high')
      expect(tierOf({ [signal]: null }, UNKNOWN)).toBe('mid')
    })
  })

  it('reports every low numeric signal at once', () => {
    expect(
      pickTier(
        {
          ...UNKNOWN,
          maxTextureSize: lowBelow.maxTextureSize - 1,
          deviceMemoryGb: lowBelow.deviceMemoryGb / 2,
          cores: lowBelow.cores - 1,
        },
        cfg,
      ),
    ).toEqual({ tier: 'low', reasons: ['low-max-texture-size', 'low-device-memory', 'low-cores'] })
  })

  it('checks a low renderer before the numeric signals', () => {
    expect(
      pickTier({ ...HIGH, renderer: 'SwiftShader', cores: lowBelow.cores - 1 }, cfg).reasons,
    ).toEqual(['low-renderer'])
  })

  it('a renderer matching both lists is low', () => {
    const both: TierPicker = { ...cfg, highRendererPatterns: ['swiftshader'] }
    expect(pickTier({ ...HIGH, renderer: 'SwiftShader' }, both).tier).toBe('low')
  })
})

describe('dataSaverRequested', () => {
  it('is true only for an explicit request', () => {
    expect(dataSaverRequested({ saveData: true, prefersReducedData: null })).toBe(true)
    expect(dataSaverRequested({ saveData: null, prefersReducedData: true })).toBe(true)
    expect(dataSaverRequested({ saveData: false, prefersReducedData: false })).toBe(false)
    expect(dataSaverRequested({ saveData: null, prefersReducedData: null })).toBe(false)
  })
})
