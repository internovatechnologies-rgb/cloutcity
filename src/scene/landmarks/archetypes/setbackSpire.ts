/**
 * Setback tower (building): stacked tiers, each inset from the one below, with a ledge at each
 * setback and a plain tapered spire on top. The spire is a generic taper: no real crown is
 * reproduced.
 */
import type { ParamsOf } from '@/lib/data/schemas/landmarkModels'
import { box, boxFaceWindows, setbackBoxes, taperedBox } from '../kit/primitives'
import type { ArchetypeFrame, LodLevel, Part } from '../types'

const LEDGE_M = 1.5
const LEDGE_OVERHANG_M = 0.8
const SPIRE_TIP_M = 0.6

export function setbackSpire(
  p: ParamsOf<'setbackSpire'>,
  level: LodLevel,
  frame: ArchetypeFrame,
): Part[] {
  const body = { role: p.roles.body }
  const tiers = setbackBoxes([0, 0], p.widthM, p.depthM, frame.landTopY, p.tiers)
  const first = tiers[0]
  const second = tiers[1]
  const last = tiers[tiers.length - 1]
  if (first === undefined || second === undefined || last === undefined) {
    throw new Error('setbackSpire: needs at least two tiers')
  }
  if (level === 2) {
    return [
      box(first.min, first.max, body),
      box(second.min, [second.max[0], last.max[1], second.max[2]], body),
    ]
  }

  const parts: Part[] = tiers.map(({ min, max }) => box(min, max, body))
  parts.push(
    taperedBox(
      [0, 0],
      last.max[1],
      last.max[1] + p.spire.heightM,
      [p.spire.baseWidthM, p.spire.baseWidthM],
      [SPIRE_TIP_M, SPIRE_TIP_M],
      { role: p.roles.spire },
    ),
  )
  if (level === 1) return parts

  for (const { min, max } of tiers) {
    parts.push(
      box(
        [min[0] - LEDGE_OVERHANG_M, max[1] - LEDGE_M, min[2] - LEDGE_OVERHANG_M],
        [max[0] + LEDGE_OVERHANG_M, max[1], max[2] + LEDGE_OVERHANG_M],
        { role: p.roles.trim },
      ),
    )
    for (const face of ['-z', '+z', '-x', '+x'] as const) {
      parts.push(
        boxFaceWindows(min, max, face, p.windowRows, p.windowColumns, {
          bottomM: 1,
          topM: LEDGE_M,
        }),
      )
    }
  }
  return parts
}
