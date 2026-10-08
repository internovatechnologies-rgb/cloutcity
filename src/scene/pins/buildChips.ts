/**
 * "Expanding soon" ground chips (S04c): one rounded label lying flat on each dimmed borough, at a
 * point inside its largest land polygon, all quads in one geometry (one draw call) sampling one
 * runtime atlas. The text comes from the server's copy (map.expandingSoon) as a prop, so the 3D
 * chunk carries no copy. three only, no React; the atlas needs a 2D canvas (browser).
 */
import { BufferAttribute, BufferGeometry, CanvasTexture, SRGBColorSpace } from 'three'
import { decodeRing, type DeltaPolygon } from '@/lib/geo/codec'
import { interiorPoint, polygonArea, type Polygon } from '@/lib/geo/polygon'
import type { LocalPoint } from '@/lib/geo/projection'
import type { SceneConfig } from '@/lib/data/schemas/scene'
import { LAY_FLAT_X } from '../geo/coords'

const FONT_STACK = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'

/** Where a borough's chip sits: inside its largest polygon (local metres). */
export function chipAnchor(polygons: readonly DeltaPolygon[]): LocalPoint | null {
  let largest: Polygon | undefined
  let largestArea = -Infinity
  for (const encoded of polygons) {
    const polygon = encoded.map(decodeRing)
    const area = polygonArea(polygon)
    if (area > largestArea) {
      largest = polygon
      largestArea = area
    }
  }
  return largest === undefined ? null : interiorPoint(largest)
}

/** One flat quad per anchor (facing up, reading north-up), all sampling the whole atlas. */
export function buildChipGeometry(
  anchors: readonly LocalPoint[],
  chips: Pick<SceneConfig['chips'], 'widthM' | 'heightM'>,
  y: number,
): BufferGeometry {
  const positions = new Float32Array(anchors.length * 12)
  const uvs = new Float32Array(anchors.length * 8)
  const index = new Uint16Array(anchors.length * 6)
  const halfW = chips.widthM / 2
  const halfH = chips.heightM / 2
  anchors.forEach((anchor, i) => {
    const west = anchor.x - halfW
    const east = anchor.x + halfW
    const south = anchor.y - halfH
    const north = anchor.y + halfH
    // Counter-clockwise in the XY plane (SW, SE, NE, NW) so the quad faces up once laid flat.
    positions.set([west, south, 0, east, south, 0, east, north, 0, west, north, 0], i * 12)
    uvs.set([0, 0, 1, 0, 1, 1, 0, 1], i * 8)
    const v = i * 4
    index.set([v, v + 1, v + 2, v, v + 2, v + 3], i * 6)
  })
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(positions, 3))
  geometry.setAttribute('uv', new BufferAttribute(uvs, 2))
  geometry.setIndex(new BufferAttribute(index, 1))
  geometry.rotateX(LAY_FLAT_X)
  geometry.translate(0, y, 0)
  return geometry
}

/** The chip artwork: a rounded plate in `fill` with `text` in `ink`, drawn once at runtime. */
export function createChipTexture(
  text: string,
  fill: string,
  ink: string,
  chips: SceneConfig['chips'],
): CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = chips.atlasWidthPx
  canvas.height = chips.atlasHeightPx
  const context = canvas.getContext('2d')
  if (context === null) throw new Error('chips: 2D canvas is unavailable')
  const { width, height } = canvas
  context.fillStyle = fill
  context.beginPath()
  context.roundRect(0, 0, width, height, height * chips.cornerRadius)
  context.fill()
  context.fillStyle = ink
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.font = `800 ${Math.round(height * chips.fontScale)}px ${FONT_STACK}`
  context.fillText(text, width / 2, height / 2, width * chips.textMaxWidth)
  const texture = new CanvasTexture(canvas)
  texture.colorSpace = SRGBColorSpace
  return texture
}
