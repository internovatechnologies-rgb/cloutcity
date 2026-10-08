import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DAY_NIGHT_MODEL as MODEL,
  DEFAULT_SCENE_DAY_NIGHT,
  DEFAULT_THEME_DAY_NIGHT,
} from './fixture'
import {
  lightingAt,
  lightingKey,
  minuteOfDay,
  mixHexLinear,
  resolveDayNight,
  sunDirection,
  uiThemeAt,
  type DayNightKeyframe,
  type Lighting,
  type SceneDayNight,
} from './index'

const at = (h: number, m = 0) => h * 60 + m

function keyframe(id: string): DayNightKeyframe {
  const found = MODEL.keyframes.find((k) => k.id === id)
  if (found === undefined) throw new Error(id)
  return found
}

/** Largest change of any number or colour channel between two lightings. */
function maxDelta(a: Lighting, b: Lighting): number {
  const numbers = (l: Lighting) => [
    l.sunIntensity,
    l.shadowIntensity,
    l.ambientIntensity,
    l.hemisphereIntensity,
    l.nightGlow,
    l.sunDirection.x,
    l.sunDirection.y,
    l.sunDirection.z,
    ...Object.values(l.colors).flatMap((hex) =>
      [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255),
    ),
  ]
  const na = numbers(a)
  const nb = numbers(b)
  return Math.max(...na.map((v, i) => Math.abs(v - (nb[i] as number))))
}

