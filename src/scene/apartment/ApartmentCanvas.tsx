'use client'

/**
 * The apartment's 3D chunk (S16; loaded with next/dynamic, ssr: false, from ApartmentMount): the
 * player's room as a low-poly toon cutaway with their decor, slot markers, static lighting and
 * per-tier shadows. Renders on demand only, so an idle room draws zero frames.
 *
 * - Picking reuses the map's tap rule and screen-space pick (src/scene/pins/tap.ts, pick.ts): a
 *   tap within `hitRadiusPx` (a target at least 44 px across) of a slot picks it; a tap close to
 *   several opens a chooser in the Home panel. Every 3D action has the panel's DOM path too.
 * - The camera keeps the home's data angle and backs off until the room fits the free scene row,
 *   which FreeRowFraming centres it in (the same framing as the map).
 * - Tiers (perf.json): low draws no shadows, mid draws blob shadows, high one directional
 *   PCFShadowMap (the object form: R3F's `shadows` boolean means PCFSoft, deprecated in r182).
 */
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { PCFShadowMap, PerspectiveCamera } from 'three'
import type { QualityTier } from '@/lib/data/schemas/config'
import { log } from '@/lib/log'
import { FreeRowFraming } from '../camera/FreeRowFraming'
import { pickPin } from '../pins/pick'
import { attachTapDetector } from '../pins/tap'
import { FREE_SCENE_ROW_SELECTOR } from '../types'
import { ApartmentTestHook } from './apartmentTestHook'
import { buildApartment, type ApartmentObjects, type SlotFill } from './buildApartment'
import { roomBounds } from './buildRoom'
import {
  apartmentConfig,
  dayNightConfig,
  dayNightModel,
  roomInterior,
  roomPalette,
  tapOptions,
  tierBudget,
  tokenHex,
  toonRamp,
  type RoomInterior,
} from './data'
import { boundingSphere, cameraPosition, fitDistance, type Sphere } from './fit'
import { lightingAt } from './lighting'
import type { DecorModels } from './decorModels'
import { useReducedMotion } from '@/lib/useReducedMotion'
import { createPlaceholderVisuals } from './visuals'
import type { ApartmentViewProps, SlotTap } from './types'

const GL = {
  antialias: true,
  alpha: false,
  stencil: false,
  powerPreference: 'high-performance',
} as const

/** Near and far planes around the fitted room, so depth precision is spent on the room. */
const NEAR_M = 0.05

function roomSphere(interior: RoomInterior): Sphere {
  const bounds = roomBounds(interior, apartmentConfig)
  return boundingSphere(bounds.min, bounds.max)
}

/** Fits the camera to the room in the free scene row, again on every resize. */
function RoomCamera({ interior }: { readonly interior: RoomInterior }) {
  // Only a dependency: the camera is mutated through the store's own reference (three's model).
  const camera = useThree((state) => state.camera)
  const gl = useThree((state) => state.gl)
  const get = useThree((state) => state.get)
  const invalidate = useThree((state) => state.invalidate)

  useEffect(() => {
    const { camera } = get()
    if (!(camera instanceof PerspectiveCamera)) return
    const canvas = gl.domElement
    const row = document.querySelector<HTMLElement>(FREE_SCENE_ROW_SELECTOR)
    const sphere = roomSphere(interior)
    const apply = () => {
      const rect = canvas.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return
      const distance = fitDistance(sphere, {
        fovDeg: interior.camera.fovDeg,
        width: rect.width,
        height: rect.height,
        rowHeight: row?.getBoundingClientRect().height ?? rect.height,
        margin: apartmentConfig.fitMargin,
      })
      camera.fov = interior.camera.fovDeg
      camera.near = NEAR_M
      camera.far = distance + sphere.radius * 2
      camera.position.set(
        ...cameraPosition(
          sphere.center,
          interior.camera.position,
          interior.camera.target,
          distance,
        ),
      )
      camera.lookAt(...sphere.center)
      camera.updateProjectionMatrix()
      invalidate()
    }
    apply()
    const observer = new ResizeObserver(apply)
    observer.observe(canvas)
    if (row !== null) observer.observe(row)
    return () => observer.disconnect()
  }, [camera, gl, get, interior, invalidate])

  return null
}

function RoomLights({
  interior,
  minute,
  tier,
}: {
  readonly interior: RoomInterior
  readonly minute: number
  readonly tier: QualityTier
}) {
  const step = useReducedMotion()
  const lighting = lightingAt(minute, {
    model: dayNightModel,
    room: dayNightConfig.room,
    lights: apartmentConfig.lights,
    palette: roomPalette,
    step,
  })
  const sphere = roomSphere(interior)
  const { direction } = lighting.sun
  const length = Math.hypot(direction.x, direction.y, direction.z)
  const reach = sphere.radius * 2
  const at = (axis: number) => (axis / length) * reach
  const size = apartmentConfig.lights.shadowMapSizePx
  return (
    <>
      <ambientLight color={lighting.ambient.color} intensity={lighting.ambient.intensity} />
      <directionalLight
        color={lighting.sun.color}
        intensity={lighting.sun.intensity}
        position={[at(direction.x), at(direction.y), at(direction.z)]}
        castShadow={tierBudget(tier).shadows === 'pcf-directional'}
        shadow-mapSize={[size, size]}
        shadow-camera-left={-sphere.radius}
        shadow-camera-right={sphere.radius}
        shadow-camera-top={sphere.radius}
        shadow-camera-bottom={-sphere.radius}
        shadow-camera-near={0.1}
        shadow-camera-far={reach * 2}
      />
    </>
  )
}

interface RoomProps extends Pick<
  ApartmentViewProps,
  'placed' | 'heldKind' | 'selectedSlotId' | 'onSlotTap'
