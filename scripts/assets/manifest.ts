/**
 * data/assets/manifest.json and the hashed files under public/models. Each tier's GLB is named
 * `<id>.<tier>.<sha8>.glb` after its content, so a changed model gets a new URL and long-lived
 * caching stays safe. Tiers that come out byte-identical share one file, named after the highest
 * such tier (a mesh too small to simplify ships once). `assetVersion` hashes the whole manifest.
 */
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import {
  MODEL_TIERS,
  ModelManifestSchema,
  type ModelManifest,
  type ModelManifestEntry,
  type ModelTier,
  type ModelTierFile,
} from '../../src/lib/data/schemas/assets.ts'
import type { BuiltModel } from './pipeline.ts'

export const MODELS_URL_PREFIX = '/models/'

const sha256Hex = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')

/** Gzip as `npm run budget` measures it (level 9). */
export const gzipSize = (bytes: Uint8Array) => gzipSync(bytes, { level: 9 }).byteLength

/** Highest tier first, so a shared file carries the name of the best tier it serves. */
const NAMING_ORDER: readonly ModelTier[] = ['high', 'mid', 'low']

export interface ManifestOutput {
  readonly manifest: ModelManifest
  /** Served path (/models/…) → bytes. */
  readonly files: ReadonlyMap<string, Uint8Array>
}

export function buildManifest(models: readonly BuiltModel[]): ManifestOutput {
  const files = new Map<string, Uint8Array>()
  const entries: ModelManifestEntry[] = models.map((built) => {
    const { model } = built
    const byHash = new Map<string, ModelTierFile>()
    const tierFiles = {} as Record<ModelTier, ModelTierFile>
    for (const tier of NAMING_ORDER) {
      const { bytes, triangles } = built.tiers[tier]
      const sha256 = sha256Hex(bytes)
      let file = byHash.get(sha256)
      if (file === undefined) {
        file = {
          file: `${MODELS_URL_PREFIX}${model.id}.${tier}.${sha256.slice(0, 8)}.glb`,
          sha256,
          bytes: bytes.byteLength,
          gzBytes: gzipSize(bytes),
          triangles,
        }
        byHash.set(sha256, file)
        files.set(file.file, bytes)
      }
      tierFiles[tier] = file
    }
    return {
      id: model.id,
      kind: model.kind,
      category: model.category,
      loadPhase: model.loadPhase,
      instanced: model.instanced,
      nameKey: model.nameKey,
      ...(built.bounds === undefined ? {} : { bounds: built.bounds }),
      slots: model.slots.map((slot) => slot.name),
      emissive: built.emissive,
      clips: model.clips,
      tiers: Object.fromEntries(MODEL_TIERS.map((tier) => [tier, tierFiles[tier]])) as Record<
        ModelTier,
        ModelTierFile
      >,
    }
  })
  const assetVersion = sha256Hex(JSON.stringify({ version: 1, models: entries })).slice(0, 16)
  const manifest = ModelManifestSchema.parse({ version: 1, assetVersion, models: entries })
  return { manifest, files }
}
