/**
 * What the client scene needs to know about a hand-made model (S04h): a serialisable slice of
 * its data/assets/manifest.json entry, resolved on the server (src/lib/data/models.ts) and
 * passed down as props, so the browser never imports the manifest or its zod schema.
 */
import type { ModelManifestEntry, ModelTier } from '@/lib/data/schemas/assets'
import type { SceneConfig } from '@/lib/data/schemas/scene'

export type { ModelTier }

export interface ModelRef {
  readonly id: string
  readonly kind: ModelManifestEntry['kind']
  readonly category: ModelManifestEntry['category']
  /** Recolourable slot names, in `_SLOT` order (attribute value = index + 1). */
  readonly slots: readonly string[]
  readonly emissive: boolean
  readonly clips: readonly string[]
  /** Fitted bounds in metres; rigs have none. */
  readonly bounds?: {
    readonly min: readonly [number, number, number]
    readonly max: readonly [number, number, number]
  }
  /** The served GLB per quality tier (content-hashed, so cacheable forever). */
  readonly files: Readonly<Record<ModelTier, string>>
}

/** The `models` block of scene.json: shading, glow intensities and cache size. */
export type ModelsConfig = SceneConfig['models']