> {
  readonly interior: RoomInterior
  readonly tier: QualityTier
  readonly objectsRef: RefObject<ApartmentObjects | null>
  readonly readyRef: RefObject<boolean>
}

/**
 * The decor models at `tier`, loaded in their own lazy chunk (decorModels.ts) after the room is
 * up; null until then, and for good if they fail (the stand-ins stay: an expected condition, e.g.
 * offline, so it logs at info).
 */
function useDecorModels(tier: QualityTier): DecorModels | null {
  const [decor, setDecor] = useState<{ tier: QualityTier; models: DecorModels } | null>(null)
  useEffect(() => {
    let active = true
    let loaded: DecorModels | null = null
    import('./decorModels')
      .then((module) => module.loadDecorModels(tier))
      .then(
        (models) => {
          if (!active) {
            models.dispose()
            return
          }
          loaded = models
          setDecor({ tier, models })
        },
        (error: unknown) => {
          log.info('apartment decor models failed to load', {
            error: error instanceof Error ? error.message : String(error),
          })
        },
      )
    return () => {
      active = false
      loaded?.dispose()
    }
  }, [tier])
  return decor !== null && decor.tier === tier ? decor.models : null
}

function Room({
  interior,
  placed,
  heldKind,
  selectedSlotId,
  onSlotTap,
  tier,
  objectsRef,
  readyRef,
}: RoomProps) {
  const gl = useThree((state) => state.gl)
  const get = useThree((state) => state.get)
  const invalidate = useThree((state) => state.invalidate)
  const decor = useDecorModels(tier)
  const built = useMemo(() => {
    // The code-built stand-ins draw at once; the hand-made decor models (S04h) take over the
    // items scene.json `models.decor` maps once they have loaded.
    const placeholder = createPlaceholderVisuals(apartmentConfig, roomPalette, toonRamp)
    const visuals = decor === null ? placeholder : decor.visuals(placeholder)
    const objects = buildApartment(interior, apartmentConfig, roomPalette, visuals)
    return {
      ...objects,
      dispose() {
        objects.dispose()
        visuals.dispose()
      },
    }
  }, [interior, decor])
  const onTap = useRef(onSlotTap)

  useEffect(() => {
    onTap.current = onSlotTap
  }, [onSlotTap])

  useEffect(() => {
    objectsRef.current = built
    return () => {
      objectsRef.current = null
      built.dispose()
    }
  }, [built, objectsRef])

  const fills = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(placed).map(([slotId, entry]): [string, SlotFill] => [
          slotId,
          { itemId: entry.itemId, color: tokenHex(entry.token) },
        ]),
      ),
    [placed],
  )
  useEffect(() => {
    built.setPlaced(fills)
    invalidate()
  }, [built, fills, invalidate])
  useEffect(() => {
    built.setMarkers({ heldKind, selectedSlotId })
    invalidate()
  }, [built, heldKind, selectedSlotId, invalidate])
  useEffect(() => {
    built.setTier(tier)
    invalidate()
  }, [built, tier, invalidate])

  useEffect(() => {
    const canvas = gl.domElement
    return attachTapDetector(canvas, tapOptions, (clientX, clientY) => {
      const rect = canvas.getBoundingClientRect()
      const picked = pickPin(
        built.screenSlots(get().camera, rect.width, rect.height),
        { x: clientX - rect.left, y: clientY - rect.top },
        apartmentConfig,
      )
      const tap: SlotTap | null =
        picked.kind === 'one'
          ? { kind: 'one', slotId: picked.id }
          : picked.kind === 'many'
            ? { kind: 'many', slotIds: picked.ids }
            : null
      if (tap !== null) onTap.current(tap)
    })
  }, [gl, get, built])

  useFrame(() => {
    readyRef.current = true
  })

  return <primitive object={built.group} />
}

export default function ApartmentCanvas({
  home,
  placed,
  heldKind,
  selectedSlotId,
  label,
  minute,
  tier: deviceTier,
  onSlotTap,
}: ApartmentViewProps) {
  // The e2e hook can switch tiers to measure each one's budget; the device's tier otherwise.
  const [tierOverride, setTierOverride] = useState<QualityTier | null>(null)
  const tier = tierOverride ?? deviceTier
  const budget = tierBudget(tier)
  const interior = roomInterior(home)
  const objectsRef = useRef<ApartmentObjects | null>(null)
  const readyRef = useRef(false)

  return (
    <div
      role="img"
      aria-label={label}
      data-cc-feature="cc-feature:apartment-scene"
      data-apartment-home={home}
      className="absolute inset-0"
    >
      <Canvas
        frameloop="demand"
        dpr={[1, budget.dprCap]}
        flat
        // R3F applies a changed input again (compared shallowly), so a tier switch toggles the
        // shadow map; the light's castShadow changes with it, which recompiles the materials.
        shadows={{ enabled: budget.shadows === 'pcf-directional', type: PCFShadowMap }}
        gl={GL}
        camera={{ fov: interior.camera.fovDeg, near: NEAR_M, far: 100 }}
      >
        <color attach="background" args={[roomPalette.background]} />
        <RoomLights interior={interior} minute={minute} tier={tier} />
        <RoomCamera interior={interior} />
        <FreeRowFraming />
        <Room
          interior={interior}
          placed={placed}
          heldKind={heldKind}
          selectedSlotId={selectedSlotId}
          onSlotTap={onSlotTap}
          tier={tier}
          objectsRef={objectsRef}
          readyRef={readyRef}
        />
        <ApartmentTestHook
          home={home}
          tier={tier}
          placed={placed}
          setTier={setTierOverride}
          objectsRef={objectsRef}
          readyRef={readyRef}
        />
      </Canvas>
    </div>
  )
}
