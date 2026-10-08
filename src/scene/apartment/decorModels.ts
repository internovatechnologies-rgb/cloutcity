/**
 * Hand-made models for the apartment's decor (S16 + S04h), behind the visuals seam
 * (visuals.ts). ApartmentCanvas imports this module lazily, once the room is up, so the glTF
 * loader, the meshopt decoder and the model manifest load in their own chunk and never grow the
 * apartment chunk (perf.json `apartmentChunkJsGzKB`).
 *
 * scene.json `models.decor` names which decor items use a model and which model slot their
 * colour variant recolours; everything else (and everything, until the models arrive or if they
 * fail) keeps the code-built stand-in. The room shell stays code-built: its window and door sit
 * at each home's own data positions, which the fixed 2.1 m wall modules cannot follow.
 */
import manifestJson from '@data/assets/manifest.json'
import sceneJson from '@data/config/scene.json'
import { Group, Mesh, type IUniform, type Material, type Object3D } from 'three'
import type { QualityTier } from '@/lib/data/schemas/config'
import type { SceneConfig } from '@/lib/data/schemas/scene'
import { createModelMaterial } from '../models/materials'
import type { LoadedModel, StaticModel } from '../models/prepare'
import { acquireModels } from '../models/runtime'
import { disposeRecolored, recolorGeometry } from '../models/slots'
import type { ModelRef } from '../models/types'
import type { ApartmentVisuals, DecorVisual } from './visuals'

type ModelsConfig = SceneConfig['models']

function fail(what: string): never {
  throw new Error(`apartment decor models: ${what}`)
}

/**
 * scene.json `models`, narrowed from the loosely typed JSON import (the file itself is checked
 * against its zod schema in src/lib/data/data.test.ts; classic zod must not ship here).
 */
function modelsConfig(): ModelsConfig {
  const raw = sceneJson.models
  const material = (value: string) =>
    value === 'lambert' || value === 'standard' ? value : fail(`litMaterial ${value}`)
  const shading = raw.shading === 'lit' || raw.shading === 'toon' ? raw.shading : fail('shading')
  return {
    ...raw,
    shading,
    litMaterial: {
      low: material(raw.litMaterial.low),
      mid: material(raw.litMaterial.mid),
      high: material(raw.litMaterial.high),
    },
    player: {
      ...raw.player,
      capsuleTiers: raw.player.capsuleTiers.map((tier) =>
        tier === 'low' || tier === 'mid' || tier === 'high' ? tier : fail(`capsule tier ${tier}`),
      ),
    },
  }
}

interface DecorEntry {
  readonly ref: ModelRef
  readonly slot: string
  /** Half the model's width, for the mid tier's blob shadow. */
  readonly footprintM: number
}

/** Each mapped decor item's model, resolved from the manifest. */
export function decorEntries(): ReadonlyMap<string, DecorEntry> {
  const entries = new Map<string, DecorEntry>()
  for (const [itemId, { model, slot }] of Object.entries(sceneJson.models.decor)) {
    const entry = manifestJson.models.find((candidate) => candidate.id === model)
    if (entry === undefined || entry.kind !== 'static' || entry.bounds === undefined) {
      fail(`${itemId} names "${model}", which is not a static model in the manifest`)
    }
    const slots: readonly string[] = entry.slots
    if (!slots.includes(slot)) fail(`${model} has no slot "${slot}"`)
    const [minX = 0, minY = 0, minZ = 0] = entry.bounds?.min ?? []
    const [maxX = 0, maxY = 0, maxZ = 0] = entry.bounds?.max ?? []
    entries.set(itemId, {
      slot,
      footprintM: Math.max(maxX - minX, maxZ - minZ) / 2,
      ref: {
        id: entry.id,
        kind: 'static',
        category: entry.category as ModelRef['category'],
        slots,
        emissive: entry.emissive,
        clips: entry.clips,
        bounds: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
        files: {
          low: entry.tiers.low.file,
          mid: entry.tiers.mid.file,
          high: entry.tiers.high.file,
        },
      },
    })
  }
  return entries
}

export interface DecorModels {
  /** `placeholder` with every mapped decor item drawn by its model. */
  visuals(placeholder: ApartmentVisuals): ApartmentVisuals
  /** Releases the models and the shared material. */
  dispose(): void
}

const noRaycast: Object3D['raycast'] = () => {}

function decorVisual(model: StaticModel, entry: DecorEntry, color: string, material: Material) {
  const geometry = recolorGeometry(model.geometry, entry.ref.slots, { [entry.slot]: color })
  const mesh = new Mesh(geometry, material)
  // The model's own node transform (real-world scale over quantized positions).
  mesh.matrixAutoUpdate = false
  mesh.matrix.copy(model.matrix)
  mesh.raycast = noRaycast
  mesh.receiveShadow = true
  const object = new Group()
  object.add(mesh)
  object.raycast = noRaycast
  const visual: DecorVisual = {
    object,
    footprintM: entry.footprintM,
    setCastShadow(on) {
      mesh.castShadow = on
    },
    dispose() {
      disposeRecolored(model.geometry, geometry)
    },
  }
  return visual
}

/**
 * Loads every mapped decor model at `tier`. Rejects when any fails (the caller keeps the
 * stand-ins); the night glow follows `nightGlow` when given (the apartment's lamps).
 */
export async function loadDecorModels(
  tier: QualityTier,
  nightGlow?: IUniform<number>,
): Promise<DecorModels> {
  const config = modelsConfig()
  const entries = decorEntries()
  const ids = [...entries.keys()]
  const refs = ids.map((id) => entries.get(id)?.ref ?? fail(id))
  const acquired = acquireModels(refs, tier, config.cacheMaxEntries)
  let loaded: LoadedModel[]
  try {
    loaded = await acquired.models
  } catch (error) {
    acquired.release()
    throw error
  }
  const material = createModelMaterial({ config, tier, ...(nightGlow && { nightGlow }) })
  const models = new Map<string, StaticModel>()
  ids.forEach((id, i) => {
    const model = loaded[i]
    if (model?.kind !== 'static') fail(`${id} did not load as a static model`)
    models.set(id, model)
  })
  return {
    visuals(placeholder) {
      return {
        buildRoom: (layout, roomTier) => placeholder.buildRoom(layout, roomTier),
        buildDecor(itemId, color) {
          const model = models.get(itemId)
          const entry = entries.get(itemId)
          if (model === undefined || entry === undefined) {
            return placeholder.buildDecor(itemId, color)
          }
          return decorVisual(model, entry, color, material)
        },
        dispose: () => placeholder.dispose(),
      }
    },
    dispose() {
      material.dispose()
      acquired.release()
    },
  }
}
