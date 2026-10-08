/**
 * Harmonises pack colours to the real-world model palette (DEC-26). Every baked colour first
 * gets its pack's OKLCH grade (toy-bright packs are muted towards real materials), then joins
 * the nearest of the model's allowed theme `models` tokens when it is within the model's
 * CIEDE2000 tolerance, taking that token's hue and chroma (see harmoniseAll). Colours with no
 * close token keep their graded value, so small details survive while the large surfaces read as
 * real brick, limestone, asphalt or taxi yellow.
 *
 * Colour spaces: sRGB (8-bit, as stored in PNGs and theme hex), linear sRGB (glTF factors and
 * COLOR_0), OKLab/OKLCH (Ottosson 2020) for grading, CIELAB D65 for ΔE₀₀ (Sharma et al. 2005).
 */

export type Rgb = readonly [number, number, number]

export interface Grade {
  /** OKLCH lightness multiplier. */
  readonly lightness: number
  /** OKLCH chroma multiplier (below 1 mutes). */
  readonly chroma: number
}

export const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
export const linearToSrgb = (c: number) =>
  c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055

const clamp01 = (value: number) => Math.min(1, Math.max(0, value))

export function hexToLinear(hex: string): Rgb {
  const value = Number.parseInt(hex.slice(1), 16)
  return [
    srgbToLinear(((value >> 16) & 0xff) / 255),
    srgbToLinear(((value >> 8) & 0xff) / 255),
    srgbToLinear((value & 0xff) / 255),
  ]
}

