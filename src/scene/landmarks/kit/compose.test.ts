import { Color, ColorManagement } from 'three'
import { describe, expect, it } from 'vitest'
import { LANDMARK_ROLES } from '@/lib/data/schemas/landmarkModels'
import { PALETTE } from '../kit.fixture'
import type { LandmarkPalette } from '../types'
import { compose, roleColor } from './compose'
import { buildOutline } from './outline'
import { box, cable, windowGrid } from './primitives'

const parts = () => [
  box([0, 0, 0], [10, 10, 10], { role: 'stone' }),
  box([0, 10, 0], [10, 12, 10], { role: 'roof' }),
  windowGrid({
    origin: [0, 1, 0],
    right: [1, 0, 0],
    up: [0, 1, 0],
    normal: [0, 0, -1],
    width: 10,
    height: 8,
    rows: 2,
    cols: 2,
  }),
]

describe('compose', () => {
  it('merges body and windows apart and counts their triangles', () => {
    const composed = compose(parts(), PALETTE)
    expect(composed.body.getAttribute('position').count / 3).toBe(20)
    expect(composed.windows?.getAttribute('position').count).toBe(2 * 2 * 6)
    expect(composed.triangles).toBe(20 + 8)
    expect(composed.bounds.min.toArray()).toEqual([0, 0, 0])
    expect(composed.bounds.max.toArray()).toEqual([10, 12, 10])
    expect(composed.body.getAttribute('uv')).toBeUndefined()
  })

  it('paints each part with its role colour, converted to linear working space', () => {
    expect(ColorManagement.enabled).toBe(true)
    const composed = compose(parts(), PALETTE)
    const color = composed.body.getAttribute('color')
    const stone = new Color().setStyle(PALETTE.stone)
    const roof = new Color().setStyle(PALETTE.roof)
    expect([color.getX(0), color.getY(0), color.getZ(0)]).toEqual(
      [stone.r, stone.g, stone.b].map(Math.fround),
    )
    // The last vertex belongs to the roof box.
    const last = color.count - 1
    expect([color.getX(last), color.getY(last), color.getZ(last)]).toEqual(
      [roof.r, roof.g, roof.b].map(Math.fround),
    )
    // Linear, not the sRGB bytes of the hex.
    expect(stone.r).not.toBeCloseTo(parseInt(PALETTE.stone.slice(1, 3), 16) / 255, 3)
    const window = composed.windows?.getAttribute('color')
    expect(window?.getX(0)).toBeCloseTo(roleColor(PALETTE, 'window').r, 6)
  })

  it('maps every role through the palette', () => {
    const palette = Object.fromEntries(
      LANDMARK_ROLES.map((role, i) => [role, `#${String(i + 1).repeat(6)}`]),
    ) as LandmarkPalette
    for (const role of LANDMARK_ROLES) {
      expect(roleColor(palette, role).getHexString()).toBe(palette[role].slice(1))
    }
  })

  it('refuses a model with no body', () => {
    expect(() =>
      compose(
        [
          windowGrid({
            origin: [0, 0, 0],
            right: [1, 0, 0],
            up: [0, 1, 0],
            normal: [0, 0, -1],
            width: 1,
            height: 1,
            rows: 1,
            cols: 1,
          }),
        ],
        PALETTE,
      ),
    ).toThrow(/at least one body part/)
  })
})

describe('inverted-hull outline', () => {
  it('welds the outlined body, averages normals and pushes it out by the width', () => {
    const hull = buildOutline(parts(), 2)
    expect(hull).toBeDefined()
    // Two 10-triangle boxes, welded: indexed, the same triangles, positions only.
    expect(hull?.index?.count).toBe(20 * 3)
    expect(hull?.getAttribute('normal')).toBeUndefined()
    expect(hull?.getAttribute('color')).toBeUndefined()
    hull?.computeBoundingBox()
    // The corner (0, 0, 0) moves out along the averaged normal of its three faces.
    expect(hull?.boundingBox?.min.x).toBeLessThan(-0.5)
    expect(hull?.boundingBox?.max.y).toBeGreaterThan(12.5)
  })

  it('skips windows and cables, and returns nothing when no part is outlined', () => {
    expect(
      buildOutline(
        [
          cable(
            [
              [0, 0, 0],
              [0, 10, 0],
            ],
            1,
            'accent',
          ),
        ],
        1,
      ),
    ).toBeUndefined()
    const [, , windows] = parts()
    expect(buildOutline(windows === undefined ? [] : [windows], 1)).toBeUndefined()
  })
})
