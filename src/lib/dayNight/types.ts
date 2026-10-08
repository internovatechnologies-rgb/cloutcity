/**
 * Types of the day/night cycle (S04f): keyframes on the personal game clock that the 3D scene
 * blends between, and the interface theme each one selects. Pure data shapes; the zod schemas of
 * scene.json `dayNight` and theme.json `sky` (S04f part 1) must parse to `SceneDayNight` and
 * `ThemeDayNight`.
 */

/** The keyframes of one game day, in clock order. */
export const DAY_NIGHT_KEYFRAME_IDS = ['dawn', 'morning', 'day', 'golden', 'dusk', 'night'] as const
export type KeyframeId = (typeof DAY_NIGHT_KEYFRAME_IDS)[number]

/** The interface palettes (S04g). */
export const UI_THEMES = ['day', 'night'] as const
export type UiTheme = (typeof UI_THEMES)[number]

export const MINUTES_PER_DAY = 1440

/** Every colour slot a keyframe sets. `C` is a theme token before resolving and hex after. */
export interface KeyframeColors<C = string> {
  /** Canvas background (there is no sky dome: the camera never sees the horizon). */
  readonly sky: C
  readonly fog: C
  readonly sun: C
  readonly ambient: C
  readonly hemisphereSky: C
  readonly hemisphereGround: C
  /** Multiplier for unlit materials (water, lines, labels) so they darken with the scene. */
  readonly unlitTint: C
  /** The harbour's colour: blue-grey by day, dark navy at night. */
  readonly water: C
}

/** Where the sun stands: azimuth clockwise from north (−z) towards east (+x), elevation up. */
export interface SunPose {
  readonly azimuthDeg: number
  readonly elevationDeg: number
}

/** One keyframe's scene values: everything except colours (scene.json `dayNight.keyframes`). */
export interface SceneKeyframe {
  readonly id: KeyframeId
  /** Game minute of day the keyframe is reached, 0–1439. */
  readonly atMinute: number
  /** Minutes the keyframe stays fully on before blending towards the next one. */
  readonly holdMinutes: number
  readonly ui: UiTheme
  readonly sun: SunPose
  readonly sunIntensity: number
  /** `LightShadow.intensity`, 0–1: the shadow fades at night instead of being toggled. */
  readonly shadowIntensity: number
  readonly ambientIntensity: number
  readonly hemisphereIntensity: number
  /** Night glow (lit windows, landmark glow), 0–1. Drives the shared `uNightGlow` uniform. */
  readonly nightGlow: number
}

/** scene.json `dayNight`. */
export interface SceneDayNight {
  /** Lighting changes in steps of this many game minutes, so the scene re-renders rarely. */
  readonly quantizeMinutes: number
  /** The sun never drops below this, so shadows and shading stay readable at any hour. */
  readonly minSunElevationDeg: number
  /** In clock order, each id once. */
  readonly keyframes: readonly SceneKeyframe[]
}

/** theme.json: raw colours by token, and each keyframe's colour slots as tokens. */
export interface ThemeDayNight {
  readonly colors: Readonly<Record<string, string>>
  readonly sky: Readonly<Record<KeyframeId, KeyframeColors<string>>>
}

/** Every keyframe's colour slots, resolved to hex. */
export type SkyColors = Readonly<Partial<Record<KeyframeId, KeyframeColors<string>>>>

/** A keyframe with its colours resolved to hex. */
export interface DayNightKeyframe extends SceneKeyframe {
  readonly colors: KeyframeColors<string>
}

/** The resolved model `lightingAt` reads. */
export interface DayNightModel {
  readonly quantizeMinutes: number
  readonly minSunElevationDeg: number
  readonly keyframes: readonly DayNightKeyframe[]
}

export interface Vec3 {
  readonly x: number
  readonly y: number
  readonly z: number
}

/**
 * The lighting at one moment. `blend` mode moves smoothly between keyframes; `step` mode
 * (reduced motion) shows the current keyframe as is.
 */
export interface Lighting {
  /** Quantised minute of day, 0–1439. */
  readonly minute: number
  readonly mode: 'blend' | 'step'
  /** Keyframe the current segment starts at, and the one it blends towards. */
  readonly keyframe: KeyframeId
  readonly next: KeyframeId
  /** Blend fraction towards `next`, 0–1 (always 0 in step mode). */
  readonly t: number
  readonly ui: UiTheme
  readonly sun: SunPose
  /** Unit vector towards the sun in scene axes. */
  readonly sunDirection: Vec3
  readonly sunIntensity: number
  readonly shadowIntensity: number
  readonly ambientIntensity: number
  readonly hemisphereIntensity: number
  readonly nightGlow: number
  /** Lowercase `#rrggbb`, blended in linear light. */
  readonly colors: KeyframeColors<string>
}

export interface LightingOptions {
  /** Reduced motion: no blends, the lighting changes only at keyframes. */
  readonly step?: boolean
}
