import type { DayNightModel, SceneDayNight, SkyColors } from './types'

/**
 * The model from scene.json `dayNight` and the server's resolved sky colours, for the 3D chunk.
 * No checks here: both were validated on the server (the zod schemas, and `resolveDayNight` in
 * src/lib/theme.ts tests), so the chunk carries only this join.
 */
export function joinSkyColors(scene: SceneDayNight, sky: SkyColors): DayNightModel {
  return {
    quantizeMinutes: scene.quantizeMinutes,
    minSunElevationDeg: scene.minSunElevationDeg,
    keyframes: scene.keyframes.map((keyframe) => {
      const colors = sky[keyframe.id]
      if (colors === undefined) throw new Error(`dayNight: no sky colours for "${keyframe.id}"`)
      return { ...keyframe, colors }
    }),
  }
}
