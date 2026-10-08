/**
 * Wedge tower (building): plain triangular massing, a truncated prow at the front, on a low
 * podium, with window grids on its three long faces. Nothing more: no cornice, no ornament
 * (LEGAL-1, depiction "massing").
 */
import type { ParamsOf } from '@/lib/data/schemas/landmarkModels'
import { prism, wallWindows, type Vec2 } from '../kit/primitives'
import type { ArchetypeFrame, LodLevel, Part } from '../types'

/** The footprint, prow at -z, base at +z, grown by `outset` on every side. */
function footprint(p: ParamsOf<'wedgeTower'>, outset: number): Vec2[] {
  const front = -p.lengthM / 2 - outset
  const back = p.lengthM / 2 + outset
  return [
    [-p.prowWidthM / 2 - outset, front],
    [p.prowWidthM / 2 + outset, front],
    [p.baseWidthM / 2 + outset, back],
    [-p.baseWidthM / 2 - outset, back],
  ]
}

export function wedgeTower(
  p: ParamsOf<'wedgeTower'>,
  level: LodLevel,
  frame: ArchetypeFrame,
): Part[] {
  const y0 = frame.landTopY
  const top = y0 + p.heightM
  const shaft = footprint(p, 0)
  if (level === 2) return [prism(shaft, y0, top, { role: p.roles.body })]

  const podiumTop = y0 + p.podiumHeightM
  const parts: Part[] = [
    prism(footprint(p, p.podiumOutsetM), y0, podiumTop, { role: p.roles.podium }),
    prism(shaft, podiumTop, top, { role: p.roles.body }),
  ]
  if (level === 1) return parts

  const [prowLeft, prowRight, baseRight, baseLeft] = shaft as [Vec2, Vec2, Vec2, Vec2]
  for (const [a, b] of [
    [prowRight, baseRight],
    [baseRight, baseLeft],
    [baseLeft, prowLeft],
  ] as const) {
    parts.push(wallWindows(a, b, podiumTop + 1, top - 1, p.floors, p.windowColumns, [0, 0]))
  }
  return parts
}
