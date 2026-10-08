'use client'

/**
 * 3D-3: frees the shader programs a shadow change leaves behind. Turning the shadow map on or
 * off (or resizing it) changes every lit material's program key, and three r182 keeps each
 * material's earlier programs alive until that material is disposed, so a step-down between
 * high and mid used to leave the old high-tier programs compiled next to the new ones (mid
 * reached 21 against programsMax 11). Before the first frame of the new setting, every material
 * in the scene is disposed once: its programs are released, and three re-initialises the same
 * material object (uniforms, textures and onBeforeCompile patches are untouched) on its next
 * render, compiling only the program it now needs.
 *
 * three's shadow pass draws casters with its own internal depth material, which is not in the
 * scene and is never disposed, so its programs (one per variant: plain, instanced) would outlive
 * the shadow map. While shadows are on, the first caster to render into the shadow map reports
 * that material through `onBeforeShadow` (the public per-object hook); it is disposed with the
 * rest when the setting changes.
 */
import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Object3D, type Material } from 'three'

/** Every material reachable from `root`, once each, depth and distance overrides included. */
export function sceneMaterials(root: Object3D): Set<Material> {
  const materials = new Set<Material>()
  const add = (value: unknown) => {
    if (Array.isArray(value)) for (const entry of value) add(entry)
    else if (value !== null && typeof value === 'object' && 'isMaterial' in value) {
      materials.add(value as Material)
    }
  }
  root.traverse((object) => {
    add((object as { material?: unknown }).material)
    add(object.customDepthMaterial)
    add(object.customDistanceMaterial)
  })
  return materials
}

/** Releases the programs of every material under `root`; returns how many were disposed. */
export function releaseScenePrograms(root: Object3D): number {
  const materials = sceneMaterials(root)
  for (const material of materials) material.dispose()
  return materials.size
}

const defaultOnBeforeShadow = Object3D.prototype.onBeforeShadow

/**
 * Hooks the shadow casters under `root` (those still on three's default `onBeforeShadow`) so
 * the depth material each is drawn with is added to `seen`. Returns whether any caster exists.
 */
export function watchShadowDepth(root: Object3D, seen: Set<Material>): boolean {
  let casters = false
  root.traverse((object) => {
    if (!object.castShadow) return
    casters = true
    if (object.onBeforeShadow !== defaultOnBeforeShadow) return
    object.onBeforeShadow = (_renderer, _object, _camera, _shadowCamera, _geometry, depth) => {
      seen.add(depth)
    }
  })
  return casters
}

/** Mount inside the canvas; `shadowKey` changes whenever the shadow map setting does. */
export function ReleaseProgramsOnShadowChange({
  shadowKey,
  shadowsOn,
}: {
  readonly shadowKey: string
  readonly shadowsOn: boolean
}) {
  const scene = useThree((state) => state.scene)
  const invalidate = useThree((state) => state.invalidate)
  const previous = useRef(shadowKey)
  const depthMaterials = useRef(new Set<Material>())

  // Until a caster has reported the shadow pass's depth material, hook the casters present.
  useFrame(() => {
    if (!shadowsOn || depthMaterials.current.size > 0) return
    watchShadowDepth(scene, depthMaterials.current)
  })

  useEffect(() => {
    if (previous.current === shadowKey) return
    previous.current = shadowKey
    releaseScenePrograms(scene)
    for (const material of depthMaterials.current) material.dispose()
    depthMaterials.current.clear()
    invalidate()
  }, [scene, shadowKey, invalidate])

  return null
}
