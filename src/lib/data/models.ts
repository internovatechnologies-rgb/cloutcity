/**
 * Validated data/assets/manifest.json (S04h) for server code. The scene receives only the
 * ModelRefs it renders, as props, so neither the manifest nor classic zod reaches the browser.
 */
import catalogJson from '@data/assets/catalog.json'
import manifestJson from '@data/assets/manifest.json'
import { z } from 'zod'
import type { ModelRef } from '@/scene/models/types'
import { parseDataFile } from './parse'
import { ModelManifestSchema, type ModelManifestEntry } from './schemas/assets'

export const modelManifest = parseDataFile(
  'assets/manifest.json',
  ModelManifestSchema,
  manifestJson,
)

const byId = new Map(modelManifest.models.map((model) => [model.id, model]))

export function toModelRef(model: ModelManifestEntry): ModelRef {
  return {
    id: model.id,
    kind: model.kind,
    category: model.category,
    slots: model.slots,
    emissive: model.emissive,
    clips: model.clips,
    ...(model.bounds === undefined ? {} : { bounds: model.bounds }),
    files: {
      low: model.tiers.low.file,
      mid: model.tiers.mid.file,
      high: model.tiers.high.file,
    },
  }
}

/** The ModelRef of a manifest id; throws on an unknown id (a config typo fails the build). */
export function modelRef(id: string): ModelRef {
  const model = byId.get(id)
  if (model === undefined) throw new Error(`Unknown model id "${id}" (data/assets/manifest.json)`)
  return toModelRef(model)
}

const CreditSourcesSchema = z.object({
  sources: z.array(
    z.object({
      title: z.string().min(1),
      version: z.string().min(1),
      author: z.string().min(1),
      homepage: z.url(),
      licence: z.enum(['CC0-1.0', 'MIT', 'project-original']),
    }),
  ),
})

/**
 * Who made the hand-made models, for /credits: every pack and our own Blender models, from
 * data/assets/catalog.json (the full record is data/assets/SOURCES.md).
 */
export const modelCredits = parseDataFile(
  'assets/catalog.json',
  CreditSourcesSchema,
  catalogJson,
).sources.map(({ title, version, author, homepage, licence }) => ({
  title,
  version,
  author,
  homepage,
  licence,
}))
