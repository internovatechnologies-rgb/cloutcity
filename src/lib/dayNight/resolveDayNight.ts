import {
  DAY_NIGHT_KEYFRAME_IDS,
  MINUTES_PER_DAY,
  UI_THEMES,
  type DayNightModel,
  type KeyframeColors,
  type SceneKeyframe,
  type SceneDayNight,
  type SkyColors,
  type ThemeDayNight,
} from './types'

const HEX = /^#[0-9a-f]{6}$/i

const COLOR_SLOTS = [
  'sky',
  'fog',
  'sun',
  'ambient',
  'hemisphereSky',
  'hemisphereGround',
  'unlitTint',
  'water',
] as const satisfies readonly (keyof KeyframeColors)[]

function fail(message: string): never {
  throw new Error(`dayNight: ${message}`)
}

/**
 * Joins scene.json `dayNight` with theme.json's sky tokens into the model `lightingAt` reads,
 * resolving every token to lowercase hex. Fails fast on a model the cycle cannot run: keyframes
 * out of clock order, a hold that runs into the next keyframe, an unknown token.
 */
export function resolveDayNight(scene: SceneDayNight, theme: ThemeDayNight): DayNightModel {
  return withSkyColors(scene, resolveSkyColors(theme))
}

/** theme.json's sky tokens per keyframe, resolved to lowercase hex. */
export function resolveSkyColors(theme: ThemeDayNight): SkyColors {
  const tokenHex = (token: string): string => {
    const hex = theme.colors[token]
    if (hex === undefined) fail(`unknown colour token "${token}"`)
    if (!HEX.test(hex)) fail(`colour token "${token}" is not #rrggbb: "${hex}"`)
    return hex.toLowerCase()
  }
  return Object.fromEntries(
    DAY_NIGHT_KEYFRAME_IDS.flatMap((id) => {
      const tokens = theme.sky[id] as KeyframeColors<string> | undefined
      if (tokens === undefined) return []
      return [[id, Object.fromEntries(COLOR_SLOTS.map((slot) => [slot, tokenHex(tokens[slot])]))]]
    }),
  ) as SkyColors
}

/**
 * The model from scene.json `dayNight` and already resolved sky colours (the 3D chunk gets the
 * colours from the server, the keyframes with the scene config), with the same checks.
 */
export function withSkyColors(scene: SceneDayNight, sky: SkyColors): DayNightModel {
  const { keyframes, quantizeMinutes, minSunElevationDeg } = scene
  if (!Number.isInteger(quantizeMinutes) || quantizeMinutes < 1) {
    fail(`quantizeMinutes must be a positive integer, got ${quantizeMinutes}`)
  }
  if (MINUTES_PER_DAY % quantizeMinutes !== 0) {
    fail(`quantizeMinutes ${quantizeMinutes} must divide a day of ${MINUTES_PER_DAY} minutes`)
  }
  if (!(minSunElevationDeg >= 0 && minSunElevationDeg < 90)) {
    fail(`minSunElevationDeg must be in [0, 90), got ${minSunElevationDeg}`)
  }
  if (keyframes.length < 2) fail('needs at least two keyframes')

  const seen = new Set<string>()
  keyframes.forEach((keyframe, index) => {
    if (!DAY_NIGHT_KEYFRAME_IDS.includes(keyframe.id)) fail(`unknown keyframe "${keyframe.id}"`)
    if (seen.has(keyframe.id)) fail(`keyframe "${keyframe.id}" appears twice`)
    seen.add(keyframe.id)
    if (!UI_THEMES.includes(keyframe.ui))
      fail(`keyframe "${keyframe.id}" has unknown ui "${keyframe.ui}"`)
    const { atMinute, holdMinutes } = keyframe
    if (!Number.isInteger(atMinute) || atMinute < 0 || atMinute >= MINUTES_PER_DAY) {
      fail(`keyframe "${keyframe.id}" atMinute must be an integer in [0, 1440), got ${atMinute}`)
    }
    const next = keyframes[(index + 1) % keyframes.length] as SceneKeyframe
    if (index + 1 < keyframes.length && next.atMinute <= atMinute) {
      fail(`keyframes must be in clock order: "${next.id}" follows "${keyframe.id}"`)
    }
    const span = (next.atMinute - atMinute + MINUTES_PER_DAY) % MINUTES_PER_DAY
    if (!(holdMinutes >= 0 && holdMinutes < span)) {
      fail(`keyframe "${keyframe.id}" hold ${holdMinutes} must be in [0, ${span})`)
    }
    if (!(keyframe.nightGlow >= 0 && keyframe.nightGlow <= 1)) {
      fail(`keyframe "${keyframe.id}" nightGlow must be in [0, 1]`)
    }
    if (!(keyframe.shadowIntensity >= 0 && keyframe.shadowIntensity <= 1)) {
      fail(`keyframe "${keyframe.id}" shadowIntensity must be in [0, 1]`)
    }
  })

  return {
    quantizeMinutes,
    minSunElevationDeg,
    keyframes: keyframes.map((keyframe) => {
      const colors = sky[keyframe.id] as KeyframeColors<string> | undefined
      if (colors === undefined) fail(`theme has no sky colours for keyframe "${keyframe.id}"`)
      for (const slot of COLOR_SLOTS) {
        if (!HEX.test(colors[slot] ?? '')) fail(`keyframe "${keyframe.id}" ${slot} is not #rrggbb`)
      }
      return { ...keyframe, colors }
    }),
  }
}
