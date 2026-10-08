/**
 * The apartment's lights for a personal-clock minute (S16 seam, S04f body): the city's day/night
 * keyframe brought indoors. Sun and ambient take the keyframe's colours and intensities scaled by
 * scene.json `dayNight.room`; the sun keeps the room's own direction (light through the window).
 * At night a share of warm lamp light (theme `scene.apartment.lamp`) is mixed into the ambient
 * colour with the night glow, so the room reads lamp-lit without adding a light (which would
 * recompile its materials).
 */
import { lightingAt as cityLightingAt, mixHexLinear } from '@/lib/dayNight/lightingAt'
import type { DayNightModel } from '@/lib/dayNight/types'
import type { SceneConfig } from '@/lib/data/schemas/scene'
import type { ApartmentConfig, RoomPalette } from './data'

export interface RoomLighting {
  readonly ambient: { readonly color: string; readonly intensity: number }
  readonly sun: {
    readonly color: string
    readonly intensity: number
    /** Towards the light, in room axes (x right, y up, z toward the camera). */
    readonly direction: { readonly x: number; readonly y: number; readonly z: number }
  }
}

export interface RoomLightingInput {
  readonly model: DayNightModel
  readonly room: SceneConfig['dayNight']['room']
  readonly lights: ApartmentConfig['lights']
  readonly palette: Pick<RoomPalette, 'lamp'>
  /** Reduced motion: keyframes step instead of blending. */
  readonly step?: boolean
}

/** `minute` is any game minute (the save's absolute clock); only its minute of day counts. */
export function lightingAt(minute: number, input: RoomLightingInput): RoomLighting {
  const city = cityLightingAt(minute, input.model, { step: input.step === true })
  const lamp = city.nightGlow * input.room.lampMix
  return {
    ambient: {
      color:
        lamp > 0
          ? mixHexLinear(city.colors.ambient, input.palette.lamp, lamp)
          : city.colors.ambient,
      intensity: city.ambientIntensity * input.room.ambientScale,
    },
    sun: {
      color: city.colors.sun,
      intensity: city.sunIntensity * input.room.sunScale,
      direction: input.lights.sunDirection,
    },
  }
}
