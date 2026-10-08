'use client'

/**
 * The showcase's react-three-fiber canvas: grounds, instanced static models, the avatar lineup
 * or the catalog grid under one lighting preset, rendered on demand. Exposes
 * `window.__cloutcityTest.showcase` (test builds only) so screenshots wait until every model
 * has drawn.
 */
import { useEffect, useMemo, useRef } from 'react'
import { createDayNightUniforms, DayNightContext } from '@/scene/lighting/nightGlow'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { PCFShadowMap, type PerspectiveCamera } from 'three'
import { AvatarModel } from '@/scene/models/AvatarModel'
import { ModelInstances, type ModelPlacement } from '@/scene/models/ModelInstances'
import { modelCacheStats, ModelsProvider, useModels } from '@/scene/models/runtime'
import type { ModelRef } from '@/scene/models/types'
import type { ShowcaseStatus } from './ShowcaseClient'
import type { ShowcaseScene } from './types'

const LAY_FLAT_X = -Math.PI / 2

interface ShowcaseTestHook {
  readonly ready: boolean
  readonly view: string
  frames(): number
  pendingFrames(): number
  renderInfo(): { calls: number; triangles: number }
  cache(): { readonly held: number; readonly idle: number }
}

declare global {
  interface CloutcityTestHooks {
    showcase?: ShowcaseTestHook
  }
}

function useAspectLayout(): 'landscape' | 'portrait' {
  const size = useThree((state) => state.size)
  return size.width < size.height ? 'portrait' : 'landscape'
}

function CameraFraming({ scene }: { readonly scene: ShowcaseScene }) {
  const layout = useAspectLayout()
  const get = useThree((state) => state.get)
  const invalidate = useThree((state) => state.invalidate)
  useEffect(() => {
    const camera = get().camera as PerspectiveCamera
    const frame = scene.camera[layout]
    camera.fov = frame.fovDeg
    camera.position.set(...frame.position)
    camera.lookAt(...frame.target)
    camera.updateProjectionMatrix()
    invalidate()
  }, [get, layout, scene.camera, invalidate])
  return null
}

function Grounds({ scene, shadows }: { readonly scene: ShowcaseScene; readonly shadows: boolean }) {
  return scene.grounds.map((ground, index) => (
    <mesh
      key={index}
      receiveShadow={shadows}
      position={[...ground.center]}
      rotation={[LAY_FLAT_X, 0, 0]}
      raycast={() => {}}
    >
      <planeGeometry args={[ground.size[0], ground.size[1]]} />
      <meshLambertMaterial color={ground.color} />
    </mesh>
  ))
}

function Lineup({
  lineup,
  shadows,
}: {
  readonly lineup: NonNullable<ShowcaseScene['lineup']>
  readonly shadows: boolean
}) {
  const columns = lineup.columns[useAspectLayout()]
  return lineup.avatars.map((avatar, index) => {
    const row = Math.floor(index / columns)
    const inRow = Math.min(columns, lineup.avatars.length - row * columns)
    const column = index % columns
    // Back rows sit half a step over, so every face shows between the row in front.
    const x = (column - (inRow - 1) / 2 + (row % 2) * 0.5) * lineup.spacingM
    return (
      <group key={index} position={[x, 0, -row * lineup.rowDepthM]}>
        <AvatarModel
          parts={{ rig: lineup.rig, head: avatar.head, body: avatar.body }}
          colors={avatar.colors}
          clip={lineup.clip}
          animate={false}
          shadows={shadows}
          name={`showcase-avatar-${index}`}
        />
      </group>
    )
  })
}

function Grid({
  grid,
  shadows,
}: {
  readonly grid: NonNullable<ShowcaseScene['grid']>
  readonly shadows: boolean
}) {
  const columns = grid.columns[useAspectLayout()]
  const rows = Math.ceil(grid.models.length / columns)
  return grid.models.map((model, index) => {
    const bounds = model.bounds
    if (bounds === undefined) return null
    const size = Math.max(...bounds.max.map((max, axis) => max - (bounds.min[axis] ?? 0)))
    // Every model fills most of its cell, so a hydrant reads as clearly as a building.
    const scale = (grid.cellM * 0.6) / size
    const column = index % columns
    const row = Math.floor(index / columns)
    const placement: ModelPlacement = {
      position: [
        (column - (columns - 1) / 2) * grid.cellM - ((bounds.min[0] + bounds.max[0]) / 2) * scale,
        0,
        (row - (rows - 1) / 2) * grid.cellM - ((bounds.min[2] + bounds.max[2]) / 2) * scale,
      ],
      scale,
    }
    return (
      <ModelInstances
        key={model.id}
        model={model}
        placements={[placement]}
        name={model.id}
        shadows={shadows}
      />
    )
  })
}

