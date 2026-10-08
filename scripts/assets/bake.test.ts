/**
 * The colour bake (S04h): the tiny PNG decoder, atlas sampling at triangle centroids, base colour
 * factors in either encoding, and the harmonisation to the theme `models` palette (CIEDE2000 and
 * the OKLCH grade).
 */
import { crc32 } from 'node:zlib'
import { Document } from '@gltf-transform/core'
import { KHRTextureTransform } from '@gltf-transform/extensions'
import { zlibSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { TextureCache, triangleColours } from './bake.ts'
import {
  applyGrade,
  deltaE2000,
  harmoniseAll,
  hexToLinear,
  linearToHex,
  linearToLab,
  swatchesFor,
  type Rgb,
} from './harmonise.ts'
import { decodePng } from './png.ts'

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.byteLength)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.byteLength)
  out.set(new TextEncoder().encode(type), 4)
  out.set(data, 8)
  view.setUint32(8 + data.byteLength, crc32(out.subarray(4, 8 + data.byteLength)))
  return out
}

/** A PNG from already-filtered scanlines (each row starts with its filter byte). */
function png(
  width: number,
  height: number,
  colorType: number,
  rows: number[][],
  extra: Uint8Array[] = [],
  bitDepth = 8,
  interlace = 0,
): Uint8Array {
  const ihdr = new Uint8Array(13)
  const view = new DataView(ihdr.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  ihdr.set([bitDepth, colorType, 0, 0, interlace], 8)
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    ...extra,
    chunk('IDAT', zlibSync(new Uint8Array(rows.flat()))),
    chunk('IEND', new Uint8Array()),
  ]
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}

const pixels = (rgba: Uint8Array) => [...rgba]

describe('decodePng', () => {
  it('reads RGB and RGBA with every scanline filter', () => {
    // 2×1 RGB: red, green, unfiltered.
    expect(pixels(decodePng(png(2, 1, 2, [[0, 255, 0, 0, 0, 255, 0]])).rgba)).toEqual([
      255, 0, 0, 255, 0, 255, 0, 255,
    ])
    // Sub: the second pixel is stored as its difference to the first.
    expect(pixels(decodePng(png(2, 1, 2, [[1, 10, 20, 30, 5, 5, 5]])).rgba)).toEqual([
      10, 20, 30, 255, 15, 25, 35, 255,
    ])
    // Up, Average and Paeth on a 1×2 RGBA image.
    const up = png(1, 2, 6, [
      [0, 100, 100, 100, 200],
      [2, 1, 2, 3, 4],
    ])
    expect(pixels(decodePng(up).rgba)).toEqual([100, 100, 100, 200, 101, 102, 103, 204])
    const average = png(1, 2, 6, [
      [0, 100, 100, 100, 200],
      [3, 0, 0, 0, 0],
    ])
    expect(pixels(decodePng(average).rgba)).toEqual([100, 100, 100, 200, 50, 50, 50, 100])
    const paeth = png(1, 2, 6, [
      [0, 100, 100, 100, 200],
      [4, 0, 0, 0, 0],
    ])
    expect(pixels(decodePng(paeth).rgba)).toEqual([100, 100, 100, 200, 100, 100, 100, 200])
  })

  it('reads palette images (with tRNS) at 8 and 2 bits, and greyscale', () => {
    const plte = chunk('PLTE', new Uint8Array([255, 0, 0, 0, 0, 255]))
    const trns = chunk('tRNS', new Uint8Array([128]))
    expect(pixels(decodePng(png(2, 1, 3, [[0, 1, 0]], [plte, trns])).rgba)).toEqual([
      0, 0, 255, 255, 255, 0, 0, 128,
    ])
    // 2-bit indices 1, 0 packed into one byte: 0b01_00_0000.
    expect(pixels(decodePng(png(2, 1, 3, [[0, 0b0100_0000]], [plte], 2)).rgba)).toEqual([
      0, 0, 255, 255, 255, 0, 0, 255,
    ])
    expect(pixels(decodePng(png(1, 1, 0, [[0, 77]])).rgba)).toEqual([77, 77, 77, 255])
  })

  it('refuses what it does not support instead of guessing', () => {
    expect(() => decodePng(new Uint8Array([1, 2, 3]))).toThrow(/not a PNG/)
    expect(() => decodePng(png(1, 1, 2, [[0, 1, 2, 3]], [], 8, 1))).toThrow(/interlaced/)
    expect(() => decodePng(png(1, 1, 2, [[0, 0, 1, 0, 2, 0, 3]], [], 16))).toThrow(/bit depth 16/)
    expect(() => decodePng(png(1, 1, 3, [[0, 0]]))).toThrow(/without PLTE/)
    expect(() => decodePng(png(1, 1, 2, [[9, 1, 2, 3]]))).toThrow(/filter type 9/)
  })
})

