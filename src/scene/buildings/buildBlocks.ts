/**
 * Procedural low blocks outside the districts (S04d): one InstancedMesh per borough of a unit
 * box without a floor (10 triangles), each instance moved to its block, turned to the borough's
 * street grid and stretched to its size and height. Only the blocks in view are drawn: on every
 * view change the visible ones (inside the camera frustum and within the tier's draw distance)
 * are packed to the front of the instance buffers, so a borough costs one draw call and the
 * triangle count follows the view, not the city (TUNE-7). three only, no React.
 */
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Frustum,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Quaternion,
  Sphere,
  Vector3,
  type Camera,
  type Material,
} from 'three'
import { decodePath } from '@/lib/geo/codec'
import type { BoroughId } from '../geo/schema'
import { massNoise, pick } from './buildDistrict'
import type { Blocks } from './schema'

export const BLOCK_TRIANGLES = 10

/** A unit box (x and z from -0.5 to 0.5, y from 0 to 1) without its floor, flat-shaded. */
export function buildBlockGeometry(): BufferGeometry {
  // Each face: four corners counter-clockwise seen from outside, and its outward normal.
  const faces: [number[][], number[]][] = [
    [
      [
        [-0.5, 0, 0.5],
        [0.5, 0, 0.5],
        [0.5, 1, 0.5],
        [-0.5, 1, 0.5],
      ],
      [0, 0, 1],
    ],
    [
      [
        [0.5, 0, -0.5],
        [-0.5, 0, -0.5],
        [-0.5, 1, -0.5],
        [0.5, 1, -0.5],
      ],
      [0, 0, -1],
    ],
    [
      [
        [0.5, 0, 0.5],
        [0.5, 0, -0.5],
        [0.5, 1, -0.5],
        [0.5, 1, 0.5],
      ],
      [1, 0, 0],
    ],
    [
      [
        [-0.5, 0, -0.5],
        [-0.5, 0, 0.5],
        [-0.5, 1, 0.5],
        [-0.5, 1, -0.5],
      ],
      [-1, 0, 0],
    ],
    [
      [
        [-0.5, 1, 0.5],
        [0.5, 1, 0.5],
        [0.5, 1, -0.5],
        [-0.5, 1, -0.5],
      ],
      [0, 1, 0],
    ],
  ]
  const positions: number[] = []
  const normals: number[] = []
  const index: number[] = []
  faces.forEach(([corners, normal], face) => {
    for (const corner of corners) {
      positions.push(...corner)
      normals.push(...normal)
    }
    const v = face * 4
    index.push(v, v + 1, v + 2, v, v + 2, v + 3)
  })
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3))
  geometry.setIndex(index)
  return geometry
}

interface BoroughBlocks {
  readonly borough: BoroughId
  readonly mesh: InstancedMesh
  /** Every block's full instance matrix, 16 floats each, in file order. */
  readonly matrices: Float32Array
  readonly colors: Float32Array
  /** Bounding sphere of each block: centre x, y, z and radius. */
  readonly spheres: Float32Array
  readonly count: number
}

export interface BlocksView {
  /** Blocks in the file. */
  readonly total: number
  /** Blocks drawn for the current view. */
  readonly drawn: number
  readonly triangles: number
}

export interface BlocksObjects {
  readonly group: Group
  /** Packs the blocks in view (frustum and `maxDistanceM` from the camera) and returns them. */
  cull(camera: Camera, maxDistanceM: number): BlocksView
  view(): BlocksView
  dispose(): void
}

export interface BlockColors {
  /** Block colours, one picked per block (repeat a colour to weight it). */
  readonly blocks: readonly string[]
  /** Blocks on dimmed land ("expanding soon"), already mixed towards the background. */
  readonly dimmed: string
  readonly jitter: number
}

/** Offsets the colour pick's noise from the shade's (any constant far from the block count). */
const BLOCK_COLOR_SEED = 0x51ed

const _matrix = new Matrix4()
const _position = new Vector3()
const _rotation = new Quaternion()
const _scale = new Vector3()
const _up = new Vector3(0, 1, 0)
const _frustum = new Frustum()
const _projection = new Matrix4()
const _sphere = new Sphere()
const _camera = new Vector3()