function allRefs(scene: ShowcaseScene): ModelRef[] {
  const refs = new Map<string, ModelRef>()
  for (const group of scene.groups) refs.set(group.model.id, group.model)
  if (scene.lineup) {
    refs.set(scene.lineup.rig.id, scene.lineup.rig)
    for (const avatar of scene.lineup.avatars) {
      refs.set(avatar.head.id, avatar.head)
      refs.set(avatar.body.id, avatar.body)
    }
  }
  for (const model of scene.grid?.models ?? []) refs.set(model.id, model)
  return [...refs.values()]
}

function Readiness({
  scene,
  onStatus,
}: {
  readonly scene: ShowcaseScene
  readonly onStatus: (status: ShowcaseStatus) => void
}) {
  const refs = useMemo(() => allRefs(scene), [scene])
  const state = useModels(refs)
  const gl = useThree((s) => s.gl)
  const get = useThree((s) => s.get)
  const invalidate = useThree((s) => s.invalidate)
  const settled = useRef(0)
  const ready = useRef(false)

  useEffect(() => {
    if (state.status === 'error') onStatus('error')
    if (state.status === 'ready') invalidate()
  }, [state.status, onStatus, invalidate])

  // Ready two frames after every model resolved: the first draws them, the second confirms.
  useFrame(() => {
    if (state.status !== 'ready' || ready.current) return
    settled.current += 1
    if (settled.current < 2) {
      invalidate()
      return
    }
    ready.current = true
    onStatus('ready')
  })

  useEffect(() => {
    if (process.env.NEXT_PUBLIC_TEST_HOOKS !== '1') return
    const hook: ShowcaseTestHook = {
      get ready() {
        return ready.current
      },
      view: `${scene.view}/${scene.time}/${scene.tier}`,
      frames: () => gl.info.render.frame,
      pendingFrames: () => get().internal.frames,
      renderInfo: () => ({ calls: gl.info.render.calls, triangles: gl.info.render.triangles }),
      cache: modelCacheStats,
    }
    window.__cloutcityTest = { ...window.__cloutcityTest, showcase: hook }
    return () => {
      delete window.__cloutcityTest?.showcase
    }
  }, [gl, get, scene])
  return null
}

export default function ShowcaseCanvas({
  scene,
  onStatus,
}: {
  readonly scene: ShowcaseScene
  readonly onStatus: (status: ShowcaseStatus) => void
}) {
  const { light } = scene
  // The showcase keeps its own lighting presets but drives the real night-glow uniform (S04f)
  // the day/night rig writes on the map: 1 at night, 0 otherwise.
  const dayNight = useMemo(() => {
    const uniforms = createDayNightUniforms()
    uniforms.uNightGlow.value = scene.nightGlow
    return uniforms
  }, [scene.nightGlow])
  // perf.json `shadows`: only the high tier draws the sun's one directional shadow map.
  const shadows = scene.tier === 'high'
  const { extentM, mapSizePx, bias, normalBias } = light.shadow
  return (
    <div className="absolute inset-0" data-cc-feature="cc-feature:model-showcase">
      <Canvas
        frameloop="demand"
        dpr={[1, 2]}
        flat
        shadows={{ enabled: shadows, type: PCFShadowMap }}
        gl={{ antialias: true, alpha: false, stencil: false }}
        camera={{ near: 0.1, far: 500 }}
      >
        <color attach="background" args={[light.sky]} />
        <ambientLight color={light.ambient.color} intensity={light.ambient.intensity} />
        <hemisphereLight
          args={[light.hemisphere.sky, light.hemisphere.ground, light.hemisphere.intensity]}
        />
        <directionalLight
          color={light.sun.color}
          intensity={light.sun.intensity}
          position={[...light.sun.position]}
          castShadow={shadows}
          shadow-mapSize={[mapSizePx, mapSizePx]}
          shadow-camera-left={-extentM}
          shadow-camera-right={extentM}
          shadow-camera-top={extentM}
          shadow-camera-bottom={-extentM}
          shadow-camera-far={extentM * 4}
          shadow-bias={bias}
          shadow-normalBias={normalBias}
        />
        <CameraFraming scene={scene} />
        <DayNightContext value={dayNight}>
          <ModelsProvider config={scene.models} tier={scene.tier}>
            <Grounds scene={scene} shadows={shadows} />
            {scene.groups.map((group) => (
              <ModelInstances
                key={`${group.model.id}|${JSON.stringify(group.colors ?? {})}`}
                model={group.model}
                placements={group.placements}
                {...(group.colors && { colors: group.colors })}
                name={group.model.id}
                shadows={shadows}
              />
            ))}
            {scene.lineup && <Lineup lineup={scene.lineup} shadows={shadows} />}
            {scene.grid && <Grid grid={scene.grid} shadows={shadows} />}
            <Readiness scene={scene} onStatus={onStatus} />
          </ModelsProvider>
        </DayNightContext>
      </Canvas>
    </div>
  )
}