/** A two-triangle quad whose UVs span the left (red) and right (blue) halves of a 2×1 atlas. */
function atlasQuad(options: { factor?: number[]; offset?: [number, number] } = {}) {
  const doc = new Document()
  const buffer = doc.createBuffer()
  const atlas = doc
    .createTexture('atlas')
    .setMimeType('image/png')
    .setImage(png(2, 1, 2, [[0, 255, 0, 0, 0, 0, 255]]))
  const material = doc.createMaterial().setBaseColorTexture(atlas)
  if (options.factor !== undefined) material.setBaseColorFactor(options.factor as never)
  if (options.offset !== undefined) {
    const transform = doc
      .createExtension(KHRTextureTransform)
      .createTransform()
      .setOffset(options.offset)
    material.getBaseColorTextureInfo()?.setExtension('KHR_texture_transform', transform)
  }
  const accessor = (type: 'VEC2' | 'VEC3', array: number[]) =>
    doc.createAccessor().setType(type).setArray(new Float32Array(array)).setBuffer(buffer)
  // Triangle 0's corners sit ON the swatch edge (u = 0.5); its centroid is inside the red half.
  const prim = doc
    .createPrimitive()
    .setAttribute(
      'POSITION',
      accessor('VEC3', [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
    )
    .setAttribute('TEXCOORD_0', accessor('VEC2', [0, 0, 0.5, 0, 0, 1, 0.6, 0, 1, 0, 1, 1]))
    .setMaterial(material)
  return prim
}

const hex = (colours: Rgb[]) => colours.map(linearToHex)

describe('triangleColours', () => {
  it('samples the atlas at each triangle’s UV centroid, not its corners', () => {
    expect(hex(triangleColours(atlasQuad(), new TextureCache(), 'linear'))).toEqual([
      '#ff0000',
      '#0000ff',
    ])
  })

  it('multiplies by the base colour factor, decoding sRGB factors when the pack wrote them', () => {
    const half = atlasQuad({ factor: [0.5, 0.5, 0.5, 1] })
    expect(hex(triangleColours(half, new TextureCache(), 'linear'))[0]).toBe('#bc0000')
    expect(hex(triangleColours(half, new TextureCache(), 'srgb'))[0]).toBe('#800000')
  })

  it('applies KHR_texture_transform offsets', () => {
    const shifted = atlasQuad({ offset: [0.5, 0] })
    expect(hex(triangleColours(shifted, new TextureCache(), 'linear'))).toEqual([
      '#0000ff',
      '#ff0000',
    ])
  })
})

describe('harmonise', () => {
  it('computes CIEDE2000 like the Sharma et al. (2005) reference pairs', () => {
    // Pairs 1, 7 and 17 of the published test data.
    expect(deltaE2000([50, 2.6772, -79.7751], [50, 0, -82.7485])).toBeCloseTo(2.0425, 4)
    expect(deltaE2000([50, 0, 0], [50, -1, 2])).toBeCloseTo(2.3669, 4)
    expect(deltaE2000([50, 2.5, 0], [73, 25, -18])).toBeCloseTo(27.1492, 4)
  })

  it('grades in OKLCH: chroma below 1 mutes, lightness and hue stay', () => {
    const red = hexToLinear('#cc2129')
    const muted = applyGrade(red, { lightness: 1, chroma: 0.5 })
    const [L1, a1, b1] = linearToLab(red)
    const [L2, a2, b2] = linearToLab(muted)
    expect(Math.hypot(a2, b2)).toBeLessThan(Math.hypot(a1, b1))
    expect(Math.abs(L1 - L2)).toBeLessThan(4)
    expect(applyGrade(red, { lightness: 1, chroma: 1 })).toBe(red)
  })

  const palette = { 'taxi-400': '#f5b800', 'asphalt-800': '#333538', 'leaf-500': '#5b8a3c' }
  const swatches = swatchesFor(['taxi-400', 'asphalt-800'], palette)
  const none = { lightness: 1, chroma: 1 }

  it('snaps close colours to their swatch and keeps far ones as graded', () => {
    const colours = ['#f2b80a', '#3a3b3e', '#00a0ff'].map(hexToLinear)
    const out = harmoniseAll({ colours, weights: [1, 1, 1] }, none, swatches, 10)
    expect(out.map((o) => o.token)).toEqual(['taxi-400', 'asphalt-800', undefined])
    expect(linearToHex(out[2]?.linear ?? [0, 0, 0])).toBe('#00a0ff')
  })

  it('re-centres a gradient on its swatch while keeping part of the shading', () => {
    const colours = ['#e0a800', '#ffc820'].map(hexToLinear)
    const [dark, light] = harmoniseAll({ colours, weights: [1, 1] }, none, swatches, 20)
    expect(dark?.token).toBe('taxi-400')
    expect(light?.token).toBe('taxi-400')
    const L = (rgb: Rgb | undefined) => linearToLab(rgb ?? [0, 0, 0])[0]
    expect(L(light?.linear)).toBeGreaterThan(L(dark?.linear))
    const target = L(hexToLinear('#f5b800'))
    expect(Math.abs((L(light?.linear) + L(dark?.linear)) / 2 - target)).toBeLessThan(1)
  })

  it('lets an anchor pull a far source colour to its token (teal pack leaves → leaf green)', () => {
    const leaf = swatchesFor(['leaf-500'], palette)[0]
    if (leaf === undefined) throw new Error('fixture')
    const colours = ['#29c9ab', '#2ccdb0'].map(hexToLinear)
    const anchors = [{ lab: linearToLab(hexToLinear('#29c9ab')), swatch: leaf }]
    const out = harmoniseAll({ colours, weights: [1, 1], anchors }, none, swatches, 10)
    expect(out.map((o) => o.token)).toEqual(['leaf-500', 'leaf-500'])
    // Without the anchor nothing is close enough.
    expect(harmoniseAll({ colours, weights: [1, 1] }, none, swatches, 10)[0]?.token).toBe(undefined)
  })
})
