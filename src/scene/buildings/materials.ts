/**
 * District building and block materials (S04d): the city's surface shading (src/scene/shading.ts)
 * painted by vertex or instance colour. District walls get windows through the shared night-glow
 * contract (src/scene/lighting/nightGlow.ts, `'mask'` source): a small window mask texture,
 * repeated over the walls by their `uv` (one cell per storey and `windowSpacingM` of wall,
 * buildDistrict.ts), glows warm as the day/night rig raises `uNightGlow`. The mask's tile mixes
 * lit and dark windows (`litShare`), and its mipmaps fade far facades to an even glow instead of
 * shimmering. Blocks carry no windows: their unit box is stretched per instance, which would
 * stretch a mask with it.
 */
import {
  DataTexture,
  LinearMipmapLinearFilter,
  NearestFilter,
  NoColorSpace,
  RedFormat,
  RepeatWrapping,
  type IUniform,
  type MeshToonMaterial,
  type Texture,
} from 'three'
import type { SceneConfig } from '@/lib/data/schemas/scene'
import { patchNightGlow } from '../lighting/nightGlow'
import { createSurfaceMaterial } from '../shading'
import { massNoise } from './buildDistrict'

type BuildingsConfig = SceneConfig['buildings']

/** Pixels per window cell in the mask texture. */
const CELL_PX = 16

/**
 * The window mask: `windowTileCells` × `windowTileCells` cells, a window rectangle centred in
 * each, `litShare` of them lit (red 255) and the rest dark (0). Cell corners are always wall,
 * which is where roofs sample it (uv 0, 0).
 */
export function createWindowMask(config: BuildingsConfig): DataTexture {
  const cells = config.windowTileCells
  const size = cells * CELL_PX
  const data = new Uint8Array(size * size)
  const halfW = (config.windowWidth * CELL_PX) / 2
  const halfH = (config.windowHeight * CELL_PX) / 2
  for (let cy = 0; cy < cells; cy++) {
    for (let cx = 0; cx < cells; cx++) {
      if (massNoise(cy * cells + cx + 101) >= config.litShare) continue
      for (let y = 0; y < CELL_PX; y++) {
        for (let x = 0; x < CELL_PX; x++) {
          const dx = Math.abs(x + 0.5 - CELL_PX / 2)
          const dy = Math.abs(y + 0.5 - CELL_PX / 2)
          if (dx <= halfW && dy <= halfH) {
            data[(cy * CELL_PX + y) * size + cx * CELL_PX + x] = 255
          }
        }
      }
    }
  }
  const texture = new DataTexture(data, size, size, RedFormat)
  texture.colorSpace = NoColorSpace
  texture.wrapS = RepeatWrapping
  texture.wrapT = RepeatWrapping
  texture.magFilter = NearestFilter
  texture.minFilter = LinearMipmapLinearFilter
  texture.generateMipmaps = true
  texture.needsUpdate = true
  return texture
}

/** World size of one repeat of the mask on a wall: what buildDistrict divides by for `uv`. */
export function windowTile(config: BuildingsConfig): { readonly u: number; readonly v: number } {
  return {
    u: config.windowSpacingM * config.windowTileCells,
    v: config.floorM * config.windowTileCells,
  }
}

export interface BuildingMaterialOptions {
  readonly gradientMap: Texture
  /** `vertex`: merged district masses; `instance`: instanced blocks (instanceColor). */
  readonly colors: 'vertex' | 'instance'
  /** Window glow: the shared `uNightGlow` uniform, the mask and the light's colour. */
  readonly windows?: {
    readonly uniform: IUniform<number>
    readonly mask: Texture
    readonly color: string
  }
}

export function createBuildingMaterial(options: BuildingMaterialOptions): MeshToonMaterial {
  const material = createSurfaceMaterial({
    gradientMap: options.gradientMap,
    vertexColors: options.colors === 'vertex',
  })
  if (options.windows !== undefined) {
    patchNightGlow(material, 'mask', {
      uniform: options.windows.uniform,
      mask: options.windows.mask,
      color: options.windows.color,
    })
  }
  return material
}
