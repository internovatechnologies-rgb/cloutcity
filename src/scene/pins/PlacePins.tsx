'use client'

/**
 * Picking and selection for the place pins (S04c):
 * - a tap on the canvas (tap.ts) picks the nearest pin head on screen (pick.ts) and opens its
 *   sheet through `openPlace` (origin `map`), or opens the Places panel as a chooser when the
 *   tap lands on several pins at once;
 * - the open place gets the selection ring;
 * - a place opened from outside the map (the panel, a hook) brings the camera to it with a
 *   short tween, or a cut under `prefers-reduced-motion` (CLAUDE.md "Art direction"); any input
 *   of the player's on the map ends the tween where it is.
 *
 * Every camera step goes through the controls, so the rig's extent clamp and on-demand
 * rendering apply as they do to a gesture.
 */
import { useCallback, useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { MapControls } from 'three/addons/controls/MapControls.js'
import type { SceneConfig } from '@/lib/data/schemas/scene'
import { currentPlaceId, onOpenPlaceChange, onPlacePicked, openPlace } from '@/state/placeSheet'
import { openPlacesChooser } from '@/state/placesPanel'
import { easeInOut, focusPose, mixPose, type CameraPose } from '../camera/focus'
import { beginContinuous, endContinuous } from '../quality/continuity'
import type { PinObjects } from './buildPins'
import { pickPin } from './pick'
import { attachTapDetector } from './tap'

interface PlacePinsProps {
  readonly pins: PinObjects
  readonly config: Pick<SceneConfig, 'pins' | 'focus'>
  /** Height of the land top, where the camera target rests. */
  readonly groundY: number
}

interface Tween {
  readonly from: CameraPose
  readonly to: CameraPose
  elapsedMs: number
  started: boolean
}

const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

export function PlacePins({ pins, config, groundY }: PlacePinsProps) {
  const gl = useThree((state) => state.gl)
  // Only a dependency: the effect re-runs when the camera rig installs its controls.
  const controls = useThree((state) => state.controls)
  const invalidate = useThree((state) => state.invalidate)
  const get = useThree((state) => state.get)
  const tween = useRef<Tween | null>(null)
  const applyRef = useRef<((pose: CameraPose) => void) | null>(null)
  // A flight keeps the scene animating: the runtime step-down measures FPS only then.
  const stopTween = useCallback(() => {
    tween.current = null
    endContinuous('flight')
  }, [])

  useEffect(() => {
    const canvas = gl.domElement
    return attachTapDetector(
      canvas,
      { slopPx: config.pins.tapSlopPx, maxMs: config.pins.tapMaxMs },
      (clientX, clientY) => {
        const rect = canvas.getBoundingClientRect()
        const screen = pins.screenPins(get().camera, rect.width, rect.height)
        const picked = pickPin(
          screen,
          { x: clientX - rect.left, y: clientY - rect.top },
          config.pins,
        )
        if (picked.kind === 'one') openPlace(picked.id, { origin: 'map' })
        else if (picked.kind === 'many') openPlacesChooser(picked.ids)
      },
    )
  }, [gl, get, pins, config.pins])

  useEffect(() => {
    // Mutated through the store's own reference (three's model), not the hook value.
    const rig = get().controls
    if (!(rig instanceof MapControls)) return
    const select = (placeId: string | null) => {
      if (pins.selectedId() === placeId) return
      pins.setSelected(placeId)
      invalidate()
    }
    const apply = (pose: CameraPose) => {
      const { camera } = get()
      rig.target.set(pose.target.x, pose.target.y, pose.target.z)
      camera.position.set(pose.position.x, pose.position.y, pose.position.z)
      // Fires the controls' change event: the rig clamps the target and requests a frame.
      rig.update()
    }
    const focus = (placeId: string) => {
      const ground = pins.groundOf(placeId)
      if (ground === null) return
      const { camera } = get()
      const from: CameraPose = {
        target: { x: rig.target.x, y: rig.target.y, z: rig.target.z },
        position: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
      }
      const to = focusPose(
        from,
        { x: ground.x, y: groundY, z: ground.z },
        config.focus.maxDistanceM,
      )
      if (config.focus.tweenMs === 0 || prefersReducedMotion()) {
        stopTween()
        apply(to)
        return
      }
      tween.current = { from, to, elapsedMs: 0, started: false }
      beginContinuous('flight')
      invalidate()
    }
    // The player's own input (a drag, pinch, wheel or tap: MapControls' `start`) ends a flight
    // still under way, so the flight never drags the camera back from where they took it.
    // `apply` only fires `change`, so the flight cannot cancel itself.
    const interrupt = stopTween
    rig.addEventListener('start', interrupt)
    applyRef.current = apply
    select(currentPlaceId())
    const offChange = onOpenPlaceChange(select)
    const offPicked = onPlacePicked((placeId, origin) => {
      if (origin !== 'map') focus(placeId)
    })
    return () => {
      rig.removeEventListener('start', interrupt)
      offChange()
      offPicked()
      stopTween()
      applyRef.current = null
    }
  }, [controls, get, groundY, invalidate, pins, config.focus, stopTween])

  // Steps the focus tween once per rendered frame and requests the next one until it ends.
  useFrame((_, deltaS) => {
    const current = tween.current
    const apply = applyRef.current
    if (current === null || apply === null) return
    // The first frame's delta spans the idle time before it (on-demand rendering): skip it.
    if (current.started) current.elapsedMs += deltaS * 1000
    current.started = true
    const t = Math.min(1, current.elapsedMs / config.focus.tweenMs)
    apply(mixPose(current.from, current.to, easeInOut(t)))
    if (t >= 1) stopTween()
    else invalidate()
  })

  return null
}
