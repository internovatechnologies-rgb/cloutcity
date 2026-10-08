import {
  MINUTES_PER_DAY,
  type DayNightKeyframe,
  type DayNightModel,
  type KeyframeColors,
  type Lighting,
  type LightingOptions,
  type SunPose,
  type Vec3,
} from './types'

/** Any game minute (negative, or past one day) as a whole minute of day, 0–1439. */
export function minuteOfDay(minute: number): number {
  if (!Number.isFinite(minute)) throw new Error(`dayNight: minute must be finite, got ${minute}`)
  return ((Math.floor(minute) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY
}

/** The minute of day rounded down to the model's step: lighting only changes at these. */
export function quantizedMinute(minute: number, model: DayNightModel): number {
  const day = minuteOfDay(minute)
  return day - (day % model.quantizeMinutes)
}

interface Segment {
  readonly from: DayNightKeyframe
  readonly to: DayNightKeyframe
  /** Smoothstepped blend fraction from `from` to `to`, 0 during the hold. */
  readonly t: number
}

/** The keyframe at or before `minute` (wrapping past midnight) and the blend towards the next. */
function segmentAt(minute: number, model: DayNightModel): Segment {
  const { keyframes } = model
  let index = keyframes.length - 1
  for (let i = 0; i < keyframes.length; i++) {
    if ((keyframes[i] as DayNightKeyframe).atMinute <= minute) index = i
  }
  const from = keyframes[index] as DayNightKeyframe
  const to = keyframes[(index + 1) % keyframes.length] as DayNightKeyframe
  const elapsed = (minute - from.atMinute + MINUTES_PER_DAY) % MINUTES_PER_DAY
  const span = (to.atMinute - from.atMinute + MINUTES_PER_DAY) % MINUTES_PER_DAY
  if (elapsed <= from.holdMinutes) return { from, to, t: 0 }
  return { from, to, t: smoothstep((elapsed - from.holdMinutes) / (span - from.holdMinutes)) }
}

function smoothstep(x: number): number {
  const t = Math.min(1, Math.max(0, x))
  return t * t * (3 - 2 * t)
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function srgbDecode(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
}

function srgbEncode(channel: number): number {
  return channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055
}

function hexChannels(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16)
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]
}

/**
 * Two sRGB hex colours mixed in linear light, so a blend through dusk does not sag into the
 * muddy midtones an sRGB mix gives.
 */
export function mixHexLinear(a: string, b: string, t: number): string {
  const from = hexChannels(a)
  const to = hexChannels(b)
  return `#${from
    .map((channel, i) => {
      const linear = lerp(srgbDecode(channel / 255), srgbDecode((to[i] as number) / 255), t)
      const byte = Math.round(Math.min(1, Math.max(0, srgbEncode(linear))) * 255)
      return byte.toString(16).padStart(2, '0')
    })
    .join('')}`
}

function mixColors(
  a: KeyframeColors<string>,
  b: KeyframeColors<string>,
  t: number,
): KeyframeColors<string> {
  return {
    sky: mixHexLinear(a.sky, b.sky, t),
    fog: mixHexLinear(a.fog, b.fog, t),
    sun: mixHexLinear(a.sun, b.sun, t),
    ambient: mixHexLinear(a.ambient, b.ambient, t),
    hemisphereSky: mixHexLinear(a.hemisphereSky, b.hemisphereSky, t),
    hemisphereGround: mixHexLinear(a.hemisphereGround, b.hemisphereGround, t),
    unlitTint: mixHexLinear(a.unlitTint, b.unlitTint, t),
    water: mixHexLinear(a.water, b.water, t),
  }
}

/** Azimuth along the shorter arc, so the sun never swings the long way round. */
function mixAzimuth(a: number, b: number, t: number): number {
  const delta = ((((b - a) % 360) + 540) % 360) - 180
  return (((a + delta * t) % 360) + 360) % 360
}

const RAD = Math.PI / 180

/** Unit vector towards the sun: x east, y up, z south (north is −z). */
export function sunDirection(sun: SunPose): Vec3 {
  const az = sun.azimuthDeg * RAD
  const el = sun.elevationDeg * RAD
  return { x: Math.sin(az) * Math.cos(el), y: Math.sin(el), z: -Math.cos(az) * Math.cos(el) }
}

/**
 * The scene lighting at a game minute: the keyframe holds, then blends (smoothstep, colours in
 * linear light) towards the next keyframe, wrapping past midnight. The minute is quantised to
 * the model's step so the lighting, and `lightingKey`, change only every few game minutes. In
 * step mode (reduced motion) the current keyframe shows unblended.
 */
export function lightingAt(
  minute: number,
  model: DayNightModel,
  options: LightingOptions = {},
): Lighting {
  const step = options.step === true
  const quantized = quantizedMinute(minute, model)
  const segment = segmentAt(quantized, model)
  const { from, to } = segment
  const t = step ? 0 : segment.t
  const sun = {
    azimuthDeg:
      t === 0 ? from.sun.azimuthDeg : mixAzimuth(from.sun.azimuthDeg, to.sun.azimuthDeg, t),
    elevationDeg: Math.max(
      model.minSunElevationDeg,
      lerp(from.sun.elevationDeg, to.sun.elevationDeg, t),
    ),
  }
  return {
    minute: quantized,
    mode: step ? 'step' : 'blend',
    keyframe: from.id,
    next: to.id,
    t,
    ui: from.ui,
    sun,
    sunDirection: sunDirection(sun),
    sunIntensity: lerp(from.sunIntensity, to.sunIntensity, t),
    shadowIntensity: lerp(from.shadowIntensity, to.shadowIntensity, t),
    ambientIntensity: lerp(from.ambientIntensity, to.ambientIntensity, t),
    hemisphereIntensity: lerp(from.hemisphereIntensity, to.hemisphereIntensity, t),
    nightGlow: lerp(from.nightGlow, to.nightGlow, t),
    colors: t === 0 ? from.colors : mixColors(from.colors, to.colors, t),
  }
}

/** Exported for `uiThemeAt`, which needs the segment but none of the blending. */
export function keyframeAt(minute: number, model: DayNightModel): DayNightKeyframe {
  return segmentAt(quantizedMinute(minute, model), model).from
}
