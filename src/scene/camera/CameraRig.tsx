'use client'

/**
 * The map camera: three's MapControls (one-finger / left-drag pan anchored to the ground,
 * pinch / wheel zoom towards the pointer, two-finger / right-drag rotate and tilt), limited to
 * the configured zoom, tilt and turn ranges, with the target kept inside the NYC extent. Every
 * change requests one frame (frameloop "demand"), so an idle map renders nothing.
 *
 * The keyboard and DOM path to every place is the Places panel (S04c, A11Y-3); a place picked
 * there brings the camera to it (pins/PlacePins.tsx).
 */
import { useEffect, useRef } from 'react'
import { useThree } from '@react-three/fiber'
import { PerspectiveCamera } from 'three'
import { MapControls } from 'three/addons/controls/MapControls.js'
import type { SceneConfig } from '@/lib/data/schemas/scene'
import type { LocalPoint } from '@/lib/geo/projection'
import { beginContinuous, endContinuous } from '../quality/continuity'
import { clampTarget, degToRad, initialPose, nearFar, type LocalBounds } from './limits'

interface CameraRigProps {
  readonly camera: SceneConfig['camera']
  /**
   * Where the camera starts. Read once, when the controls are created: a later change (the
   * player's home loading from the save, a trip, S08) must not rebuild the controls and snap the
   * camera back; the avatar and the trip's follow camera move the view instead.
   */
  readonly start: LocalPoint
  readonly bounds: LocalBounds
  /** Height of the plane the target moves on (the land top). */
  readonly groundY: number
}

export function CameraRig({ camera: rig, start, bounds, groundY }: CameraRigProps) {
  const get = useThree((state) => state.get)
  const set = useThree((state) => state.set)
  const invalidate = useThree((state) => state.invalidate)
  const startRef = useRef(start)

  useEffect(() => {
    // Read from the store inside the effect: the rig mutates the camera, which is three's model
    // (and must not be a hook value the React compiler treats as immutable).
    const { camera, gl } = get()
    // OrbitControls only warns (a console warning) on other camera types; fail loudly instead.
    if (!(camera instanceof PerspectiveCamera)) {
      throw new Error('CameraRig needs a PerspectiveCamera')
    }
    const pose = initialPose(
      startRef.current,
      groundY,
      rig.distanceM,
      rig.polarDeg.default,
      rig.azimuthDeg.default,
    )
    const controls = new MapControls(camera, gl.domElement)
    // The constructor has already run one update() around the origin; place the pose after it.
    controls.target.set(pose.target.x, pose.target.y, pose.target.z)
    camera.position.set(pose.position.x, pose.position.y, pose.position.z)
    controls.enableDamping = false
    controls.zoomToCursor = true
    controls.minDistance = rig.minDistanceM
    controls.maxDistance = rig.maxDistanceM
    controls.minPolarAngle = degToRad(rig.polarDeg.min)
    controls.maxPolarAngle = degToRad(rig.polarDeg.max)
    controls.minAzimuthAngle = degToRad(rig.azimuthDeg.min)
    controls.maxAzimuthAngle = degToRad(rig.azimuthDeg.max)

    const applyClip = () => {
      const { near, far } = nearFar(controls.getDistance(), rig)
      if (camera.near !== near || camera.far !== far) {
        camera.near = near
        camera.far = far
        camera.updateProjectionMatrix()
      }
    }

    // Keep the target inside the extent by moving camera and target together (the view
    // direction is unchanged), so panning stops at the edge instead of tilting the camera.
    const onChange = () => {
      const target = controls.target
      const clamped = clampTarget(target, bounds)
      const dx = clamped.x - target.x
      const dz = clamped.z - target.z
      if (dx !== 0 || dz !== 0) {
        target.x += dx
        target.z += dz
        camera.position.x += dx
        camera.position.z += dz
      }
      applyClip()
      invalidate()
    }
    // A gesture keeps the scene animating: the runtime step-down measures FPS only then
    // (src/scene/quality/TierMonitor.tsx).
    const onStart = () => beginContinuous('gesture')
    const onEnd = () => endContinuous('gesture')
    controls.addEventListener('change', onChange)
    controls.addEventListener('start', onStart)
    controls.addEventListener('end', onEnd)
    controls.update()
    applyClip()
    set({ controls })
    invalidate()

    return () => {
      controls.removeEventListener('change', onChange)
      controls.removeEventListener('start', onStart)
      controls.removeEventListener('end', onEnd)
      endContinuous('gesture')
      controls.dispose()
      set({ controls: null })
    }
  }, [get, set, invalidate, rig, bounds, groundY])

  return null
}
