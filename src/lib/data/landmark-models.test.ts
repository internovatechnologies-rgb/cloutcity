/**
 * data/landmarks/models.json and the S07a config: one model per modelled landmark, archetypes
 * matching categories, palette roles within each category's allowlist, no names or text
 * anywhere (LEGAL-1), and the LOD / budget / palette config rules.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import landmarkCopy from '@data/copy/landmarks/base.json'
import modelsJson from '@data/landmarks/models.json'
import perfJson from '@data/config/perf.json'
import sceneJson from '@data/config/scene.json'
import themeJson from '@data/config/theme.json'
import { landmarks } from './content'
import { PerfConfigSchema, ThemeConfigSchema } from './schemas/config'
import {
  ARCHETYPE_CATEGORY,
  CATEGORY_ROLES,
  LANDMARK_FOCUS_DISTANCE_M,
  LandmarkModelsFileSchema,
  LandmarkSceneConfigSchema,
  landmarkModelsFileSchemaFor,
} from './schemas/landmarkModels'
import { modelTopM } from '@/lib/landmarks/metrics'

const MODELLED = [
  'brooklyn-bridge',
  'manhattan-bridge',
  'queensboro-bridge',
  'wedge-building',
  'deco-spire',
  'midtown-terminal',
  'penn-station',
  'jamaica-station',
  'staten-island-ferry',
  'city-hall',
  'brooklyn-borough-hall',
  'queens-borough-hall',
]

const schema = landmarkModelsFileSchemaFor(landmarks)
const models = schema.parse(modelsJson).models
const clone = <T>(value: T): T => structuredClone(value)
type Raw = { models: Record<string, unknown>[] }
const raw = () => clone(modelsJson) as unknown as Raw

describe('data/landmarks/models.json', () => {
  it('has exactly one model per bridge, building, station and government landmark', () => {
    expect(models.map((m) => m.id).sort()).toEqual([...MODELLED].sort())
    const fromLandmarks = landmarks
      .filter((l) => ['bridge', 'building', 'station', 'government'].includes(l.category))
      .map((l) => l.id)
      .sort()
    expect(fromLandmarks).toEqual([...MODELLED].sort())
  })

  it('every archetype depicts its landmark’s category', () => {
    for (const model of models) {
      expect(landmarks.find((l) => l.id === model.id)?.category).toBe(
        ARCHETYPE_CATEGORY[model.archetype],
      )
    }
  })

  it('rejects a missing model, an extra model and an archetype of another category', () => {
    const missing = raw()
    missing.models.pop()
    expect(schema.safeParse(missing).success).toBe(false)
    const extra = raw()
    extra.models.push({ ...clone(extra.models[0] ?? {}), id: 'times-square' })
    expect(schema.safeParse(extra).success).toBe(false)
    const swapped = raw()
    const hall = swapped.models.find((m) => m.id === 'city-hall')
    const station = swapped.models.find((m) => m.id === 'penn-station')
    if (hall && station) {
      hall.archetype = station.archetype
      hall.params = clone(station.params)
    }
    expect(schema.safeParse(swapped).success).toBe(false)
    expect(LandmarkModelsFileSchema.safeParse(swapped).success).toBe(true)
  })

  it('rejects a role outside the category allowlist and a role the kit owns', () => {
    for (const role of ['glass', 'window', 'outline']) {
      const bad = raw()
      const hall = bad.models.find((m) => m.id === 'city-hall') as {
        params: { roles: Record<string, string> }
      }
      hall.params.roles.body = role
      expect(LandmarkModelsFileSchema.safeParse(bad).success, role).toBe(false)
    }
    expect(CATEGORY_ROLES.government).not.toContain('glass')
  })

  it('LEGAL-1: the wedge and the midtown terminal are plain massing', () => {
    expect(models.find((m) => m.id === 'wedge-building')?.depiction).toBe('massing')
    expect(models.find((m) => m.id === 'midtown-terminal')?.depiction).toBe('massing')
    const bad = raw()
    const wedge = bad.models.find((m) => m.id === 'wedge-building')
    if (wedge) wedge.depiction = 'stylised'
    expect(LandmarkModelsFileSchema.safeParse(bad).success).toBe(false)
  })

  it('bridges use main-roadway segments only: a ramp segment type is rejected', () => {
    const bad = raw()
    const bridge = bad.models.find((m) => m.id === 'brooklyn-bridge') as {
      frame: { segmentTypes: string[] }
    }
    bridge.frame.segmentTypes = ['G', 'E']
    expect(LandmarkModelsFileSchema.safeParse(bad).success).toBe(false)
  })

  it('a fronting street must be one of the pinned LION queries', () => {
    const bad = raw()
    const hall = bad.models.find((m) => m.id === 'city-hall') as { frame: { street: string } }
    hall.frame.street = 'BROADWAY'
    expect(LandmarkModelsFileSchema.safeParse(bad).success).toBe(false)
  })

  it('carries no names: every string is an enum token, never a landmark or brand name', () => {
    const names = Object.entries(landmarkCopy.strings)
      .filter(([key]) => key.endsWith('.name'))
      .map(([, value]) => value.toLowerCase())
    const brands = ['flatiron', 'chrysler', 'grand central', 'empire', 'madison', 'moynihan']
    const strings: string[] = []
    const walk = (value: unknown, key: string) => {
      if (typeof value === 'string') {
        // LION street names are lookup keys into the pinned source, validated as an enum.
        if (key !== 'street') strings.push(value)
        return
      }
      if (Array.isArray(value)) value.forEach((v) => walk(v, key))
      else if (value !== null && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) {
          strings.push(k)
          walk(v, k)
        }
      }
    }
    walk(modelsJson, '')
    for (const text of strings) {
      expect(text, text).toMatch(/^[A-Za-z0-9-]+$/)
      const lower = text.toLowerCase()
      for (const name of [...names, ...brands]) expect(lower, text).not.toContain(name)
    }
    const text = JSON.stringify(modelsJson).toLowerCase()
    for (const brand of brands) expect(text).not.toContain(brand)
  })

  it('has no keys for text, signage, logos, clocks, sculpture or crowns', () => {
    const keys = JSON.stringify(modelsJson).match(/"[A-Za-z]+":/g) ?? []
    for (const key of keys) {
      expect(key).not.toMatch(/clock|sign|logo|text|label|sculpt|statue|crown|name|colou?r|hex/i)
    }
  })

  it('a Wikidata height is the model’s top height', () => {
    const sourced = models.filter((m) => m.heightSource !== undefined)
    expect(sourced.map((m) => m.id).sort()).toEqual([
      'brooklyn-bridge',
      'deco-spire',
      'manhattan-bridge',
      'queensboro-bridge',
      'wedge-building',
    ])
    for (const model of sourced) {
      expect(modelTopM(model), model.id).toBeCloseTo(model.heightSource?.valueM ?? 0, 6)
    }
  })

  it('every model is cited in data/landmarks/SOURCES.md', () => {
    const md = readFileSync(join(import.meta.dirname, '../../../data/landmarks/SOURCES.md'), 'utf8')
    expect(md).toContain('## Model heights')
    for (const model of models) expect(md).toContain(`\`${model.id}\``)
    for (const model of models) {
      if (model.heightSource) expect(md).toContain(model.heightSource.qid)
    }
  })
})

describe('config/scene.json landmarks', () => {
  const config = LandmarkSceneConfigSchema.parse(sceneJson.landmarks)
  const valid = () => clone(sceneJson.landmarks)

  it('culls every tier beyond the S04c focus distance, bridges further still', () => {
    for (const tier of Object.values(config.lod)) {
      expect(tier.cullM).toBeGreaterThan(LANDMARK_FOCUS_DISTANCE_M)
    }
    expect(config.bridgeDistanceMultiplier).toBe(2)
    expect(config.heightScale).toBe(1)
  })

  it('switch distances start at 0 and strictly increase up to the cull', () => {
    for (const tier of Object.values(config.lod)) {
      const list = [...tier.distancesM, tier.cullM]
      expect(list[0]).toBe(0)
      list.slice(1).forEach((value, i) => expect(value).toBeGreaterThan(list[i] ?? Infinity))
    }
    expect(config.lod.low.distancesM).toHaveLength(2)
    expect(config.lod.mid.distancesM).toHaveLength(3)
    expect(config.lod.high.distancesM).toHaveLength(3)
  })

  it('rejects a cull inside the focus distance and non-increasing distances', () => {
    const near = valid()
    near.lod.mid.cullM = LANDMARK_FOCUS_DISTANCE_M
    expect(LandmarkSceneConfigSchema.safeParse(near).success).toBe(false)
    const flat = valid()
    flat.lod.high.distancesM = [0, 1800, 1800]
    expect(LandmarkSceneConfigSchema.safeParse(flat).success).toBe(false)
    const cullBelow = valid()
    cullBelow.lod.low.cullM = 1500
    expect(LandmarkSceneConfigSchema.safeParse(cullBelow).success).toBe(false)
  })

  it('never outlines or lights windows on low', () => {
    expect(config.outline.low).toBe(false)
    expect(config.windows.low).toBe(false)
    const bad = valid() as { outline: Record<string, boolean> }
    bad.outline.low = true
    expect(LandmarkSceneConfigSchema.safeParse(bad).success).toBe(false)
  })
})

describe('config/perf.json landmark budgets', () => {
  it('holds the S07a caps and LOD ratio', () => {
    expect(perfJson.landmarkTrianglesMax.bridge).toEqual({ low: 1200, mid: 3500, high: 7000 })
    expect(perfJson.landmarkLodRatioMax).toBe(0.5)
  })

  it('rejects an unknown category key and a bad override', () => {
    const extra = clone(perfJson) as Record<string, unknown> & {
      landmarkTrianglesMax: Record<string, unknown>
    }
    extra.landmarkTrianglesMax.monument = { low: 1, mid: 1, high: 1 }
    expect(PerfConfigSchema.safeParse(extra).success).toBe(false)
    const override = { ...clone(perfJson), landmarkTrianglesOverride: { 'city-hall': { low: 1 } } }
    expect(PerfConfigSchema.safeParse(override).success).toBe(false)
    const ratio = { ...clone(perfJson), landmarkLodRatioMax: 1.5 }
    expect(PerfConfigSchema.safeParse(ratio).success).toBe(false)
  })
})

describe('config/theme.json scene.landmarks', () => {
  it('names a world token for every role', () => {
    const theme = ThemeConfigSchema.parse(themeJson)
    for (const token of Object.values(theme.scene.landmarks)) {
      expect(theme.world[token] ?? theme.models[token]).toMatch(/^#[0-9a-f]{6}$/i)
    }
  })

  it('rejects a role naming an unknown token, and a missing role', () => {
    const unknown = clone(themeJson)
    unknown.scene.landmarks.stone = 'stone-999'
    expect(ThemeConfigSchema.safeParse(unknown).success).toBe(false)
    const missing = clone(themeJson) as { scene: { landmarks: Record<string, string> } }
    delete missing.scene.landmarks.dimmed
    expect(ThemeConfigSchema.safeParse(missing).success).toBe(false)
  })
})
