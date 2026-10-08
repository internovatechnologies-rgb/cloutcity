/**
 * A tiny PNG decoder for the asset bake: the packs' colour atlases are small, non-interlaced,
 * 8-bit PNGs, so this reads exactly that (greyscale, RGB, palette, grey+alpha, RGBA; bit depth 8,
 * or 1/2/4 for palette and greyscale) on top of fflate's zlib inflate, instead of pulling in an
 * image library. Anything else (16-bit, Adam7 interlacing) fails loudly.
 */
import { unzlibSync } from 'fflate'

export interface DecodedPng {
  readonly width: number
  readonly height: number
  /** Row-major RGBA, 4 bytes per pixel, sRGB-encoded as stored. */
  readonly rgba: Uint8Array
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]

/** Channels per pixel by PNG colour type. */
const CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

/** Reverses the per-scanline filters in place; returns the unfiltered rows without filter bytes. */
function unfilter(data: Uint8Array, height: number, rowBytes: number, bpp: number): Uint8Array {
  const out = new Uint8Array(height * rowBytes)
  for (let y = 0; y < height; y++) {
    const filter = data[y * (rowBytes + 1)]
    const src = y * (rowBytes + 1) + 1
    const dst = y * rowBytes
    const prev = dst - rowBytes
    for (let x = 0; x < rowBytes; x++) {
      const raw = data[src + x] ?? 0
      const left = x >= bpp ? (out[dst + x - bpp] ?? 0) : 0
      const up = y > 0 ? (out[prev + x] ?? 0) : 0
      const upLeft = y > 0 && x >= bpp ? (out[prev + x - bpp] ?? 0) : 0
      let value: number
      switch (filter) {
        case 0:
          value = raw
          break
        case 1:
          value = raw + left
          break
        case 2:
          value = raw + up
          break
        case 3:
          value = raw + ((left + up) >> 1)
          break
        case 4:
          value = raw + paeth(left, up, upLeft)
          break
        default:
          throw new Error(`png: unknown filter type ${String(filter)} on row ${y}`)
      }
      out[dst + x] = value & 0xff
    }
  }
  return out
}

export function decodePng(bytes: Uint8Array): DecodedPng {
  if (bytes.byteLength < 8 || SIGNATURE.some((value, i) => bytes[i] !== value)) {
    throw new Error('png: not a PNG file')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = -1
  let palette: Uint8Array | undefined
  let transparency: Uint8Array | undefined
  const idat: Uint8Array[] = []
  let offset = 8
  while (offset + 8 <= bytes.byteLength) {
    const length = view.getUint32(offset)
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8))
    const data = bytes.subarray(offset + 8, offset + 8 + length)
    if (data.byteLength !== length) throw new Error(`png: truncated ${type} chunk`)
    if (type === 'IHDR') {
      width = view.getUint32(offset + 8)
      height = view.getUint32(offset + 12)
      bitDepth = data[8] ?? 0
      colorType = data[9] ?? -1
      if ((data[10] ?? 0) !== 0 || (data[11] ?? 0) !== 0) {
        throw new Error('png: unsupported compression or filter method')
      }
      if ((data[12] ?? 0) !== 0) throw new Error('png: interlaced images are not supported')
    } else if (type === 'PLTE') palette = data
    else if (type === 'tRNS') transparency = data
    else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    offset += 12 + length
  }
  const channels = CHANNELS[colorType]
  if (width === 0 || height === 0 || channels === undefined) throw new Error('png: bad IHDR')
  const lowBitOk = colorType === 0 || colorType === 3
  if (!(bitDepth === 8 || (lowBitOk && (bitDepth === 1 || bitDepth === 2 || bitDepth === 4)))) {
    throw new Error(`png: bit depth ${bitDepth} with colour type ${colorType} is not supported`)
  }
  if (colorType === 3 && palette === undefined) throw new Error('png: palette image without PLTE')

  let total = 0
  for (const part of idat) total += part.byteLength
  const compressed = new Uint8Array(total)
  let at = 0
  for (const part of idat) {
    compressed.set(part, at)
    at += part.byteLength
  }
  const bitsPerPixel = bitDepth * channels
  const rowBytes = Math.ceil((width * bitsPerPixel) / 8)
  const inflated = unzlibSync(compressed)
  if (inflated.byteLength < height * (rowBytes + 1)) throw new Error('png: image data too short')
  const rows = unfilter(inflated, height, rowBytes, Math.max(1, bitsPerPixel >> 3))

  const rgba = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      let sample = (index: number) => rows[y * rowBytes + x * channels + index] ?? 0
      if (bitDepth < 8) {
        const bit = x * bitDepth
        const byte = rows[y * rowBytes + (bit >> 3)] ?? 0
        const value = (byte >> (8 - bitDepth - (bit & 7))) & ((1 << bitDepth) - 1)
        // Greyscale at low bit depth scales to 0..255; palette indices stay as they are.
        const scaled = colorType === 0 ? Math.round((value * 255) / ((1 << bitDepth) - 1)) : value
        sample = () => scaled
      }
      if (colorType === 3) {
        const index = sample(0)
        rgba[o] = palette?.[index * 3] ?? 0
        rgba[o + 1] = palette?.[index * 3 + 1] ?? 0
        rgba[o + 2] = palette?.[index * 3 + 2] ?? 0
        rgba[o + 3] = transparency?.[index] ?? 255
      } else if (colorType === 0 || colorType === 4) {
        const grey = sample(0)
        rgba[o] = grey
        rgba[o + 1] = grey
        rgba[o + 2] = grey
        rgba[o + 3] = colorType === 4 ? sample(1) : 255
      } else {
        rgba[o] = sample(0)
        rgba[o + 1] = sample(1)
        rgba[o + 2] = sample(2)
        rgba[o + 3] = colorType === 6 ? sample(3) : 255
      }
    }
  }
  return { width, height, rgba }
}
