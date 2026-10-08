'use client'

/**
 * Test-mode hook for the e2e suite (S16): the apartment's slots on screen, renderer counters,
 * the tier and its budgets on `window.__cloutcityTest.apartment`. Only builds with
 * NEXT_PUBLIC_TEST_HOOKS=1 (inlined at build time); in every other build the effect body is dead
 * code and is removed, so the hook never ships (scripts/shell-guard.ts checks `.next`).
 */
import { useEffect, type RefObject } from 'react'
import { useThree } from '@react-three/fiber'
import { Mesh, PCFShadowMap, type BufferGeometry } from 'three'
import type { QualityTier } from '@/lib/data/schemas/config'
import type { ApartmentObjects } from './buildApartment'
import { avatarReserve, tierBudget } from './data'
import type { ApartmentPlacement } from './types'

export interface ApartmentSlotState {
  readonly id: string
  readonly kind: string
  /** The decor item placed there, or null. */
  readonly itemId: string | null
  /** The tap point in client (viewport) CSS pixels; null when behind the camera or off the canvas. */
  readonly screen: { readonly x: number; readonly y: number } | null
}

export interface ApartmentTestHook {
  /** True once a frame has drawn the room. */
  readonly ready: boolean
  home(): string
  tier(): QualityTier
  /** Switches the room to another quality tier (budget checks). */
  setTier(tier: QualityTier): void
  /** Frames rendered so far. */
  frames(): number
  /** Frames requested but not yet rendered (0 = idle). */
  pendingFrames(): number
  /**
   * Draw calls and triangles of the last rendered frame's main pass, whether the renderer draws a
   * shadow map and of which type, and the shadow pass's draw calls and triangles. three counts
   * only the main pass (it resets `info` after rendering the shadow map), so the shadow pass is
   * counted here from the casters: one draw per material group of every visible caster.
   */
  renderInfo(): {
    calls: number
    triangles: number
    shadowMap: boolean
    pcf: boolean
    shadowCalls: number
    shadowTriangles: number
  }
  /** The current tier's caps (perf.json `apartment`) and the reserve kept for S16a's avatar. */
  budget(): {
    drawCallsMax: number
    trianglesMax: number
    avatarReserve: { drawCalls: number; triangles: number }
  }
  slots(): ApartmentSlotState[]
  /** One slot's tap point in client CSS pixels, or null. */
  slotScreen(slotId: string): { x: number; y: number } | null
}

declare global {
  interface CloutcityTestHooks {
    apartment?: ApartmentTestHook
  }
}

export function ApartmentTestHook({
  home,
  tier,
  placed,
  setTier,
  objectsRef,
  readyRef,
}: {
  readonly home: string
  readonly tier: QualityTier
  readonly placed: Readonly<Record<string, ApartmentPlacement>>
  readonly setTier: (tier: QualityTier) => void
  readonly objectsRef: RefObject<ApartmentObjects | null>
  readonly readyRef: RefObject<boolean>
}) {
  const gl = useThree((state) => state.gl)
  const get = useThree((state) => state.get)

  useEffect(() => {
    if (process.env.NEXT_PUBLIC_TEST_HOOKS !== '1') return
    const slots = (): ApartmentSlotState[] => {
      const objects = objectsRef.current
      if (objects === null) return []
      const rect = gl.domElement.getBoundingClientRect()
      const onScreen = new Map(
        objects
          .screenSlots(get().camera, rect.width, rect.height)
          .filter(
            (slot) => slot.x >= 0 && slot.y >= 0 && slot.x <= rect.width && slot.y <= rect.height,
          )
          .map((slot) => [slot.id, { x: slot.x + rect.left, y: slot.y + rect.top }]),
      )
      return objects.slots.map((slot) => ({
        id: slot.id,
        kind: slot.kind,
        itemId: placed[slot.id]?.itemId ?? null,
        screen: onScreen.get(slot.id) ?? null,
      }))
    }
    const shadowPass = () => {
      let shadowCalls = 0
      let shadowTriangles = 0
      if (gl.shadowMap.enabled) {
        get().scene.traverseVisible((object) => {
          if (!(object instanceof Mesh) || !object.castShadow) return
          const geometry = object.geometry as BufferGeometry
          shadowCalls += Math.max(1, geometry.groups.length)
          shadowTriangles += (geometry.index?.count ?? geometry.getAttribute('position').count) / 3
        })
      }
      return { shadowCalls, shadowTriangles }
    }
    const hook: ApartmentTestHook = {
      get ready() {
        return readyRef.current
      },
      home: () => home,
      tier: () => tier,
      setTier,
      frames: () => gl.info.render.frame,
      pendingFrames: () => get().internal.frames,
      renderInfo: () => ({
        calls: gl.info.render.calls,
        triangles: gl.info.render.triangles,
        shadowMap: gl.shadowMap.enabled,
        pcf: gl.shadowMap.type === PCFShadowMap,
        ...shadowPass(),
      }),
      budget: () => {
        const { drawCallsMax, trianglesMax } = tierBudget(tier)
        return { drawCallsMax, trianglesMax, avatarReserve: { ...avatarReserve } }
      },
      slots,
      slotScreen: (slotId) => slots().find((slot) => slot.id === slotId)?.screen ?? null,
    }
    window.__cloutcityTest = { ...window.__cloutcityTest, apartment: hook }
    return () => {
      delete window.__cloutcityTest?.apartment
    }
  }, [gl, get, home, tier, placed, setTier, objectsRef, readyRef])

  return null
}
