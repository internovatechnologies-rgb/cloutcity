/**
 * Resolves data/assets/showcase.json for one view, time and tier (server only): theme tokens
 * become hex, model ids become ModelRefs, and placements group into one instanced draw per
 * model and recolour.
 */
import showcaseJson from '@data/assets/showcase.json'
import { scene, theme } from '@/lib/data/config'
import { modelManifest, modelRef, toModelRef } from '@/lib/data/models'
import { parseDataFile } from '@/lib/data/parse'
import { ShowcaseSchema } from '@/lib/data/schemas/assets'
import type { SlotColors } from '@/scene/models/slots'
import { slotColorsKey } from '@/scene/models/slots'
import type { ModelTier } from '@/scene/models/types'
import type { ShowcaseGroup, ShowcaseScene, ShowcaseTime, ShowcaseViewId } from './types'

export const showcase = parseDataFile('assets/showcase.json', ShowcaseSchema, showcaseJson)

const DEG = Math.PI / 180

export function tokenHex(token: string): string {
  const hex = theme.models[token]
  if (hex === undefined)
    throw new Error(`Unknown model colour token "${token}" (theme.json models)`)
  return hex
}

function slotHex(tokens: Readonly<Record<string, string>> | undefined): SlotColors | undefined {
  if (tokens === undefined) return undefined
  return Object.fromEntries(Object.entries(tokens).map(([slot, token]) => [slot, tokenHex(token)]))
}

export function resolveShowcase(
  view: ShowcaseViewId,
  time: ShowcaseTime,
  tier: ModelTier,
): ShowcaseScene {
  const data = showcase.views[view]
  const light = showcase.lighting[time]
  const groups = new Map<
    string,
    ShowcaseGroup & { placements: ShowcaseGroup['placements'][number][] }
  >()
  for (const placement of data.placements) {
    const colors = slotHex(placement.colors)
    const key = `${placement.model}|${slotColorsKey(colors)}`
    let group = groups.get(key)
    if (group === undefined) {
      group = { model: modelRef(placement.model), ...(colors && { colors }), placements: [] }
      groups.set(key, group)
    }
    group.placements.push({
      position: placement.position,
      ...(placement.rotationDeg !== undefined && { rotationY: placement.rotationDeg * DEG }),
      ...(placement.scale !== undefined && { scale: placement.scale }),
    })
  }
  const lineup = data.lineup
  const grid = data.grid
  return {
    view,
    time,
    tier,
    camera: data.camera,
    grounds: data.grounds.map((ground) => ({ ...ground, color: tokenHex(ground.color) })),
    groups: [...groups.values()],
    ...(lineup && {
      lineup: {
        columns: lineup.columns,
        spacingM: lineup.spacingM,
        rowDepthM: lineup.rowDepthM,
        clip: lineup.clip,
        rig: modelRef('avatar-rig'),
        avatars: lineup.avatars.map((avatar) => ({
          head: modelRef(avatar.head),
          body: modelRef(avatar.body),
          colors: { head: slotHex(avatar.colors.head), body: slotHex(avatar.colors.body) },
        })),
      },
    }),
    ...(grid && {
      grid: {
        cellM: grid.cellM,
        columns: grid.columns,
        models: modelManifest.models.filter((model) => model.kind === 'static').map(toModelRef),
      },
    }),
    light,
    nightGlow: light.glow === 'night' ? 1 : 0,
    models: scene.models,
  }
}