export function linearToHex(rgb: Rgb): string {
  const byte = (c: number) =>
    Math.round(clamp01(linearToSrgb(clamp01(c))) * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${byte(rgb[0])}${byte(rgb[1])}${byte(rgb[2])}`
}

export function linearToOklab([r, g, b]: Rgb): Rgb {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

export function oklabToLinear([L, a, b]: Rgb): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
}

/** Scales OKLCH lightness and chroma (hue kept), clamped back into the sRGB gamut. */
export function applyGrade(rgb: Rgb, grade: Grade): Rgb {
  if (grade.lightness === 1 && grade.chroma === 1) return rgb
  const [L, a, b] = linearToOklab(rgb)
  const out = oklabToLinear([clamp01(L * grade.lightness), a * grade.chroma, b * grade.chroma])
  return [clamp01(out[0]), clamp01(out[1]), clamp01(out[2])]
}

/** CIELAB (D65 white) from linear sRGB. */
export function linearToLab([r, g, b]: Rgb): Rgb {
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29)
  const fx = f(x)
  const fy = f(y)
  const fz = f(z)
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

const deg = (rad: number) => (rad * 180) / Math.PI
const rad = (degrees: number) => (degrees * Math.PI) / 180

/** CIEDE2000 colour difference between two CIELAB colours (kL = kC = kH = 1). */
export function deltaE2000(lab1: Rgb, lab2: Rgb): number {
  const [L1, a1, b1] = lab1
  const [L2, a2, b2] = lab2
  const C1 = Math.hypot(a1, b1)
  const C2 = Math.hypot(a2, b2)
  const Cbar = (C1 + C2) / 2
  const G = 0.5 * (1 - Math.sqrt(Cbar ** 7 / (Cbar ** 7 + 25 ** 7)))
  const a1p = (1 + G) * a1
  const a2p = (1 + G) * a2
  const C1p = Math.hypot(a1p, b1)
  const C2p = Math.hypot(a2p, b2)
  const hue = (b: number, a: number) => {
    if (a === 0 && b === 0) return 0
    const h = deg(Math.atan2(b, a))
    return h < 0 ? h + 360 : h
  }
  const h1p = hue(b1, a1p)
  const h2p = hue(b2, a2p)
  const dLp = L2 - L1
  const dCp = C2p - C1p
  let dhp = 0
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p
    if (dhp > 180) dhp -= 360
    else if (dhp < -180) dhp += 360
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(rad(dhp / 2))
  const Lbarp = (L1 + L2) / 2
  const Cbarp = (C1p + C2p) / 2
  let hbarp = h1p + h2p
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) <= 180) hbarp = (h1p + h2p) / 2
    else hbarp = h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2
  }
  const T =
    1 -
    0.17 * Math.cos(rad(hbarp - 30)) +
    0.24 * Math.cos(rad(2 * hbarp)) +
    0.32 * Math.cos(rad(3 * hbarp + 6)) -
    0.2 * Math.cos(rad(4 * hbarp - 63))
  const dTheta = 30 * Math.exp(-(((hbarp - 275) / 25) ** 2))
  const Rc = 2 * Math.sqrt(Cbarp ** 7 / (Cbarp ** 7 + 25 ** 7))
  const Sl = 1 + (0.015 * (Lbarp - 50) ** 2) / Math.sqrt(20 + (Lbarp - 50) ** 2)
  const Sc = 1 + 0.045 * Cbarp
  const Sh = 1 + 0.015 * Cbarp * T
  const Rt = -Math.sin(rad(2 * dTheta)) * Rc
  return Math.sqrt(
    (dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh),
  )
}

export interface Swatch {
  readonly token: string
  readonly linear: Rgb
  readonly lab: Rgb
}

export function swatchesFor(tokens: readonly string[], palette: Readonly<Record<string, string>>) {
  return tokens.map((token): Swatch => {
    const hex = palette[token]
    if (hex === undefined) throw new Error(`unknown models token ${token}`)
    const linear = hexToLinear(hex)
    return { token, linear, lab: linearToLab(linear) }
  })
}

/**
 * Share of each colour's lightness offset from its group mean that survives the snap. About a third keeps
 * the packs’ gradient shading readable without bright faces washing out towards white.
 */
export const SHADING_KEEP = 0.35

export interface Harmonised {
  readonly linear: Rgb
  /** The token the colour snapped to, if any. */
  readonly token: string | undefined
}

export interface Anchor {
  /** CIELAB of the anchoring source colour (before grading). */
  readonly lab: Rgb
  readonly swatch: Swatch
  /** Its own capture radius (CIEDE2000); the model's `maxDeltaE` when absent. */
  readonly maxDeltaE?: number
}

export interface HarmoniseInput {
  /** Distinct source colours (linear) of one model. */
  readonly colours: readonly Rgb[]
  /** How many triangles carry each colour (weights the group lightness). */
  readonly weights: readonly number[]
  /** Source colours that pin a swatch (catalog `remap`); matched before the swatches. */
  readonly anchors?: readonly Anchor[]
}

/** The candidate nearest to `lab` within `maxDeltaE`; ties keep the earlier one (catalog order). */
function nearest<T>(lab: Rgb, candidates: readonly T[], labOf: (c: T) => Rgb, maxDeltaE: number) {
  let best: T | undefined
  let bestDelta = Infinity
  for (const candidate of candidates) {
    const delta = deltaE2000(lab, labOf(candidate))
    if (delta < bestDelta) {
      best = candidate
      bestDelta = delta
    }
  }
  return bestDelta <= maxDeltaE ? best : undefined
}

/**
 * Harmonises all colours of one model at once. Each colour joins a swatch group: the group of its
 * nearest anchor (a source colour the catalog pins to a token, compared before grading), else of
 * the nearest swatch to its graded colour, in both cases only within `maxDeltaE`. A group takes
 * its swatch's hue and chroma, and its lightness is re-centred on the swatch while each member
 * keeps part of its offset from the group's mean (SHADING_KEEP): gradient-shaded packs keep their hand-painted shading,
 * but the surface now reads as the real material. Colours in no group keep their graded value.
 */
export function harmoniseAll(
  input: HarmoniseInput,
  grade: Grade,
  swatches: readonly Swatch[],
  maxDeltaE: number,
): Harmonised[] {
  const graded = input.colours.map((rgb) => applyGrade(rgb, grade))
  const anchors = input.anchors ?? []
  const member = input.colours.map((rgb, i): Swatch | undefined => {
    const lab = linearToLab(rgb)
    const anchor = nearest(lab, anchors, (a) => a.lab, maxDeltaE)
    if (anchor !== undefined && deltaE2000(lab, anchor.lab) <= (anchor.maxDeltaE ?? maxDeltaE)) {
      return anchor.swatch
    }
    return nearest(linearToLab(graded[i] ?? rgb), swatches, (s) => s.lab, maxDeltaE)
  })
  const lightness = graded.map((rgb) => linearToOklab(rgb)[0])
  const meanL = new Map<string, number>()
  for (const swatch of new Set(member)) {
    if (swatch === undefined) continue
    let sum = 0
    let weight = 0
    for (const [i, m] of member.entries()) {
      if (m !== swatch) continue
      const w = input.weights[i] ?? 1
      sum += (lightness[i] ?? 0) * w
      weight += w
    }
    meanL.set(swatch.token, weight > 0 ? sum / weight : 0)
  }
  return graded.map((rgb, i) => {
    const swatch = member[i]
    if (swatch === undefined) return { linear: rgb, token: undefined }
    const [L, a, b] = linearToOklab(swatch.linear)
    const shifted = clamp01(
      L + ((lightness[i] ?? 0) - (meanL.get(swatch.token) ?? 0)) * SHADING_KEEP,
    )
    const out = oklabToLinear([shifted, a, b])
    return { linear: [clamp01(out[0]), clamp01(out[1]), clamp01(out[2])], token: swatch.token }
  })
}
