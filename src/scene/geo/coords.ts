/**
 * Local metres (src/lib/geo/projection.ts: x east, y north) to scene space. 1 scene unit = 1 m;
 * three's y axis is up, so north runs along -z.
 *
 * Flat layers are built as shapes in the XY plane (x east, y north) and then rotated with
 * `rotateX(-Math.PI / 2)`, which maps (x, y, z) to (x, z, -y): the same convention.
 */
import { Vector3 } from 'three'
import type { LocalPoint } from '@/lib/geo/projection'

/** Rotation that lays an XY-plane shape on the ground (extrusion depth becomes height). */
export const LAY_FLAT_X = -Math.PI / 2

export function toScene(point: LocalPoint, height: number, target = new Vector3()): Vector3 {
  return target.set(point.x, height, -point.y)
}

/** The local-metre point under a scene position. */
export function toLocal(position: { readonly x: number; readonly z: number }): LocalPoint {
  return { x: position.x, y: -position.z }
}
