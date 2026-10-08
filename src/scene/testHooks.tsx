'use client'

/**
 * Test-mode hook for the e2e suite: camera state and renderer counters on
 * `window.__cloutcityTest.scene`. Only builds with NEXT_PUBLIC_TEST_HOOKS=1 (inlined at build
 * time; the e2e build sets it and writes to its own distDir). In every other build the effect
 * body is dead code and is removed, so the hook never ships: `npm run budget` (shell-guard)
 * fails if `__cloutcityTest` reaches `.next`.
 */
import { useEffect, type RefObject } from 'react'
import { useThree } from '@react-three/fiber'
import { DirectionalLight, Mesh, PCFShadowMap, Vector3, type Object3D } from 'three'
import { lightingKey } from '@/lib/dayNight/lightingKey'
import type { KeyframeId, Lighting, UiTheme } from '@/lib/dayNight/types'
import type { QualityTier } from '@/lib/data/schemas/config'
import type { TierReason } from '@/lib/quality/tier'
import { qualityStore, selectActiveTier } from '@/state/quality'
import { MapControls } from 'three/addons/controls/MapControls.js'
import { PLAYER_AVATAR_NAME } from './avatar/buildAvatar'
import { radToDeg } from './camera/limits'
import type { BuildingsHandle, BuildingsState } from './buildings/Buildings'
import type { BoroughView, CityObjects } from './City'
import type { LandmarksHandle, LandmarksState } from './landmarks/Landmarks'
import type { PinKind, PinStyle } from './geo/schema'
import { nightGlowSource } from './lighting/nightGlow'
import { continuousSince } from './quality/continuity'
import { SUN_LIGHT_NAME } from './SunLight'
import type { SceneQuality } from './types'

interface Vec3 {
  readonly x: number
  readonly y: number
  readonly z: number
}

export interface SceneCameraState {
  readonly position: Vec3
  readonly target: Vec3
  readonly distance: number
  readonly polarDeg: number
  readonly azimuthDeg: number
  readonly near: number
  readonly far: number
}

/** The player's avatar (S05). */
export interface ScenePlayerState {
  /** Where it stands, in local metres (x east, y north). */
  readonly local: { readonly x: number; readonly y: number }
  /** The height of its feet (the land top). */
  readonly groundY: number
  /** Its current height in metres (it rescales with the camera distance). */
  readonly sizeM: number
  /** Its feet on screen, in CSS pixels from the viewport's top left. */
  readonly screen: { readonly x: number; readonly y: number }
  /** True once the hand-made avatar (S04h) has replaced the capsule placeholder. */
  readonly model: boolean
}

/** A pin as the test sees it: where to tap, in client (viewport) CSS pixels. */
export interface ScenePinState {
  readonly id: string
  readonly kind: PinKind
  readonly style: PinStyle
  readonly borough: string
  /** Absent when the pin is behind the camera or off the canvas. */
  readonly screen: { readonly x: number; readonly y: number } | null
}

/** The quality tier state (S04b). */
export interface SceneQualityState {
  /** The picker's tier for this device. */
  readonly auto: QualityTier | null
  readonly reasons: readonly TierReason[]
  /** The tier in use. */
  readonly active: QualityTier | null
  readonly override: QualityTier | null
  readonly dataSaver: boolean
  /** Runtime step-downs this session. */
  readonly steps: number
  /** Whether the step-down's continuous window is open (a gesture or flight under way). */
  readonly continuous: boolean
}

/** What the renderer is doing with the tier's settings (S04b). */
export interface SceneGlState {
  readonly pixelRatio: number
  /** The tier's DPR cap. */
  readonly dprCap: number
  /** Whether the WebGL context was created with antialiasing. */
  readonly antialias: boolean
  readonly shadowMap: {
    readonly enabled: boolean
    /** Any other shadow type (PCFSoft is never allowed) reads as `other`. */
    readonly type: 'PCFShadowMap' | 'other'
  }
  /** Whether the sun casts a shadow, and its shadow map size. */
  readonly sun: { readonly castShadow: boolean; readonly mapSizePx: number } | null
  /** Whether the outlines (the subway casing) are drawn. */
  readonly outlines: boolean
}

