/**
 * The trip animation's three.js side (S08 part 2), outside React like the city's builders: a
 * taxi, a subway car and a trail, built once and reused, and the per-frame step that moves the
 * avatar along a trip's timeline (src/engine/transit/timeline.ts), shows the vehicle it rides,
 * extends the trail and, while following, slides the camera with it. three only, no React.
 */
import { BoxGeometry, Group, Mesh, Vector3, type Camera, type Texture } from 'three'
import type { MapControls } from 'three/addons/controls/MapControls.js'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js'
import { createTimeline, type Timeline } from '@/engine/transit/timeline'
import type { SceneConfig } from '@/lib/data/schemas/scene'
import type { ActiveTrip } from '@/state/trip'
import { avatarSize, type AvatarConfig } from '../avatar/buildAvatar'
import { toScene } from '../geo/coords'
import { createSurfaceMaterial } from '../shading'
import type { ScenePalette, TravelAnimation } from '../types'

export interface TravelRunnerOptions {
  readonly palette: ScenePalette['travel']
  /** The city's shared toon ramp. */
  readonly gradientMap: Texture
  readonly config: SceneConfig['travel']
  readonly avatar: AvatarConfig
  readonly animation: TravelAnimation
  readonly groundY: number
}

export interface StepInput {
  readonly nowMs: number
  readonly avatar: Group
  readonly camera: Camera
  /** The map controls, or null before they exist. */
  readonly controls: MapControls | null
  /** Whether the tier draws the trail. */
  readonly trail: boolean
}

export interface TravelRunner {
  /** The group to add to the scene (vehicles and trail). */
  readonly group: Group
  /** The trip being animated, or null. */
  readonly tripId: number | null
  /** Starts animating `trip` (or follows a seek of the same trip). */
  start(trip: ActiveTrip): void
  /** Stops following with the camera (the player's own gesture). */
  stopFollowing(): void
  /** Moves everything one frame on; returns false once the trip has landed (or none runs). */
  step(input: StepInput): boolean
  /** Ends the animation: vehicles and trail hidden, the avatar shown at the destination. */
  stop(avatar: Group | null): void
  dispose(): void
}

export function createTravelRunner(options: TravelRunnerOptions): TravelRunner {
  const { palette, gradientMap, config, avatar, animation, groundY } = options
  const box = new BoxGeometry(1, 1, 1)
  box.translate(0, 0.5, 0)
  // The city's own toon surface (plain colour, no vertex colours, like the water): the vehicles
  // reuse a shader program the map already compiled, so a trip never raises the program count
  // past perf.json `programsMax` (3D-2). The trail's line material matches the subway casing's.
  const taxiMaterial = createSurfaceMaterial({ gradientMap, color: palette.taxi })
  const trainMaterial = createSurfaceMaterial({ gradientMap, color: palette.train })
  const taxi = new Mesh(box, taxiMaterial)
  taxi.name = 'travel-taxi'
  const train = new Mesh(box, trainMaterial)
  train.name = 'travel-train'
  const trailGeometry = new LineSegmentsGeometry()
  const trailMaterial = new LineMaterial({
    color: palette.trail,
    linewidth: config.trailWidthPx,
    worldUnits: false,
  })
  const line = new LineSegments2(trailGeometry, trailMaterial)
  line.name = 'travel-trail'
  const group = new Group()
  group.name = 'travel'
  for (const object of [taxi, train, line]) {
    object.visible = false
    object.raycast = () => {}
    group.add(object)
  }
  // Segment pairs (xyz xyz) for up to trailMaxPoints points: never more than 64 (schema).
  const positions = new Float32Array((config.trailMaxPoints - 1) * 6)
  const trailPoints: Vector3[] = []
  const lastTrail = new Vector3()
  const point = new Vector3()
  const previous = new Vector3()

  let trip: ActiveTrip | null = null
  let timeline: Timeline | null = null
  let following = false

  const writeTrail = () => {
    positions.fill(0)
    for (let i = 1; i < trailPoints.length; i++) {
      const a = trailPoints[i - 1]
      const b = trailPoints[i]
      if (a === undefined || b === undefined) continue
      positions.set([a.x, a.y, a.z, b.x, b.y, b.z], (i - 1) * 6)
    }
    trailGeometry.setPositions(positions.subarray(0, (trailPoints.length - 1) * 6))
    line.visible = true
  }

  const runner: TravelRunner = {
    group,
    get tripId() {
      return trip?.id ?? null
    },
    start(next) {
      if (trip?.id === next.id) {
        trip = next
        return
      }
      trip = next
      timeline = createTimeline(next.route, { reducedMotion: false, animation })
      following = true
      trailPoints.length = 0
      lastTrail.set(Number.NaN, 0, 0)
    },
    stopFollowing() {
      following = false
    },
    step({ nowMs, avatar: body, camera, controls, trail }) {
      if (trip === null || timeline === null) return false
      const frame = timeline.frameAt(nowMs - trip.startedAtMs)
      toScene(frame.point, groundY, point)
      previous.copy(body.position)
      body.position.copy(point)

      const height = avatarSize(controls === null ? 0 : controls.getDistance(), avatar)
      const riding = frame.mode === 'taxi' ? taxi : frame.mode === 'subway' ? train : null
      taxi.visible = riding === taxi
      train.visible = riding === train
      body.visible = riding === null
      if (riding !== null) {
        const length = riding === taxi ? config.taxiLengthRatio : config.trainLengthRatio
        riding.position.copy(point)
        riding.scale.set(
          height * config.vehicleWidthRatio,
          height * config.vehicleHeightRatio,
          height * length,
        )
        const dx = point.x - previous.x
        const dz = point.z - previous.z
        if (dx !== 0 || dz !== 0) riding.rotation.set(0, Math.atan2(dx, dz), 0)
      }

      if (trail && !(point.distanceTo(lastTrail) <= height * config.trailStepRatio)) {
        lastTrail.copy(point)
        trailPoints.push(point.clone().setY(groundY + height * config.trailLiftRatio))
        if (trailPoints.length > config.trailMaxPoints) trailPoints.shift()
        if (trailPoints.length >= 2) writeTrail()
      }

      if (following && controls !== null) {
        const dx = point.x - controls.target.x
        const dz = point.z - controls.target.z
        controls.target.x += dx
        controls.target.z += dz
        camera.position.x += dx
        camera.position.z += dz
        // Fires `change`: the rig keeps the target in the city's extent and requests a frame.
        controls.update()
      }
      return !frame.done
    },
    stop(body) {
      // The trip is already in the save: however the animation ends (it finished, Skip, a hidden
      // tab, the apartment taking the screen), the avatar stands at the destination (TRV-2).
      if (timeline !== null && body !== null) {
        toScene(timeline.frameAt(Number.POSITIVE_INFINITY).point, groundY, body.position)
      }
      trip = null
      timeline = null
      following = false
      taxi.visible = false
      train.visible = false
      line.visible = false
      trailPoints.length = 0
      if (body !== null) body.visible = true
    },
    dispose() {
      box.dispose()
      taxiMaterial.dispose()
      trainMaterial.dispose()
      trailGeometry.dispose()
      trailMaterial.dispose()
    },
  }
  return runner
}
