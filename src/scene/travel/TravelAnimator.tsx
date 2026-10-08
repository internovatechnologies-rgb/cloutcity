'use client'

/**
 * The trip in 3D (S08 part 2): while a trip animates (src/state/trip.ts) the avatar moves along
 * the route's legs, rides a taxi on the road legs and a subway car along its line's ribbon, and a
 * short trail follows it (src/scene/travel/travelRunner.ts). The animation only shows a trip the
 * save already holds (DEC-22), on the same clock as the DOM progress card (`startedAtMs` on
 * `performance.now()`), for at most `transit.animation.maxMs`.
 *
 * The camera follows the traveller in the free scene row (the rig's target is the framed point,
 * FreeRowFraming) until the player's own gesture takes the camera back. The scene renders only
 * while the trip animates (one frame requested per frame, then none: idle stays at zero frames),
 * and the runtime step-down measures FPS over it (`beginContinuous('travel')`).
 *
 * It tells the trip store whether it can animate at all: not before the city has drawn, and not
 * while the apartment has the screen; the travel chunk cuts straight to the arrival then.
 */
import { useEffect, useMemo, type RefObject } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import type { Group, Texture } from 'three'
import { MapControls } from 'three/addons/controls/MapControls.js'
import type { SceneConfig } from '@/lib/data/schemas/scene'
import { setTravelAnimator, tripStore, type ActiveTrip } from '@/state/trip'
import type { AvatarConfig } from '../avatar/buildAvatar'
import { beginContinuous, endContinuous } from '../quality/continuity'
import type { ScenePalette, TravelAnimation } from '../types'
import { createTravelRunner } from './travelRunner'

interface TravelAnimatorProps {
  /** The avatar's group: moved along the route, hidden while it rides. */
  readonly avatarRef: RefObject<Group | null>
  readonly groundY: number
  readonly palette: ScenePalette['travel']
  /** The city's toon ramp: the vehicles reuse a shader program the map already has. */
  readonly gradientMap: Texture
  readonly config: SceneConfig['travel']
  readonly avatar: AvatarConfig
  /** balance.json `transit.animation`, resolved on the server (src/scene/CityScene.tsx). */
  readonly animation: TravelAnimation
  /** False before the city has drawn and while the apartment has the screen. */
  readonly enabled: boolean
  /** The tier draws the trail (off on low unless the config allows it). */
  readonly trail: boolean
}

export function TravelAnimator({
  avatarRef,
  groundY,
  palette,
  gradientMap,
  config,
  avatar,
  animation,
  enabled,
  trail,
}: TravelAnimatorProps) {
  const get = useThree((state) => state.get)
  const invalidate = useThree((state) => state.invalidate)
  const scene = useThree((state) => state.scene)
  const controls = useThree((state) => state.controls)

  const runner = useMemo(
    () => createTravelRunner({ palette, gradientMap, config, avatar, animation, groundY }),
    [palette, gradientMap, config, avatar, animation, groundY],
  )

  useEffect(() => {
    scene.add(runner.group)
    return () => {
      scene.remove(runner.group)
      runner.dispose()
    }
  }, [scene, runner])

  // The travel chunk cuts to the arrival when nothing can animate it.
  useEffect(() => {
    setTravelAnimator(enabled)
    return () => setTravelAnimator(false)
  }, [enabled])

  useEffect(() => {
    const stop = () => {
      if (runner.tripId === null) return
      runner.stop(avatarRef.current)
      endContinuous('travel')
      invalidate()
    }
    const follow = (trip: ActiveTrip | null) => {
      if (trip === null || trip.durationMs <= 0) {
        stop()
        return
      }
      if (runner.tripId !== trip.id) beginContinuous('travel')
      runner.start(trip)
      invalidate()
    }
    follow(tripStore.getState().active)
    const off = tripStore.subscribe((state, previous) => {
      if (state.active !== previous.active) follow(state.active)
    })
    return () => {
      off()
      stop()
    }
  }, [runner, avatarRef, invalidate])

  // The player's own gesture takes the camera back from the follow.
  useEffect(() => {
    if (!(controls instanceof MapControls)) return
    const stopFollowing = () => runner.stopFollowing()
    controls.addEventListener('start', stopFollowing)
    return () => controls.removeEventListener('start', stopFollowing)
  }, [controls, runner])

  useFrame(() => {
    const body = avatarRef.current
    if (runner.tripId === null || body === null) return
    const { camera, controls: rig } = get()
    const moving = runner.step({
      nowMs: performance.now(),
      avatar: body,
      camera,
      controls: rig instanceof MapControls ? rig : null,
      trail,
    })
    if (moving) {
      invalidate()
      return
    }
    runner.stop(body)
    endContinuous('travel')
    invalidate()
  })

  return null
}
