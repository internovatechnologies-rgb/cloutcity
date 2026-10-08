'use client'

/**
 * The day/night rig (S04f): the city's light on the personal game clock. It owns the sky colour
 * behind the city (the canvas background; there is no sky dome, the camera never sees the
 * horizon), the fog, the hemisphere and ambient lights and the sun, and writes the shared
 * day/night uniforms (`uNightGlow`, the unlit tint) that lit windows, landmark glow and model
 * emissive read through `DayNightContext`.
 *
 * Every light and the fog are mounted from the first frame and are never added or removed, and
 * the shadow is never toggled for the night: the time of day changes colours, intensities and
 * uniforms only, so no shader recompiles and the program count stays constant. The scene is
 * redrawn only when the lighting key changes (a new keyframe, or the next quantised minute of a
 * blend): the frameloop stays on demand and an idle map draws nothing.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useThree } from '@react-three/fiber'
import type { AmbientLight, Color, Fog, HemisphereLight } from 'three'
import { MapControls } from 'three/addons/controls/MapControls.js'
import { lightingKey } from '@/lib/dayNight/lightingKey'
import type { KeyframeColors, Lighting } from '@/lib/dayNight/types'
import type { SceneConfig } from '@/lib/data/schemas/scene'
import { SunLight } from '../SunLight'
import { DayNightContext, type DayNightUniforms } from './nightGlow'

/** Whatever else follows the lighting's colours (the city's water and unlit overlays). */
export interface DayNightTarget {
  applyDayNight(colors: KeyframeColors<string>): void
}

interface DayNightRigProps {
  readonly lighting: Lighting
  /** Created once by the canvas, shared with the city build and every glowing material. */
  readonly uniforms: DayNightUniforms
  readonly target: DayNightTarget
  readonly fog: SceneConfig['dayNight']['fog']
  readonly lights: SceneConfig['lights']
  /** The camera distance before the camera controls exist. */
  readonly distanceM: number
  /** The tier's shadow map size; 0 for no shadow. */
  readonly shadowMapSizePx: number
  readonly children: ReactNode
}

/** Writes the lighting's colours and glow into the shared uniforms. */
export function applyUniforms(uniforms: DayNightUniforms, lighting: Lighting): void {
  uniforms.uNightGlow.value = lighting.nightGlow
  uniforms.unlitTint.value.set(lighting.colors.unlitTint)
}

export function DayNightRig({
  lighting,
  uniforms,
  target,
  fog,
  lights,
  distanceM,
  shadowMapSizePx,
  children,
}: DayNightRigProps) {
  const controls = useThree((state) => state.controls)
  const invalidate = useThree((state) => state.invalidate)
  const background = useRef<Color>(null)
  const fogRef = useRef<Fog>(null)
  const hemisphere = useRef<HemisphereLight>(null)
  const ambient = useRef<AmbientLight>(null)
  const key = lightingKey(lighting)
  // The first lighting builds the objects (args); later ones only mutate them.
  const [first] = useState(lighting)

  // A layout effect: written before the first frame and before any child's effects compile.
  useLayoutEffect(() => {
    const { colors } = lighting
    background.current?.set(colors.sky)
    fogRef.current?.color.set(colors.fog)
    if (hemisphere.current !== null) {
      hemisphere.current.color.set(colors.hemisphereSky)
      hemisphere.current.groundColor.set(colors.hemisphereGround)
      hemisphere.current.intensity = lighting.hemisphereIntensity
    }
    if (ambient.current !== null) {
      ambient.current.color.set(colors.ambient)
      ambient.current.intensity = lighting.ambientIntensity
    }
    applyUniforms(uniforms, lighting)
    target.applyDayNight(colors)
    invalidate()
    // `key` identifies `lighting` (useDayNightLighting keeps it stable within a key).
  }, [key, lighting, uniforms, target, invalidate])

  // Fog distances follow the camera distance, like the sun's shadow camera.
  useEffect(() => {
    const scaled = (distance: number) => {
      const current = fogRef.current
      if (current === null) return
      current.near = distance * fog.nearPerDistance
      current.far = distance * fog.farPerDistance
    }
    if (!(controls instanceof MapControls)) {
      scaled(distanceM)
      return
    }
    const place = () => scaled(controls.getDistance())
    place()
    invalidate()
    controls.addEventListener('change', place)
    return () => controls.removeEventListener('change', place)
  }, [controls, fog, distanceM, invalidate])

  return (
    <>
      <color ref={background} attach="background" args={[first.colors.sky]} />
      <fog
        ref={fogRef}
        attach="fog"
        args={[first.colors.fog, distanceM * fog.nearPerDistance, distanceM * fog.farPerDistance]}
      />
      <hemisphereLight
        ref={hemisphere}
        args={[
          first.colors.hemisphereSky,
          first.colors.hemisphereGround,
          first.hemisphereIntensity,
        ]}
      />
      <ambientLight ref={ambient} args={[first.colors.ambient, first.ambientIntensity]} />
      <SunLight
        color={lighting.colors.sun}
        intensity={lighting.sunIntensity}
        direction={lighting.sunDirection}
        shadowIntensity={lighting.shadowIntensity}
        lights={lights}
        shadowMapSizePx={shadowMapSizePx}
      />
      <DayNightContext value={uniforms}>{children}</DayNightContext>
    </>
  )
}
