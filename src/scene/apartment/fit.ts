/**
 * Fitting the apartment into the free scene row (S16). The room's bounding sphere must fit the
 * part of the view between the HUD and the sheet, not the whole canvas: FreeRowFraming
 * (src/scene/camera/FreeRowFraming.tsx) slides the view so the camera target sits at the row's
 * centre, and the camera backs off along its data direction until the sphere fits the row's
 * height and the canvas width. Pure maths, no three or DOM.
 */
export type Point3 = readonly [number, number, number]

export interface Sphere {
  readonly center: Point3
  readonly radius: number
}

/** The sphere around an axis-aligned box. */
export function boundingSphere(min: Point3, max: Point3): Sphere {
  const center: Point3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2]
  const radius = Math.hypot(max[0] - center[0], max[1] - center[1], max[2] - center[2])
  return { center, radius }
}

export interface FitView {
  readonly fovDeg: number
  /** The canvas, in CSS pixels. */
  readonly width: number
  readonly height: number
  /** The free scene row's height in CSS pixels (at most the canvas height). */
  readonly rowHeight: number
  /** Extra room around the sphere (1 = touching). */
  readonly margin: number
}

/**
 * The camera distance from the sphere's centre at which it fits the row vertically and the
 * canvas horizontally. A row of zero height (nothing visible) fits at the full canvas instead.
 */
export function fitDistance(sphere: Sphere, view: FitView): number {
  const tanHalf = Math.tan((view.fovDeg * Math.PI) / 360)
  const rows = view.rowHeight > 0 ? Math.min(view.rowHeight, view.height) : view.height
  const halfVertical = Math.atan((tanHalf * rows) / view.height)
  const halfHorizontal = Math.atan((tanHalf * view.width) / view.height)
  const half = Math.min(halfVertical, halfHorizontal)
  return (sphere.radius * view.margin) / Math.sin(half)
}

/** Where the camera stands: `distance` from the centre, along the unit direction from `target` to `from`. */
export function cameraPosition(
  center: Point3,
  from: Point3,
  target: Point3,
  distance: number,
): Point3 {
  const dir: Point3 = [from[0] - target[0], from[1] - target[1], from[2] - target[2]]
  const length = Math.hypot(dir[0], dir[1], dir[2])
  if (length === 0) throw new Error('apartment camera: position and target coincide')
  return [
    center[0] + (dir[0] / length) * distance,
    center[1] + (dir[1] / length) * distance,
    center[2] + (dir[2] / length) * distance,
  ]
}
