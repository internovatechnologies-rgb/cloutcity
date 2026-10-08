/**
 * The shared toon gradient (the sticker look): one texel per brightness step. MeshToonMaterial
 * samples its red channel and needs nearest filtering (no mipmaps) for hard steps. Its own module
 * so the apartment's chunk (S16) can use it without the city's line materials.
 */
import { DataTexture, NearestFilter, RedFormat } from 'three'

export function createToonRamp(steps: readonly number[]): DataTexture {
  const data = new Uint8Array(steps.map((step) => Math.round(step * 255)))
  const texture = new DataTexture(data, steps.length, 1, RedFormat)
  texture.minFilter = NearestFilter
  texture.magFilter = NearestFilter
  texture.generateMipmaps = false
  texture.needsUpdate = true
  return texture
}