describe('lightingAt', () => {
  it('shows each keyframe exactly when it is reached', () => {
    for (const k of MODEL.keyframes) {
      const lighting = lightingAt(k.atMinute, MODEL)
      expect(lighting.keyframe).toBe(k.id)
      expect(lighting.t).toBe(0)
      expect(lighting.ui).toBe(k.ui)
      expect(lighting.colors).toEqual(k.colors)
      expect(lighting.sunIntensity).toBe(k.sunIntensity)
      expect(lighting.shadowIntensity).toBe(k.shadowIntensity)
      expect(lighting.ambientIntensity).toBe(k.ambientIntensity)
      expect(lighting.hemisphereIntensity).toBe(k.hemisphereIntensity)
      expect(lighting.nightGlow).toBe(k.nightGlow)
      expect(lighting.sun.azimuthDeg).toBe(k.sun.azimuthDeg)
      expect(lighting.sun.elevationDeg).toBe(Math.max(MODEL.minSunElevationDeg, k.sun.elevationDeg))
    }
  })

  it('keeps the six placeholder keyframes at their planned times and palettes', () => {
    expect(MODEL.keyframes.map((k) => [k.id, k.atMinute, k.holdMinutes, k.ui])).toEqual([
      ['dawn', at(5, 45), 0, 'day'],
      ['morning', at(7), 60, 'day'],
      ['day', at(10), 330, 'day'],
      ['golden', at(17, 30), 30, 'day'],
      ['dusk', at(19), 0, 'night'],
      ['night', at(20, 30), 0, 'night'],
    ])
  })

  it('holds flat for the whole hold, then blends', () => {
    const day = keyframe('day')
    const start = lightingAt(day.atMinute, MODEL)
    for (let m = day.atMinute; m <= day.atMinute + day.holdMinutes; m += 5) {
      const held = lightingAt(m, MODEL)
      expect(held).toEqual({ ...start, minute: held.minute })
      expect(lightingKey(held)).toBe(lightingKey(start))
    }
    const after = lightingAt(day.atMinute + day.holdMinutes + 5, MODEL)
    expect(after.keyframe).toBe('day')
    expect(after.next).toBe('golden')
    expect(after.t).toBeGreaterThan(0)
    expect(after.t).toBeLessThan(1)
  })

  it('blends with a smoothstep between hold end and the next keyframe', () => {
    const morning = keyframe('morning')
    const day = keyframe('day')
    const blendStart = morning.atMinute + morning.holdMinutes
    const mid = blendStart + (day.atMinute - blendStart) / 2
    const lighting = lightingAt(mid, MODEL)
    expect(lighting.t).toBeCloseTo(0.5, 10)
    expect(lighting.sunIntensity).toBeCloseTo((morning.sunIntensity + day.sunIntensity) / 2, 10)
    // A quarter of the way in, smoothstep gives 0.15625, not 0.25.
    const quarter = lightingAt(blendStart + (day.atMinute - blendStart) / 4, MODEL)
    expect(quarter.t).toBeCloseTo(0.15625, 10)
  })

  it('is continuous over every minute of the day, including 23:59 → 00:00', () => {
    for (let m = 0; m < 1440; m++) {
      expect(maxDelta(lightingAt(m, MODEL), lightingAt(m + 1, MODEL)), `minute ${m}`).toBeLessThan(
        0.1,
      )
    }
    const beforeMidnight = lightingAt(at(23, 59), MODEL)
    const midnight = lightingAt(0, MODEL)
    expect(beforeMidnight.keyframe).toBe('night')
    expect(midnight.keyframe).toBe('night')
    expect(midnight.next).toBe('dawn')
    expect(midnight.t).toBeGreaterThan(beforeMidnight.t)
    expect(maxDelta(beforeMidnight, midnight)).toBeLessThan(0.05)
  })

  it('wraps minutes of 1440 and more, and negative minutes', () => {
    for (const m of [0, 1, 359, 600, 1234, 1439]) {
      const base = lightingAt(m, MODEL)
      expect(lightingAt(m + 1440, MODEL)).toEqual(base)
      expect(lightingAt(m + 1440 * 7, MODEL)).toEqual(base)
      expect(lightingAt(m - 1440, MODEL)).toEqual(base)
    }
    expect(minuteOfDay(-1)).toBe(1439)
    expect(minuteOfDay(1440)).toBe(0)
    expect(minuteOfDay(10.9)).toBe(10)
    expect(() => minuteOfDay(Number.NaN)).toThrow(/finite/)
  })

  it('quantises to the model step', () => {
    expect(MODEL.quantizeMinutes).toBe(5)
    const base = lightingAt(at(8, 30), MODEL)
    for (const m of [at(8, 31), at(8, 32), at(8, 34)]) expect(lightingAt(m, MODEL)).toEqual(base)
    expect(lightingAt(at(8, 35), MODEL).minute).toBe(at(8, 35))
    expect(lightingKey(lightingAt(at(8, 35), MODEL))).not.toBe(lightingKey(base))
  })

  it('in step mode shows the current keyframe unblended', () => {
    const golden = keyframe('golden')
    for (const m of [at(17, 30), at(18, 0), at(18, 30), at(18, 55)]) {
      const stepped = lightingAt(m, MODEL, { step: true })
      expect(stepped.mode).toBe('step')
      expect(stepped.keyframe).toBe('golden')
      expect(stepped.t).toBe(0)
      expect(stepped.colors).toEqual(golden.colors)
      expect(stepped.nightGlow).toBe(golden.nightGlow)
      expect(lightingKey(stepped)).toBe('golden')
    }
    expect(lightingAt(at(19), MODEL, { step: true }).keyframe).toBe('dusk')
    // Mid-blend, blend mode differs from the keyframe.
    expect(lightingAt(at(18, 30), MODEL).colors).not.toEqual(golden.colors)
  })

  it('mixes colours in linear light', () => {
    // Half black, half white in linear light is sRGB #bcbcbc, not the sRGB midpoint #808080.
    expect(mixHexLinear('#000000', '#ffffff', 0.5)).toBe('#bcbcbc')
    expect(mixHexLinear('#123456', '#abcdef', 0)).toBe('#123456')
    expect(mixHexLinear('#123456', '#abcdef', 1)).toBe('#abcdef')
  })

  it('never lets the sun drop below the minimum elevation', () => {
    for (let m = 0; m < 1440; m += 5) {
      const lighting = lightingAt(m, MODEL)
      expect(lighting.sun.elevationDeg).toBeGreaterThanOrEqual(MODEL.minSunElevationDeg)
      expect(lighting.sunDirection.y).toBeGreaterThanOrEqual(
        Math.sin((MODEL.minSunElevationDeg * Math.PI) / 180) - 1e-12,
      )
    }
    // Dawn is set at 4°, below the 25° floor.
    expect(lightingAt(at(5, 45), MODEL).sun.elevationDeg).toBe(25)
  })

  it('converts azimuth and elevation to scene axes (x east, y up, z south)', () => {
    const close = (v: { x: number; y: number; z: number }, x: number, y: number, z: number) => {
      expect(v.x).toBeCloseTo(x, 12)
      expect(v.y).toBeCloseTo(y, 12)
      expect(v.z).toBeCloseTo(z, 12)
    }
    close(sunDirection({ azimuthDeg: 0, elevationDeg: 0 }), 0, 0, -1)
    close(sunDirection({ azimuthDeg: 90, elevationDeg: 0 }), 1, 0, 0)
    close(sunDirection({ azimuthDeg: 180, elevationDeg: 0 }), 0, 0, 1)
    close(sunDirection({ azimuthDeg: 270, elevationDeg: 0 }), -1, 0, 0)
    close(sunDirection({ azimuthDeg: 123, elevationDeg: 90 }), 0, 1, 0)
    const d = sunDirection({ azimuthDeg: 37, elevationDeg: 41 })
    expect(Math.hypot(d.x, d.y, d.z)).toBeCloseTo(1, 12)
  })

  it('moves the sun along the shorter arc, also across north', () => {
    // night 330° → dawn 75° crosses north: halfway is 22.5°, not 202.5°.
    const night = keyframe('night')
    const dawn = keyframe('dawn')
    const span = dawn.atMinute + 1440 - night.atMinute
    const mid = lightingAt(night.atMinute + span / 2, MODEL)
    expect(mid.t).toBeCloseTo(0.5, 1)
    expect(mid.sun.azimuthDeg).toBeGreaterThan(0)
    expect(mid.sun.azimuthDeg).toBeLessThan(45)
  })
})

