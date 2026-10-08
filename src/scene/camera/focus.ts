/**
 * The camera move to a place picked outside the map (the Places panel, a hook; S04c): the view
 * keeps its tilt and turn, re-centres on the place and comes in to at most `maxDistanceM`, so a
 * place picked from the list is in view when its sheet opens. Pure maths, no three or React.
 */
import type { ScenePoint } from './limits'

export interface CameraPose {
  readonly target: ScenePoint
  readonly position: ScenePoint
}

/** The pose looking at `ground` from the current direction, no farther than `maxDistanceM`. */
export function focusPose(
  current: CameraPose,
  ground: ScenePoint,
  maxDistanceM: number,
): CameraPose {
  const dx = current.position.x - current.target.x
  const dy = current.position.y - current.target.y
  const dz = current.position.z - current.target.z
  const distance = Math.hypot(dx, dy, dz)
  const scale = distance > maxDistanceM && distance > 0 ? maxDistanceM / distance : 1
  return {
    target: { x: ground.x, y: ground.y, z: ground.z },
    position: { x: ground.x + dx * scale, y: ground.y + dy * scale, z: ground.z + dz * scale },
  }
}

/** Smooth start and stop (cubic), for t in [0, 1]. */
export function easeInOut(t: number): number {
  const clamped = Math.min(1, Math.max(0, t))
  return clamped < 0.5 ? 4 * clamped ** 3 : 1 - (-2 * clamped + 2) ** 3 / 2
}

const mix = (a: ScenePoint, b: ScenePoint, t: number): ScenePoint => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  z: a.z + (b.z - a.z) * t,
})

/** The pose a fraction `t` (already eased) of the way from `from` to `to`. */
export function mixPose(from: CameraPose, to: CameraPose, t: number): CameraPose {
  return { target: mix(from.target, to.target, t), position: mix(from.position, to.position, t) }
}
