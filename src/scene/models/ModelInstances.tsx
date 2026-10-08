'use client'

/**
 * Every placement of one static model as a single InstancedMesh: one draw call however many
 * taxis, streetlights or walk-ups (CLAUDE.md: instancing for repeats). The geometry comes from
 * the shared cache; a slot recolour makes one variant geometry for the whole group. Draws
 * nothing until the model arrives, then requests one frame (demand frameloop).
 */
import { useEffect, useMemo } from 'react'
import { useThree } from '@react-three/fiber'
import { Euler, InstancedMesh, Matrix4, Quaternion, Vector3, type Object3D } from 'three'
import { disposeRecolored, recolorGeometry, slotColorsKey, type SlotColors } from './slots'
import { useModels, useModelsContext } from './runtime'
import type { ModelRef } from './types'

export interface ModelPlacement {
  readonly position: readonly [number, number, number]
  /** Heading in radians about +y. */
  readonly rotationY?: number
  readonly scale?: number
}

const noRaycast: Object3D['raycast'] = () => {}

/** placement × the model's own node transform, per instance. */
export function placementMatrix(placement: ModelPlacement, model: Matrix4, out: Matrix4): Matrix4 {
  const [x, y, z] = placement.position
  const scale = placement.scale ?? 1
  out.compose(
    new Vector3(x, y, z),
    new Quaternion().setFromEuler(new Euler(0, placement.rotationY ?? 0, 0)),
    new Vector3(scale, scale, scale),
  )
  return out.multiply(model)
}

export function ModelInstances({
  model,
  placements,
  colors,
  name,
  shadows = false,
}: {
  readonly model: ModelRef
  readonly placements: readonly ModelPlacement[]
  readonly colors?: SlotColors
  /** Object name, for the showcase hook and debugging. */
  readonly name?: string
  /** Casts and receives the sun's shadow (the high tier's one directional shadow map). */
  readonly shadows?: boolean
}) {
  const { material } = useModelsContext()
  const invalidate = useThree((state) => state.invalidate)
  const state = useModels([model])
  const loaded = state.status === 'ready' ? state.models[0] : undefined
  if (model.kind !== 'static') throw new Error(`ModelInstances needs a static model: ${model.id}`)
  // Callers often build `colors` inline; the variant is rebuilt only when the colours change.
  const colorsKey = slotColorsKey(colors)

  const mesh = useMemo(() => {
    if (loaded?.kind !== 'static' || placements.length === 0) return null
    const geometry = recolorGeometry(loaded.geometry, model.slots, colors)
    const instanced = new InstancedMesh(geometry, material, placements.length)
    const matrix = new Matrix4()
    placements.forEach((placement, index) =>
      instanced.setMatrixAt(index, placementMatrix(placement, loaded.matrix, matrix)),
    )
    instanced.instanceMatrix.needsUpdate = true
    instanced.computeBoundingSphere()
    instanced.raycast = noRaycast
    instanced.castShadow = shadows
    instanced.receiveShadow = shadows
    if (name !== undefined) instanced.name = name
    return { instanced, dispose: () => disposeRecolored(loaded.geometry, geometry) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, placements, colorsKey, material, model.slots, name, shadows])

  useEffect(() => {
    if (mesh === null) return
    invalidate()
    return () => {
      mesh.dispose()
      mesh.instanced.dispose()
    }
  }, [mesh, invalidate])

  return mesh === null ? null : <primitive object={mesh.instanced} />
}
