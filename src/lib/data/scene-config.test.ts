/** data/config/scene.json and the scene block of theme.json. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { scenePalette } from '@/lib/theme'
import { scene, theme } from './config'
import { geoBounds, homes } from './content'
import { BOROUGHS } from './schemas/content'
import { ThemeConfigSchema } from './schemas/config'
import { SceneConfigSchema } from './schemas/scene'

const DATA = join(import.meta.dirname, '../../../data')
const readJson = (file: string) =>
  JSON.parse(readFileSync(join(DATA, file), 'utf8')) as Record<string, unknown>

describe('config/scene.json', () => {
  it('starts the camera over every home, inside the NYC extent (S05)', () => {
    expect('start' in scene.camera).toBe(false)
    for (const { location } of Object.values(homes)) {
      expect(location.lat).toBeGreaterThan(geoBounds.south)
      expect(location.lat).toBeLessThan(geoBounds.north)
      expect(location.lng).toBeGreaterThan(geoBounds.west)
      expect(location.lng).toBeLessThan(geoBounds.east)
    }
  })

  it('rejects an avatar whose ring is inverted or whose size range is upside down', () => {
    const valid = readJson('config/scene.json') as { avatar: Record<string, unknown> }
    const withAvatar = (avatar: Record<string, unknown>) => ({
      ...valid,
      avatar: { ...valid.avatar, ...avatar },
    })
    expect(SceneConfigSchema.safeParse(valid).success).toBe(true)
    expect(SceneConfigSchema.safeParse(withAvatar({ ringInnerRatio: 0.9 })).success).toBe(false)
    expect(SceneConfigSchema.safeParse(withAvatar({ minHeightM: 999 })).success).toBe(false)
  })

  it('rejects a start distance outside the zoom limits or an inverted angle range', () => {
    const valid = readJson('config/scene.json') as { camera: Record<string, unknown> }
    expect(SceneConfigSchema.safeParse(valid).success).toBe(true)
    const withCamera = (camera: Record<string, unknown>) => ({
      ...valid,
      camera: { ...valid.camera, ...camera },
    })
    expect(SceneConfigSchema.safeParse(withCamera({ distanceM: 1 })).success).toBe(false)
    expect(
      SceneConfigSchema.safeParse(withCamera({ polarDeg: { default: 48, min: 60, max: 12 } }))
        .success,
    ).toBe(false)
    expect(
      SceneConfigSchema.safeParse(withCamera({ polarDeg: { default: 48, min: 12, max: 95 } }))
        .success,
    ).toBe(false)
  })
})

describe('scene.json dayNight (S04f)', () => {
  type Keyframe = { id: string; atMinute: number; holdMinutes: number; ui: string }
  const valid = readJson('config/scene.json') as {
    dayNight: { quantizeMinutes: number; keyframes: Keyframe[] }
  }
  const withDayNight = (patch: Record<string, unknown>) => ({
    ...valid,
    dayNight: { ...valid.dayNight, ...patch },
  })
  const keyframes = valid.dayNight.keyframes
  const patchKeyframe = (index: number, patch: Partial<Keyframe>) =>
    keyframes.map((keyframe, i) => (i === index ? { ...keyframe, ...patch } : keyframe))

  it('accepts the shipped cycle: six keyframes in clock order, the UI flipping twice', () => {
    expect(SceneConfigSchema.safeParse(valid).success).toBe(true)
    expect(keyframes.map((keyframe) => keyframe.id)).toEqual([
      'dawn',
      'morning',
      'day',
      'golden',
      'dusk',
      'night',
    ])
  })

  it('rejects keyframes out of order, a hold into the next keyframe and a step that splits a day', () => {
    const swapped = [keyframes[1], keyframes[0], ...keyframes.slice(2)]
    expect(SceneConfigSchema.safeParse(withDayNight({ keyframes: swapped })).success).toBe(false)
    const late = patchKeyframe(1, { atMinute: (keyframes[2]?.atMinute ?? 0) + 1 })
    expect(SceneConfigSchema.safeParse(withDayNight({ keyframes: late })).success).toBe(false)
    const longHold = patchKeyframe(2, { holdMinutes: 2000 })
    expect(SceneConfigSchema.safeParse(withDayNight({ keyframes: longHold })).success).toBe(false)
    expect(SceneConfigSchema.safeParse(withDayNight({ quantizeMinutes: 7 })).success).toBe(false)
  })

  it('rejects a UI that switches theme more than once each way', () => {
    const flicker = patchKeyframe(2, { ui: 'night' })
    expect(SceneConfigSchema.safeParse(withDayNight({ keyframes: flicker })).success).toBe(false)
  })
})

describe('theme.json scene palette', () => {
  it('has a land colour for every borough', () => {
    expect(Object.keys(theme.scene.land).sort()).toEqual([...BOROUGHS].sort())
  })

  it('rejects a scene colour that names no token and a ramp that does not increase', () => {
    const valid = readJson('config/theme.json') as { scene: Record<string, unknown> }
    expect(ThemeConfigSchema.safeParse(valid).success).toBe(true)
    const withScene = (patch: Record<string, unknown>) => ({
      ...valid,
      scene: { ...valid.scene, ...patch },
    })
    expect(ThemeConfigSchema.safeParse(withScene({ water: 'nope-500' })).success).toBe(false)
    expect(ThemeConfigSchema.safeParse(withScene({ subwayLines: [] })).success).toBe(false)
    expect(ThemeConfigSchema.safeParse(withScene({ toonRamp: [0.6, 0.3] })).success).toBe(false)
  })

  it('resolves every scene token to its hex on the server', () => {
    const palette = scenePalette()
    const world: Record<string, string> = { ...theme.world, ...theme.models }
    expect(palette.water).toBe(world[theme.scene.water])
    expect(palette.land.queens).toBe(world[theme.scene.land.queens])
    expect(palette.haze).toBe(world[theme.scene.haze])
    expect(palette.subwayLines).toEqual(theme.scene.subwayLines.map((t) => world[t]))
    expect(palette.toonRamp).toEqual(theme.scene.toonRamp)
  })
})