export function buildBlocks(
  file: Blocks,
  groundY: number,
  colors: BlockColors,
  dimmedBoroughs: ReadonlySet<BoroughId>,
  materials: { readonly normal: Material; readonly dimmed: Material },
): BlocksObjects {
  const group = new Group()
  group.name = 'blocks'
  const geometry = buildBlockGeometry()
  const bases = colors.blocks.map((hex) => new Color(hex))
  const dim = new Color(colors.dimmed)
  const color = new Color()
  const half = (file.sizeM * Math.SQRT2) / 2
  let serial = 0

  const boroughs: BoroughBlocks[] = file.groups.map((entry) => {
    const points = decodePath(entry.p)
    const count = entry.h.length
    const matrices = new Float32Array(count * 16)
    const instanceColors = new Float32Array(count * 3)
    const spheres = new Float32Array(count * 4)
    const dimmed = dimmedBoroughs.has(entry.borough)
    _rotation.setFromAxisAngle(_up, (entry.angleDeg * Math.PI) / 180)
    points.forEach((point, i) => {
      const h = entry.h[i] ?? 1
      _position.set(point.x, groundY, -point.y)
      _scale.set(file.sizeM, h, file.sizeM)
      _matrix.compose(_position, _rotation, _scale).toArray(matrices, i * 16)
      const shade = 1 + colors.jitter * (2 * massNoise(serial) - 1)
      // A second, independent noise picks the colour, so shade and colour don't correlate.
      const base = pick(bases, massNoise(serial + BLOCK_COLOR_SEED))
      serial++
      color
        .copy(dimmed ? dim : base)
        .multiplyScalar(shade)
        .toArray(instanceColors, i * 3)
      spheres.set([point.x, groundY + h / 2, -point.y, Math.hypot(half, h / 2)], i * 4)
    })
    const mesh = new InstancedMesh(geometry, dimmed ? materials.dimmed : materials.normal, count)
    mesh.name = `blocks-${entry.borough}`
    // Culled per block in `cull`, so three's per-mesh test (on stale bounds) is skipped.
    mesh.frustumCulled = false
    mesh.raycast = () => {}
    mesh.count = 0
    mesh.visible = false
    mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(count * 3), 3)
    group.add(mesh)
    return {
      borough: entry.borough,
      mesh,
      matrices,
      colors: instanceColors,
      spheres,
      count,
    }
  })

  const total = boroughs.reduce((sum, b) => sum + b.count, 0)
  let current: BlocksView = { total, drawn: 0, triangles: 0 }

  return {
    group,
    cull(camera, maxDistanceM) {
      camera.updateMatrixWorld()
      _projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
      _frustum.setFromProjectionMatrix(_projection)
      camera.getWorldPosition(_camera)
      let drawn = 0
      for (const borough of boroughs) {
        const matrixArray = borough.mesh.instanceMatrix.array as Float32Array
        const colorArray = borough.mesh.instanceColor?.array as Float32Array | undefined
        let n = 0
        for (let i = 0; i < borough.count; i++) {
          const s = i * 4
          _sphere.center.set(
            borough.spheres[s] ?? 0,
            borough.spheres[s + 1] ?? 0,
            borough.spheres[s + 2] ?? 0,
          )
          _sphere.radius = borough.spheres[s + 3] ?? 0
          if (_sphere.center.distanceTo(_camera) - _sphere.radius > maxDistanceM) continue
          if (!_frustum.intersectsSphere(_sphere)) continue
          matrixArray.set(borough.matrices.subarray(i * 16, i * 16 + 16), n * 16)
          colorArray?.set(borough.colors.subarray(i * 3, i * 3 + 3), n * 3)
          n++
        }
        borough.mesh.count = n
        borough.mesh.visible = n > 0
        borough.mesh.instanceMatrix.needsUpdate = true
        if (borough.mesh.instanceColor !== null) borough.mesh.instanceColor.needsUpdate = true
        drawn += n
      }
      current = { total, drawn, triangles: drawn * BLOCK_TRIANGLES }
      return current
    },
    view: () => current,
    dispose() {
      geometry.dispose()
      for (const borough of boroughs) borough.mesh.dispose()
    },
  }
}
