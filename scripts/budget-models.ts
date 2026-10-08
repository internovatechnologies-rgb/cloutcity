/**
 * The hand-made model lines of `npm run budget` (S04h). Model bytes come from
 * data/assets/manifest.json (gzipped sizes measured by `npm run assets:build`), per quality tier
 * and per load phase, with each file counted once:
 *
 * - `playable`: models fetched before the map is playable (the six building blocks and the
 *   rig), checked against perf.json `totalBytesToPlayableGzKB` for that tier. They are only part
 *   of that total (JS and geo count too; `npm run e2e:perf` measures the whole), so this line
 *   fails only if the models alone break it.
 * - `player avatar`: the rig, head and body of scene.json `models.player`, loaded once the map
 *   has drawn (off the playable path).
 * - `after-playable`, `apartment`, `creator`: reported, never on the playable path.
 *
 * It also fails when the model loader reaches the shell JS: GLTFLoader and the meshopt decoder
 * belong in lazy chunks only.
 */
import { z } from 'zod'
import {
  MODEL_LOAD_PHASES,
  MODEL_TIERS,
  ModelManifestSchema,
  type ModelManifest,
  type ModelTier,
} from '../src/lib/data/schemas/assets.ts'
import { PerfConfigSchema } from '../src/lib/data/schemas/config.ts'

/** Strings only the glTF loader carries (extension names it registers), minified or not. */
export const MODEL_LOADER_MARKERS = ['EXT_meshopt_compression', 'KHR_materials_emissive_strength']

export interface ModelPhaseBytes {
  readonly phase: string
  readonly tier: ModelTier
  readonly files: number
  readonly gzBytes: number
}

/** Gzipped bytes per tier for the models matching `include`, each file counted once. */
export function modelBytes(
  manifest: ModelManifest,
  tier: ModelTier,
  include: (model: ModelManifest['models'][number]) => boolean,
): { files: number; gzBytes: number } {
  const seen = new Map<string, number>()
  for (const model of manifest.models) {
    if (!include(model)) continue
    const file = model.tiers[tier]
    seen.set(file.file, file.gzBytes)
  }
  return { files: seen.size, gzBytes: [...seen.values()].reduce((sum, bytes) => sum + bytes, 0) }
}

export function phaseBytes(manifest: ModelManifest): ModelPhaseBytes[] {
  return MODEL_LOAD_PHASES.flatMap((phase) =>
    MODEL_TIERS.map((tier) => ({
      phase,
      tier,
      ...modelBytes(manifest, tier, (model) => model.loadPhase === phase),
    })),
  )
}

/** The JS files (by name) that carry the model loader. */
export function loaderLeaks(files: ReadonlyMap<string, string>): string[] {
  return [...files.entries()]
    .filter(([, code]) => MODEL_LOADER_MARKERS.some((marker) => code.includes(marker)))
    .map(([name]) => name)
}

const PlayerSchema = z.object({
  models: z.object({ player: z.object({ head: z.string(), body: z.string() }) }),
})
const PlayableLimitSchema = z.object({
  totalBytesToPlayableGzKB: PerfConfigSchema.shape.totalBytesToPlayableGzKB,
})

export interface ModelBudgetLine {
  readonly text: string
  readonly ok: boolean
}

const kb = (bytes: number) => (bytes / 1000).toFixed(1)

/** Every model line of the budget report; `ok: false` lines fail `npm run budget`. */
export function modelBudgetLines(
  manifestJson: unknown,
  perfJson: unknown,
  sceneJson: unknown,
  shellFiles: ReadonlyMap<string, string>,
): ModelBudgetLine[] {
  const manifest = ModelManifestSchema.parse(manifestJson)
  const limits = PlayableLimitSchema.parse(perfJson).totalBytesToPlayableGzKB
  const player = PlayerSchema.parse(sceneJson).models.player
  const avatarIds = new Set(['avatar-rig', player.head, player.body])
  for (const id of avatarIds) {
    if (!manifest.models.some((model) => model.id === id)) {
      throw new Error(`scene.json models.player names "${id}", which is not in the manifest`)
    }
  }
  const lines: ModelBudgetLine[] = []
  for (const tier of MODEL_TIERS) {
    const playable = modelBytes(manifest, tier, (model) => model.loadPhase === 'playable')
    const ok = playable.gzBytes <= limits[tier] * 1000
    lines.push({
      ok,
      text: `${ok ? 'PASS' : 'FAIL'} Models on the playable path (${tier}): ${kb(playable.gzBytes)} KB gz in ${playable.files} files (bytes-to-playable limit ${limits[tier]} KB, shared with JS and geo)`,
    })
  }
  for (const tier of MODEL_TIERS) {
    const avatar = modelBytes(manifest, tier, (model) => avatarIds.has(model.id))
    lines.push({
      ok: true,
      text: `INFO Player avatar after the map draws (${tier}): ${kb(avatar.gzBytes)} KB gz in ${avatar.files} files`,
    })
  }
  for (const entry of phaseBytes(manifest)) {
    if (entry.phase === 'playable') continue
    lines.push({
      ok: true,
      text: `INFO Models loaded ${entry.phase} (${entry.tier}): ${kb(entry.gzBytes)} KB gz in ${entry.files} files`,
    })
  }
  const leaks = loaderLeaks(shellFiles)
  lines.push({
    ok: leaks.length === 0,
    text:
      leaks.length === 0
        ? 'PASS Model loader stays out of the shell JS'
        : `FAIL Model loader reached the shell JS: ${leaks.join(', ')}`,
  })
  return lines
}
