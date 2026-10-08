'use client'

/**
 * The sun: one directional light. On the high tier it casts the scene's only real-time shadow
 * (perf.json `shadows: pcf-directional`, a PCFShadowMap set on the canvas, never PCFSoft). The
 * light follows the camera target from the day/night cycle's sun direction (S04f), and its
 * shadow camera scales with the camera distance so the shadow map always covers the view. At
 * night the same light is a cool moon.
 *
 * Turning the shadow off (a lower tier, a runtime step-down) clears `castShadow`, which changes
 * the lights' state and so recompiles the lit materials without a shadow. The time of day never
 * does that: night fades the shadow with `shadow.intensity`, a uniform.
 */
import { useEffect, useRef } from 'react'
import { useThree } from '@react-three/fiber'
import { Vector3, type DirectionalLight } from 'three'
import { MapControls } from 'three/addons/controls/MapControls.js'
import type { SceneConfig } from '@/lib/data/schemas/scene'

/** Name of the light in the scene graph (the e2e hook finds it by name). */
export const SUN_LIGHT_NAME = 'sun'

interface SunLightProps {
  readonly color: string
  readonly intensity: number
  /** Towards the sun, in scene axes (x east, y up, z south); need not be normalised. */
  readonly direction: { readonly x: number; readonly y: number; readonly z: number }
  /** LightShadow.intensity, 0–1. */
  readonly shadowIntensity: number
  readonly lights: SceneConfig['lights']
  /** The tier's shadow map size; 0 for no shadow. */
  readonly shadowMapSizePx: number
}

export function SunLight({
  color,
  intensity,
  direction,
  shadowIntensity,
  lights,
  shadowMapSizePx,
}: SunLightProps) {
  const controls = useThree((state) => state.controls)
  const invalidate = useThree((state) => state.invalidate)
  const ref = useRef<DirectionalLight>(null)
  const { shadow } = lights
  const castShadow = shadowMapSizePx > 0
  // Primitives, so placement re-runs only when the direction really changes.
  const { x: dx, y: dy, z: dz } = direction

  useEffect(() => {
    const light = ref.current
    if (light === null) return
    // A map of another size is reallocated on the next shadow render; none is kept while off.
    light.shadow.map?.dispose()
    light.shadow.map = null
    invalidate()
  }, [castShadow, shadowMapSizePx, invalidate])

  useEffect(() => {
    const light = ref.current
    if (light === null) return
    const towardsSun = new Vector3(dx, dy, dz).normalize()
    const place = () => {
      if (controls instanceof MapControls) {
        const distance = controls.getDistance()
        light.target.position.copy(controls.target)
        light.position
          .copy(controls.target)
          .addScaledVector(towardsSun, distance * shadow.lightPerDistance)
        const extent = distance * shadow.extentPerDistance
        const camera = light.shadow.camera
        camera.left = -extent
        camera.right = extent
        camera.top = extent
        camera.bottom = -extent
        camera.near = 0
        camera.far = distance * shadow.depthPerDistance
        camera.updateProjectionMatrix()
      } else {
        light.target.position.set(0, 0, 0)
        light.position.copy(towardsSun)
      }
      // The target is not in the scene graph, so its world matrix is updated here.
      light.target.updateMatrixWorld()
    }
    place()
    invalidate()
    if (!(controls instanceof MapControls)) return
    controls.addEventListener('change', place)
    return () => controls.removeEventListener('change', place)
  }, [controls, dx, dy, dz, shadow, invalidate])

  return (
    <directionalLight
      ref={ref}
      name={SUN_LIGHT_NAME}
      color={color}
      intensity={intensity}
      castShadow={castShadow}
      shadow-intensity={shadowIntensity}
      shadow-mapSize={[shadowMapSizePx, shadowMapSizePx]}
      shadow-bias={shadow.bias}
      shadow-normalBias={shadow.normalBias}
    />
  )
}
