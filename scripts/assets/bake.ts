/**
 * Bakes a primitive's material colour (base colour factor × atlas texel × any vertex colour)
 * into one linear colour per triangle, so models ship without textures (no KTX2, no images).
 *
 * The packs colour low-poly faces from small palette or gradient atlases: each face's UVs sit
 * inside one swatch, but its corners may lie exactly on a swatch edge. Sampling the atlas at each
 * triangle's UV centroid (nearest texel) reads the swatch the artist meant; sampling at the
 * corners would bleed neighbouring swatches in.
 */
import type { Primitive, Texture, TextureInfo } from '@gltf-transform/core'
import type { Transform } from '@gltf-transform/extensions'
import { decodePng, type DecodedPng } from './png.ts'
import { srgbToLinear, type Rgb } from './harmonise.ts'

const REPEAT = 10497
const CLAMP_TO_EDGE = 33071
const MIRRORED_REPEAT = 33648
const TRIANGLES = 4

/** Decodes each texture once per build. */
export class TextureCache {
  readonly #decoded = new Map<Texture, DecodedPng>()

  get(texture: Texture): DecodedPng {
    let decoded = this.#decoded.get(texture)
    if (decoded === undefined) {
      const image = texture.getImage()
      if (image === null) throw new Error(`texture ${texture.getURI()} has no image data`)
      if (texture.getMimeType() !== 'image/png') {
        throw new Error(`texture ${texture.getURI()}: only PNG atlases are supported`)
      }
      decoded = decodePng(image)
      this.#decoded.set(texture, decoded)
    }
    return decoded
  }
}

function wrap(coord: number, mode: number): number {
  if (mode === CLAMP_TO_EDGE) return Math.min(1, Math.max(0, coord))
  if (mode === MIRRORED_REPEAT) {
    const period = coord - 2 * Math.floor(coord / 2)
    return period > 1 ? 2 - period : period
  }
  if (mode !== REPEAT) throw new Error(`unknown texture wrap mode ${mode}`)
  return coord - Math.floor(coord)
}

/** The texel nearest to a UV, as linear RGB (glTF UV origin is the image's top-left). */
export function sampleTexel(image: DecodedPng, u: number, v: number, info: TextureInfo): Rgb {
  const x = Math.min(image.width - 1, Math.floor(wrap(u, info.getWrapS()) * image.width))
  const y = Math.min(image.height - 1, Math.floor(wrap(v, info.getWrapT()) * image.height))
  const o = (y * image.width + x) * 4
  return [
    srgbToLinear((image.rgba[o] ?? 0) / 255),
    srgbToLinear((image.rgba[o + 1] ?? 0) / 255),
    srgbToLinear((image.rgba[o + 2] ?? 0) / 255),
  ]
}

/** Vertex indices of the primitive's triangles (three per triangle). */
export function triangleIndices(prim: Primitive): Uint32Array {
  if (prim.getMode() !== TRIANGLES) throw new Error('only triangle lists are supported')
  const indices = prim.getIndices()
  if (indices !== null) return Uint32Array.from(indices.getArray() ?? [])
  const count = prim.getAttribute('POSITION')?.getCount() ?? 0
  return Uint32Array.from({ length: count }, (_, i) => i)
}

/**
 * One linear colour per triangle of `prim`. `factorEncoding` says how the pack stored base colour
 * factors (glTF requires linear; some older exports wrote sRGB).
 */
export function triangleColours(
  prim: Primitive,
  textures: TextureCache,
  factorEncoding: 'linear' | 'srgb',
): Rgb[] {
  const indices = triangleIndices(prim)
  const material = prim.getMaterial()
  const raw = material?.getBaseColorFactor() ?? [1, 1, 1, 1]
  const factor = factorEncoding === 'srgb' ? raw.map((c, i) => (i < 3 ? srgbToLinear(c) : c)) : raw
  const texture = material?.getBaseColorTexture() ?? null
  const info = material?.getBaseColorTextureInfo() ?? null
  const vertexColour = prim.getAttribute('COLOR_0')

  let uv: ReturnType<Primitive['getAttribute']> = null
  let offset = [0, 0]
  let scale = [1, 1]
  if (texture !== null && info !== null) {
    const transform = info.getExtension<Transform>('KHR_texture_transform')
    if (transform !== null && transform.getRotation() !== 0) {
      throw new Error('KHR_texture_transform rotation is not supported')
    }
    const texCoord = transform?.getTexCoord() ?? info.getTexCoord()
    offset = transform?.getOffset() ?? offset
    scale = transform?.getScale() ?? scale
    uv = prim.getAttribute(`TEXCOORD_${texCoord}`)
    if (uv === null) throw new Error(`textured primitive has no TEXCOORD_${texCoord}`)
  }
  const image = texture === null ? undefined : textures.get(texture)

  const colours: Rgb[] = []
  const element: number[] = []
  for (let t = 0; t < indices.length; t += 3) {
    let r = factor[0] ?? 1
    let g = factor[1] ?? 1
    let b = factor[2] ?? 1
    if (image !== undefined && uv !== null && info !== null) {
      let u = 0
      let v = 0
      for (let k = 0; k < 3; k++) {
        uv.getElement(indices[t + k] ?? 0, element)
        u += (element[0] ?? 0) / 3
        v += (element[1] ?? 0) / 3
      }
      const texel = sampleTexel(
        image,
        u * (scale[0] ?? 1) + (offset[0] ?? 0),
        v * (scale[1] ?? 1) + (offset[1] ?? 0),
        info,
      )
      r *= texel[0]
      g *= texel[1]
      b *= texel[2]
    }
    if (vertexColour !== null) {
      let vr = 0
      let vg = 0
      let vb = 0
      for (let k = 0; k < 3; k++) {
        vertexColour.getElement(indices[t + k] ?? 0, element)
        vr += (element[0] ?? 0) / 3
        vg += (element[1] ?? 0) / 3
        vb += (element[2] ?? 0) / 3
      }
      r *= vr
      g *= vg
      b *= vb
    }
    colours.push([r, g, b])
  }
  return colours
}
