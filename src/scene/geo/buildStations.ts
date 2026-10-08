/**
 * Station markers: one instanced low-poly cylinder per station (one draw call). The marker
 * radius follows the camera distance, clamped, so stations stay readable from street level to
 * the whole-city view. three only, no React.
 */
import { CylinderGeometry, Matrix4, Quaternion, Vector3 } from 'three'
import type { BufferGeometry, InstancedMesh } from 'three'

export interface StationScale {
  readonly heightM: number
  readonly radiusPerDistance: number
  readonly minRadiusM: number
  readonly maxRadiusM: number
}

/** Unit cylinder (radius 1, height 1, base at y = 0); instances scale it. */
export function buildStationGeometry(radialSegments: number): BufferGeometry {
  const geometry = new CylinderGeometry(1, 1, 1, radialSegments, 1)
  geometry.translate(0, 0.5, 0)
  geometry.deleteAttribute('uv')
  return geometry
}

export function stationRadius(distance: number, scale: StationScale): number {
  return Math.min(scale.maxRadiusM, Math.max(scale.minRadiusM, distance * scale.radiusPerDistance))
}

/** Station positions in scene space (x east, z = -north) at height `y`. */
export function stationPositions(
  stations: readonly { readonly x: number; readonly y: number }[],
  y: number,
): Float32Array {
  const out = new Float32Array(stations.length * 3)
  stations.forEach((station, index) => out.set([station.x, y, -station.y], index * 3))
  return out
}

const _matrix = new Matrix4()
const _position = new Vector3()
const _scale = new Vector3()
const _identity = new Quaternion()

/** Writes every instance matrix for marker radius `radius`. */
export function writeStationMatrices(
  mesh: InstancedMesh,
  positions: Float32Array,
  radius: number,
  heightM: number,
): void {
  _scale.set(radius, heightM, radius)
  for (let i = 0; i < mesh.count; i++) {
    _position.fromArray(positions, i * 3)
    mesh.setMatrixAt(i, _matrix.compose(_position, _identity, _scale))
  }
  mesh.instanceMatrix.needsUpdate = true
  // Instanced bounds follow the instances, so frustum culling stays right after a rescale.
  mesh.computeBoundingSphere()
}