/** The day/night rig's current lighting (S04f). */
export interface SceneLightingState {
  /** Quantised minute of day the lighting is for. */
  readonly minute: number
  readonly mode: 'blend' | 'step'
  readonly keyframe: KeyframeId
  readonly next: KeyframeId
  /** Blend fraction towards `next` (0 during a hold and in step mode). */
  readonly t: number
  /** The shared `uNightGlow` uniform's value. */
  readonly nightGlow: number
  readonly ui: UiTheme
  /** The lighting key: the scene redraws only when it changes. */
  readonly key: string
  readonly sun: { readonly intensity: number; readonly shadowIntensity: number }
}

export interface SceneTestHook {
  /** True once a frame has drawn the city. */
  readonly ready: boolean
  /** Frames rendered so far (renderer.info.render.frame). */
  frames(): number
  /** Frames requested but not yet rendered (0 = idle: on-demand rendering has nothing to do). */
  pendingFrames(): number
  camera(): SceneCameraState | null
  /** Draw calls and triangles of the last rendered frame. */
  renderInfo(): { calls: number; triangles: number }
  /** The player's avatar, or null before it is in the scene. */
  player(): ScenePlayerState | null
  /** Every place pin (S04c), with its tap point for the current camera. */
  pins(): ScenePinState[]
  pinCount(): number
  /** Per-borough land style, pin count and chip (S04c, S07 render half). */
  boroughs(): BoroughView[]
  /** The place under the selection ring, or null. */
  selectedPlaceId(): string | null
  /** Loses / restores the WebGL context through WEBGL_lose_context; false if unsupported. */
  loseContext(): boolean
  restoreContext(): boolean
  quality(): SceneQualityState
  gl(): SceneGlState
  /**
   * District buildings and blocks (S04d): per-district load state, what the view draws, the
   * tier's density and distances, windows and the night glow; null before the layer exists.
   */
  buildings(): BuildingsState | null
  /** Modelled landmarks (S07a): build state, current level, triangles, screen points. */
  landmarks(): LandmarksState | null
  /** The day/night lighting (S04f). */
  lighting(): SceneLightingState
  /** Shader programs the renderer holds (renderer.info.programs). */
  programs(): number
  /**
   * Names of the meshes whose material carries the night glow (S04f), or of their nearest named
   * group, sorted. A memorial never appears; memorial pins share the pin meshes but their
   * per-instance glow is zero.
   */
  glowingMeshes(): string[]
}

declare global {
  interface Window {
    __cloutcityTest?: CloutcityTestHooks
  }
  /** One property per feature hook (merged with src/components/events/eventTestHook.ts). */
  interface CloutcityTestHooks {
    scene?: SceneTestHook
  }
}

const vec = (v: Vec3): Vec3 => ({ x: v.x, y: v.y, z: v.z })

