/**
 * Turns a decoded GLB (three r182 GLTFLoader + its bundled MeshoptDecoder) into what the
 * runtime renders. The pack materials are dropped: every model draws with the shared model
 * material (materials.ts) and its baked vertex colours.
 *
 * Geometry stays exactly as decoded. The pipeline quantizes positions to normalised integers
 * and puts the real-world scale on the mesh node, so baking that node transform into the
 * vertices would clamp them; a static model keeps it as `matrix` instead, applied per instance.
 */
import {
  AnimationClip,
  BufferGeometry,
  Matrix4,
  Mesh,
  SkinnedMesh,
  type Material,
  type Object3D,
} from 'three'
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import type { ModelRef } from './types'

/** A static model: one merged mesh, drawn alone or instanced. */
export interface StaticModel {
  readonly kind: 'static'
  readonly geometry: BufferGeometry
  /** The mesh's transform inside the GLB (real-world scale, pivot): placement × matrix. */
  readonly matrix: Matrix4
  readonly triangles: number
}

/** An avatar part (head, body): a skinned scene graph, cloned per avatar with SkeletonUtils. */
export interface SkinnedPartModel {
  readonly kind: 'skinned'
  readonly scene: Object3D
  readonly triangles: number
}

/** The shared avatar rig: only its clips are used (the parts carry the same joints). */
export interface RigModel {
  readonly kind: 'rig'
  readonly clips: readonly AnimationClip[]
}

export type LoadedModel = StaticModel | SkinnedPartModel | RigModel

let loader: GLTFLoader | undefined

/** One loader per page: the meshopt decoder (a small WASM module) initialises once. */
export function gltfLoader(): GLTFLoader {
  loader ??= new GLTFLoader().setMeshoptDecoder(MeshoptDecoder)
  return loader
}

export const triangleCount = (geometry: BufferGeometry): number =>
  (geometry.index?.count ?? geometry.getAttribute('position').count) / 3

function meshesOf(root: Object3D): Mesh[] {
  const meshes: Mesh[] = []
  root.traverse((object) => {
    if (object instanceof Mesh) meshes.push(object)
  })
  return meshes
}

function disposeMaterials(meshes: readonly Mesh[]): void {
  for (const mesh of meshes) {
    const materials: Material[] = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    for (const material of materials) material.dispose()
  }
}

export function prepareGltf(gltf: GLTF, model: Pick<ModelRef, 'id' | 'kind'>): LoadedModel {
  if (model.kind === 'rig') {
    disposeMaterials(meshesOf(gltf.scene))
    return { kind: 'rig', clips: gltf.animations }
  }
  gltf.scene.updateMatrixWorld(true)
  const meshes = meshesOf(gltf.scene)
  disposeMaterials(meshes)
  if (model.kind === 'skinned') {
    if (!meshes.some((mesh) => mesh instanceof SkinnedMesh)) {
      throw new Error(`Model "${model.id}" has no skinned mesh`)
    }
    return {
      kind: 'skinned',
      scene: gltf.scene,
      triangles: meshes.reduce((sum, mesh) => sum + triangleCount(mesh.geometry), 0),
    }
  }
  // The asset build merges every static model into one mesh (scripts/assets/pipeline.ts).
  const [mesh, ...rest] = meshes
  if (mesh === undefined || rest.length > 0) {
    throw new Error(`Model "${model.id}" must hold exactly one mesh, found ${meshes.length}`)
  }
  return {
    kind: 'static',
    geometry: mesh.geometry,
    matrix: mesh.matrixWorld.clone(),
    triangles: triangleCount(mesh.geometry),
  }
}

/** Frees a model's GPU buffers (it leaves the LRU cache). */
export function disposeModel(model: LoadedModel): void {
  if (model.kind === 'static') model.geometry.dispose()
  else if (model.kind === 'skinned') {
    for (const mesh of meshesOf(model.scene)) mesh.geometry.dispose()
  }
}

/** Downloads, decodes and prepares one model file. */
export async function loadModel(model: ModelRef, file: string): Promise<LoadedModel> {
  return prepareGltf(await gltfLoader().loadAsync(file), model)
}
