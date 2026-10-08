/**
 * Terminal hall (station): a main hall under a low gabled roof with plain arched openings on
 * its front and a lower wing each side. A generic hall: no sculpture group, no clock, no
 * signage (LEGAL-1).
 */
import type { ParamsOf } from '@/lib/data/schemas/landmarkModels'
import { arcade, box, boxFaceWindows, gable, type Vec3 } from '../kit/primitives'
import type { ArchetypeFrame, LodLevel, Part } from '../types'

const CORNICE_M = 1.5
const CORNICE_OVERHANG_M = 0.8
const JAMB_M = 3
const LINTEL_M = 2.5
const PORTAL_DEPTH_M = 1.5

export function terminalHall(
  p: ParamsOf<'terminalHall'>,
  level: LodLevel,
  frame: ArchetypeFrame,
): Part[] {
  const y0 = frame.landTopY
  const body = { role: p.roles.body }
  const trim = { role: p.roles.trim }
  const hallMin: Vec3 = [-p.widthM / 2, y0, -p.depthM / 2]
  const hallMax: Vec3 = [p.widthM / 2, y0 + p.heightM, p.depthM / 2]
  const wings = [-1, 1].map((side) => {
    const cx = side * (p.widthM / 2 + p.wings.widthM / 2)
    return {
      min: [cx - p.wings.widthM / 2, y0, -p.wings.depthM / 2] as Vec3,
      max: [cx + p.wings.widthM / 2, y0 + p.wings.heightM, p.wings.depthM / 2] as Vec3,
    }
  })
  const outer = p.widthM / 2 + p.wings.widthM
  if (level === 2) {
    return [
      box(hallMin, hallMax, body),
      box(
        [-outer, y0, -p.wings.depthM / 2],
        [outer, y0 + p.wings.heightM, p.wings.depthM / 2],
        body,
      ),
    ]
  }

  const front = hallMin[2]
  const arcadeWidth = p.arches.count * p.arches.widthM + (p.arches.count + 1) * JAMB_M
  const parts: Part[] = [
    box(hallMin, hallMax, body),
    gable(hallMin[0], hallMax[0], hallMin[2], hallMax[2], hallMax[1], p.roof.heightM, 'x', {
      role: p.roles.roof,
    }),
    ...wings.map(({ min, max }) => box(min, max, body)),
    box(
      [hallMin[0] - CORNICE_OVERHANG_M, hallMax[1] - CORNICE_M, hallMin[2] - CORNICE_OVERHANG_M],
      [hallMax[0] + CORNICE_OVERHANG_M, hallMax[1], hallMax[2] + CORNICE_OVERHANG_M],
      trim,
    ),
  ]
  if (level === 1) {
    parts.push(
      box(
        [-arcadeWidth / 2, y0, front - PORTAL_DEPTH_M],
        [arcadeWidth / 2, y0 + p.arches.heightM + LINTEL_M, front],
        trim,
      ),
    )
    return parts
  }

  parts.push(
    arcade(
      -arcadeWidth / 2,
      arcadeWidth / 2,
      p.arches.count,
      y0,
      y0 + p.arches.heightM,
      front - PORTAL_DEPTH_M,
      front,
      JAMB_M,
      LINTEL_M,
      trim,
    ),
  )
  for (const { min, max } of wings) {
    parts.push(
      box(
        [min[0] - CORNICE_OVERHANG_M, max[1] - CORNICE_M, min[2] - CORNICE_OVERHANG_M],
        [max[0] + CORNICE_OVERHANG_M, max[1], max[2] + CORNICE_OVERHANG_M],
        trim,
      ),
    )
    parts.push(
      boxFaceWindows(min, max, '-z', p.floors, p.windowColumns, { bottomM: 1, topM: CORNICE_M }),
    )
  }
  parts.push(
    boxFaceWindows(hallMin, hallMax, '+z', p.floors, p.windowColumns, {
      bottomM: 1,
      topM: CORNICE_M,
    }),
  )
  return parts
}