describe('uiThemeAt', () => {
  it('equals lightingAt().ui for every minute of the day', () => {
    for (let m = -1440; m < 2880; m++) {
      expect(uiThemeAt(m, MODEL), `minute ${m}`).toBe(lightingAt(m, MODEL).ui)
      expect(uiThemeAt(m, MODEL)).toBe(lightingAt(m, MODEL, { step: true }).ui)
    }
  })

  it('switches to night at dusk and back to day at dawn', () => {
    expect(uiThemeAt(at(18, 59), MODEL)).toBe('day')
    expect(uiThemeAt(at(19), MODEL)).toBe('night')
    expect(uiThemeAt(at(3), MODEL)).toBe('night')
    expect(uiThemeAt(at(5, 44), MODEL)).toBe('night')
    expect(uiThemeAt(at(5, 45), MODEL)).toBe('day')
  })
})

describe('resolveDayNight', () => {
  it('resolves every colour token to lowercase hex', () => {
    const dawn = DEFAULT_THEME_DAY_NIGHT.sky.dawn
    expect(keyframe('dawn').colors.sky).toBe(DEFAULT_THEME_DAY_NIGHT.colors[dawn.sky])
    for (const k of MODEL.keyframes) {
      for (const hex of Object.values(k.colors)) expect(hex).toMatch(/^#[0-9a-f]{6}$/)
    }
  })

  const scene = (patch: Partial<SceneDayNight>): SceneDayNight => ({
    ...DEFAULT_SCENE_DAY_NIGHT,
    ...patch,
  })
  const keyframes = DEFAULT_SCENE_DAY_NIGHT.keyframes

  it.each([
    ['an unknown token', scene({}), { ...DEFAULT_THEME_DAY_NIGHT, colors: {} }, /unknown colour/],
    [
      'keyframes out of order',
      scene({ keyframes: [...keyframes].reverse() }),
      DEFAULT_THEME_DAY_NIGHT,
      /clock order/,
    ],
    [
      'a hold that reaches the next keyframe',
      scene({ keyframes: keyframes.map((k) => (k.id === 'day' ? { ...k, holdMinutes: 450 } : k)) }),
      DEFAULT_THEME_DAY_NIGHT,
      /hold 450/,
    ],
    [
      'a step that does not divide the day',
      scene({ quantizeMinutes: 7 }),
      DEFAULT_THEME_DAY_NIGHT,
      /divide/,
    ],
    [
      'a duplicate keyframe',
      scene({ keyframes: [keyframes[0]!, { ...keyframes[0]!, atMinute: 400 }] }),
      DEFAULT_THEME_DAY_NIGHT,
      /twice/,
    ],
    [
      'an unknown ui theme',
      scene({ keyframes: keyframes.map((k) => ({ ...k, ui: 'dim' as 'day' })) }),
      DEFAULT_THEME_DAY_NIGHT,
      /unknown ui/,
    ],
    [
      'a glow out of range',
      scene({ keyframes: keyframes.map((k) => ({ ...k, nightGlow: 2 })) }),
      DEFAULT_THEME_DAY_NIGHT,
      /nightGlow/,
    ],
  ])('rejects %s', (_name, sceneInput, themeInput, message) => {
    expect(() => resolveDayNight(sceneInput, themeInput)).toThrow(message)
  })
})