export function TestHooks({
  readyRef,
  cityRef,
  buildingsRef,
  landmarksRef,
  quality,
  lighting,
}: {
  readonly readyRef: RefObject<boolean>
  readonly cityRef: RefObject<CityObjects | null>
  readonly buildingsRef: RefObject<BuildingsHandle | null>
  readonly landmarksRef: RefObject<LandmarksHandle | null>
  readonly quality: SceneQuality
  readonly lighting: Lighting
}) {
  const gl = useThree((state) => state.gl)
  const camera = useThree((state) => state.camera)
  const controls = useThree((state) => state.controls)
  const get = useThree((state) => state.get)
  const scene = useThree((state) => state.scene)

  useEffect(() => {
    if (process.env.NEXT_PUBLIC_TEST_HOOKS !== '1') return
    // Kept from the loss: a lost context returns null for getExtension.
    let loseExtension: WEBGL_lose_context | null = null
    const hook: SceneTestHook = {
      get ready() {
        return readyRef.current
      },
      frames: () => gl.info.render.frame,
      pendingFrames: () => get().internal.frames,
      camera: () => {
        if (!(controls instanceof MapControls)) return null
        return {
          position: vec(camera.position),
          target: vec(controls.target),
          distance: controls.getDistance(),
          polarDeg: radToDeg(controls.getPolarAngle()),
          azimuthDeg: radToDeg(controls.getAzimuthalAngle()),
          near: 'near' in camera ? camera.near : 0,
          far: 'far' in camera ? camera.far : 0,
        }
      },
      renderInfo: () => ({ calls: gl.info.render.calls, triangles: gl.info.render.triangles }),
      player: () => {
        const avatar = scene.getObjectByName(PLAYER_AVATAR_NAME)
        if (avatar === undefined) return null
        avatar.updateMatrixWorld(true)
        const feet = avatar.getWorldPosition(new Vector3())
        const ndc = feet.clone().project(camera)
        const rect = gl.domElement.getBoundingClientRect()
        const capsule = avatar.getObjectByName(`${PLAYER_AVATAR_NAME}-body`)
        return {
          model: capsule !== undefined && !capsule.visible,
          local: { x: feet.x, y: -feet.z },
          groundY: feet.y,
          sizeM: avatar.scale.y,
          screen: {
            x: rect.left + ((ndc.x + 1) / 2) * rect.width,
            y: rect.top + ((1 - ndc.y) / 2) * rect.height,
          },
        }
      },
      pins: () => {
        const city = cityRef.current
        if (city === null) return []
        const rect = gl.domElement.getBoundingClientRect()
        const onScreen = new Map(
          city.pins
            .screenPins(get().camera, rect.width, rect.height)
            .filter(
              (pin) => pin.x >= 0 && pin.y >= 0 && pin.x <= rect.width && pin.y <= rect.height,
            )
            .map((pin) => [pin.id, { x: pin.x + rect.left, y: pin.y + rect.top }]),
        )
        return city.pins.pins.map((pin) => ({
          id: pin.id,
          kind: pin.kind,
          style: pin.style,
          borough: pin.borough,
          screen: onScreen.get(pin.id) ?? null,
        }))
      },
      pinCount: () => cityRef.current?.pins.pins.length ?? 0,
      boroughs: () => [...(cityRef.current?.boroughs ?? [])],
      selectedPlaceId: () => cityRef.current?.pins.selectedId() ?? null,
      loseContext: () => {
        loseExtension ??= gl.getContext().getExtension('WEBGL_lose_context')
        loseExtension?.loseContext()
        return loseExtension !== null
      },
      restoreContext: () => {
        loseExtension?.restoreContext()
        return loseExtension !== null
      },
      quality: () => {
        const state = qualityStore.getState()
        return {
          auto: state.auto,
          reasons: [...state.autoReasons],
          active: selectActiveTier(state),
          override: state.override,
          dataSaver: state.dataSaver,
          steps: state.steps,
          continuous: continuousSince() !== null,
        }
      },
      gl: () => {
        const sun = scene.getObjectByName(SUN_LIGHT_NAME)
        const active = selectActiveTier(qualityStore.getState()) ?? 'low'
        return {
          pixelRatio: gl.getPixelRatio(),
          dprCap: quality.tiers[active].dprCap,
          antialias: gl.getContextAttributes()?.antialias === true,
          shadowMap: {
            enabled: gl.shadowMap.enabled,
            type: gl.shadowMap.type === PCFShadowMap ? 'PCFShadowMap' : 'other',
          },
          sun:
            sun instanceof DirectionalLight
              ? { castShadow: sun.castShadow, mapSizePx: sun.shadow.mapSize.x }
              : null,
          outlines: scene.getObjectByName('subway-casing')?.visible === true,
        }
      },
      buildings: () => buildingsRef.current?.state() ?? null,
      landmarks: () => landmarksRef.current?.state() ?? null,
      lighting: () => {
        const sun = scene.getObjectByName(SUN_LIGHT_NAME)
        return {
          minute: lighting.minute,
          mode: lighting.mode,
          keyframe: lighting.keyframe,
          next: lighting.next,
          t: lighting.t,
          nightGlow: lighting.nightGlow,
          ui: lighting.ui,
          key: lightingKey(lighting),
          sun:
            sun instanceof DirectionalLight
              ? { intensity: sun.intensity, shadowIntensity: sun.shadow.intensity }
              : { intensity: 0, shadowIntensity: 0 },
        }
      },
      programs: () => gl.info.programs?.length ?? 0,
      glowingMeshes: () => {
        const names = new Set<string>()
        scene.traverse((object) => {
          if (!(object instanceof Mesh)) return
          const materials = Array.isArray(object.material) ? object.material : [object.material]
          if (!materials.some((material) => nightGlowSource(material) !== undefined)) return
          // Kit-built landmark parts are unnamed: report the nearest named group (its id).
          let named: Object3D | null = object
          while (named !== null && named.name === '') named = named.parent
          names.add(named?.name ?? '')
        })
        return [...names].sort()
      },
    }
    window.__cloutcityTest = { ...window.__cloutcityTest, scene: hook }
    return () => {
      delete window.__cloutcityTest?.scene
    }
  }, [
    gl,
    camera,
    controls,
    get,
    scene,
    readyRef,
    cityRef,
    buildingsRef,
    landmarksRef,
    quality,
    lighting,
  ])

  return null
}
