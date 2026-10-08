/**
 * Station concourse: generic entrance pavilions in a row along the front with a canopy between
 * them on supports, and an optional hall behind. No signage, no clock (LEGAL-1).
 */
import type { ParamsOf } from '@/lib/data/schemas/landmarkModels'
import { stationLayout } from '@/lib/landmarks/metrics'
import { arcade, box, boxFaceWindows, type Vec3 } from '../kit/primitives'
import type { ArchetypeFrame, LodLevel, Part } from '../types'

const ROOF_SLAB_M = 1
const ROOF_OVERHANG_M = 0.5
const GLASS_PROUD_M = 0.3
const SUPPORT_M = 0.8

export function stationConcourse(
  p: ParamsOf<'stationConcourse'>,
  level: LodLevel,
  frame: ArchetypeFrame,
): Part[] {
  const y0 = frame.landTopY
  const layout = stationLayout(p)
  const body = { role: p.roles.body }
  const glass = { role: p.roles.glass }
  const trim = { role: p.roles.trim }
  const canopyStyle = { role: p.roles.canopy }
  const { pavilions, canopy, hall } = p
  const front = layout.rowZ - pavilions.depthM / 2
  const pavilionBoxes = layout.pavilionXs.map((x) => ({
    min: [x - pavilions.widthM / 2, y0, front] as Vec3,
    max: [
      x + pavilions.widthM / 2,
      y0 + pavilions.heightM - ROOF_SLAB_M,
      front + pavilions.depthM,
    ] as Vec3,
  }))
  const hallBox = hall && {
    min: [-hall.widthM / 2, y0, layout.hallZ - hall.depthM / 2] as Vec3,
    max: [hall.widthM / 2, y0 + hall.heightM, layout.hallZ + hall.depthM / 2] as Vec3,
  }
  const canopyMin: Vec3 = [
    -canopy.lengthM / 2,
    y0 + canopy.heightM - canopy.thicknessM,
    layout.rowZ - canopy.widthM / 2,
  ]
  const canopyMax: Vec3 = [canopy.lengthM / 2, y0 + canopy.heightM, layout.rowZ + canopy.widthM / 2]

  if (level === 2) {
    return [
      ...pavilionBoxes.map(({ min, max }) =>
        box(min, [max[0], y0 + pavilions.heightM, max[2]], body),
      ),
      box(canopyMin, canopyMax, canopyStyle),
      ...(hallBox ? [box(hallBox.min, hallBox.max, body)] : []),
    ]
  }

  const parts: Part[] = [box(canopyMin, canopyMax, canopyStyle, { bottom: true })]
  for (const { min, max } of pavilionBoxes) {
    parts.push(box(min, max, body))
    parts.push(
      box(
        [min[0] - ROOF_OVERHANG_M, max[1], min[2] - ROOF_OVERHANG_M],
        [max[0] + ROOF_OVERHANG_M, max[1] + ROOF_SLAB_M, max[2] + ROOF_OVERHANG_M],
        trim,
        { bottom: true },
      ),
    )
    parts.push(
      box([min[0] + 1, y0 + 0.5, min[2] - GLASS_PROUD_M], [max[0] - 1, max[1] - 2, min[2]], glass),
    )
  }
  // Supports in two rows under the canopy's long edges.
  for (const row of [-1, 1]) {
    const z = layout.rowZ + row * (canopy.widthM / 2 - SUPPORT_M)
    for (let i = 0; i < canopy.supports; i++) {
      const x = -canopy.lengthM / 2 + ((i + 0.5) * canopy.lengthM) / canopy.supports
      parts.push(
        box(
          [x - SUPPORT_M / 2, y0, z - SUPPORT_M / 2],
          [x + SUPPORT_M / 2, canopyMin[1], z + SUPPORT_M / 2],
          canopyStyle,
          { top: false },
        ),
      )
    }
  }
  if (hallBox) {
    parts.push(box(hallBox.min, hallBox.max, body))
    parts.push(
      box(
        [
          hallBox.min[0] - ROOF_OVERHANG_M,
          hallBox.max[1] - ROOF_SLAB_M,
          hallBox.min[2] - ROOF_OVERHANG_M,
        ],
        [hallBox.max[0] + ROOF_OVERHANG_M, hallBox.max[1], hallBox.max[2] + ROOF_OVERHANG_M],
        trim,
      ),
    )
  }
  if (level === 1) return parts

  // A generic arched entrance framing each pavilion's glass front.
  for (const { min, max } of pavilionBoxes) {
    parts.push(
      arcade(
        min[0] + 0.5,
        max[0] - 0.5,
        1,
        y0,
        max[1] - 3,
        min[2] - GLASS_PROUD_M - 0.9,
        min[2] - GLASS_PROUD_M,
        1.2,
        1,
        trim,
      ),
    )
  }
  if (hallBox && hall) {
    const margins = { bottomM: 1, topM: ROOF_SLAB_M }
    parts.push(
      boxFaceWindows(hallBox.min, hallBox.max, '+z', hall.floors, hall.windowColumns, margins),
    )
    const sideColumns = Math.max(1, Math.round((hall.windowColumns * hall.depthM) / hall.widthM))
    parts.push(boxFaceWindows(hallBox.min, hallBox.max, '-x', hall.floors, sideColumns, margins))
    parts.push(boxFaceWindows(hallBox.min, hallBox.max, '+x', hall.floors, sideColumns, margins))
  }
  return parts
}
