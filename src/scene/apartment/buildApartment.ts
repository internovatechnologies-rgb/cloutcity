/**
 * The apartment's scene graph (S16), built imperatively once per home like the city
 * (src/scene/City.tsx) and updated in place. What things look like comes through the visuals seam
 * (visuals.ts, DEC-24); this module owns only where they go:
 * - the room shell for the home and tier;
 * - one decor object per filled slot, turned and moved to its slot;
 * - every slot marker in one InstancedMesh (one draw call), coloured and sized per slot: idle,
 *   a slot the held item fits, the selected slot; a filled slot's marker hides unless the held
 *   item could replace it;
 * - the mid tier's blob shadows under floor and surface decor in one InstancedMesh.
 *
 * Renders state only: what sits where comes from the save through props, and picking happens
 * in screen space (src/scene/pins/pick.ts) from `screenSlots`.
 */
import {
  CircleGeometry,
  Color,
  Group,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  Object3D,
  Quaternion,
  RingGeometry,
  Vector3,
  type Camera,
  type Material,
} from 'three'
import type { QualityTier } from '@/lib/data/schemas/config'
import type { DecorFit } from '@/engine/itemCatalog'
import type { ScreenPin } from '../pins/pick'
import type { ApartmentConfig, RoomInterior, RoomPalette, RoomSlot } from './data'
import type { ApartmentVisuals, DecorVisual, RoomVisual } from './visuals'

/** What sits in a slot: the decor item and its colour variant's hex. */
export interface SlotFill {
  readonly itemId: string
  readonly color: string
}

export interface MarkerState {
  /** The kind of slot the held item fits, or null when nothing is held. */
  readonly heldKind: DecorFit | null
  readonly selectedSlotId: string | null
}

export interface ApartmentObjects {
  readonly group: Group
  readonly slots: readonly RoomSlot[]
  /** Shows exactly `placed` (slot id → fill); unknown items draw nothing. */
  setPlaced(placed: Readonly<Record<string, SlotFill>>): void
  setMarkers(state: MarkerState): void
  /** Blob shadows on the mid tier, cast shadows on the high tier. */
  setTier(tier: QualityTier): void
  /** Each slot's tap point on screen, in CSS pixels from the canvas's top left. */
  screenSlots(camera: Camera, width: number, height: number): ScreenPin[]
  dispose(): void
}

const noRaycast: Object3D['raycast'] = () => {}
const UP = new Vector3(0, 1, 0)
const FLAT = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2)

/** The slot's outward normal: into the room for a wall slot, up otherwise. */
function slotNormal(slot: RoomSlot): Vector3 {
  if (slot.kind !== 'wall') return UP.clone()
  return new Vector3(0, 0, 1).applyAxisAngle(UP, (slot.rotationDeg * Math.PI) / 180)
}

/** Where a tap aims for a slot: the slot point, nudged off its wall or floor. */
export function tapPoint(slot: RoomSlot, liftM: number): Vector3 {
  return new Vector3(...slot.position).addScaledVector(slotNormal(slot), liftM)
}

function slotTransform(slot: RoomSlot, liftM: number, scale: number, target: Matrix4): Matrix4 {
  const turn = new Quaternion().setFromAxisAngle(UP, (slot.rotationDeg * Math.PI) / 180)
  const rotation = slot.kind === 'wall' ? turn : turn.multiply(FLAT)
  return target.compose(tapPoint(slot, liftM), rotation, new Vector3(scale, scale, scale))
}

interface PlacedDecor {
  readonly fill: SlotFill
  readonly visual: DecorVisual
}

/**
 * Builds the room for `interior` with `visuals` (which the caller owns and disposes); markers and
 * blob shadows take their colours from `palette`.
 */
export function buildApartment(
  interior: RoomInterior,
  config: ApartmentConfig,
  palette: Pick<RoomPalette, 'marker' | 'markerActive' | 'markerSelected' | 'blob'>,
  visuals: ApartmentVisuals,
): ApartmentObjects {
  const group = new Group()
  group.name = 'apartment'
  let tier: QualityTier = 'mid'
  let room: RoomVisual = visuals.buildRoom(interior, tier)
  group.add(room.object)

  const { slots } = interior
  const marker = config.marker
  const markers = new InstancedMesh(
    new RingGeometry(marker.radiusM * 0.55, marker.radiusM, marker.segments),
    // Always on top: a marker under a placed item or behind a culled wall still shows.
    new MeshBasicMaterial({ depthTest: false, depthWrite: false }),
    slots.length,
  )
  markers.name = 'apartment-slot-markers'
  markers.renderOrder = 10
  markers.frustumCulled = false
  group.add(markers)

  const blobs = new InstancedMesh(
    new CircleGeometry(config.blob.radiusM, 16),
    new MeshBasicMaterial({
      color: palette.blob,
      transparent: true,
      opacity: config.blob.opacity,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    }),
    slots.length,
  )
  blobs.name = 'apartment-blob-shadows'
  blobs.frustumCulled = false
  group.add(blobs)

  for (const object of [group, markers, blobs]) object.raycast = noRaycast

  const placedBySlot = new Map<string, PlacedDecor>()
  let markerState: MarkerState = { heldKind: null, selectedSlotId: null }
  const scratch = new Matrix4()
  const markerColors = {
    idle: new Color(palette.marker),
    active: new Color(palette.markerActive),
    selected: new Color(palette.markerSelected),
  }

  const layoutBlobs = () => {
    slots.forEach((slot, i) => {
      const placed = placedBySlot.get(slot.id)
      const footprint = placed?.visual.footprintM
      const scale =
        tier === 'mid' && slot.kind !== 'wall' && footprint !== undefined
          ? footprint / config.blob.radiusM
          : 0
      // Blobs lie on whatever the item stands on: the floor or the surface top.
      const at = { ...slot, kind: 'floor' as const }
      blobs.setMatrixAt(i, slotTransform(at, config.blob.liftM, scale, scratch))
    })
    blobs.instanceMatrix.needsUpdate = true
    blobs.visible = tier === 'mid'
  }

  const layoutMarkers = () => {
    const { heldKind, selectedSlotId } = markerState
    slots.forEach((slot, i) => {
      const filled = placedBySlot.has(slot.id)
      const fits = heldKind === slot.kind
      const selected = slot.id === selectedSlotId
      const visible = selected || fits || !filled
      const scale = !visible ? 0 : selected || fits ? marker.selectedScale : 1
      markers.setMatrixAt(i, slotTransform(slot, marker.liftM, scale, scratch))
      markers.setColorAt(
        i,
        selected ? markerColors.selected : fits ? markerColors.active : markerColors.idle,
      )
    })
    markers.instanceMatrix.needsUpdate = true
    if (markers.instanceColor !== null) markers.instanceColor.needsUpdate = true
  }

  const removeDecor = (slotId: string) => {
    const placed = placedBySlot.get(slotId)
    if (placed === undefined) return
    group.remove(placed.visual.object)
    placed.visual.dispose()
    placedBySlot.delete(slotId)
  }

  const addDecor = (slot: RoomSlot, fill: SlotFill) => {
    const visual = visuals.buildDecor(fill.itemId, fill.color)
    if (visual === null) return
    const { object } = visual
    object.name = `apartment-decor-${slot.id}`
    object.position.set(...slot.position)
    object.rotation.y = (slot.rotationDeg * Math.PI) / 180
    visual.setCastShadow(tier === 'high')
    group.add(object)
    placedBySlot.set(slot.id, { fill, visual })
  }

  return {
    group,
    slots,
    setPlaced(placed) {
      for (const slot of slots) {
        const fill = placed[slot.id]
        const current = placedBySlot.get(slot.id)
        if (
          current !== undefined &&
          fill !== undefined &&
          current.fill.itemId === fill.itemId &&
          current.fill.color === fill.color
        ) {
          continue
        }
        removeDecor(slot.id)
        if (fill !== undefined) addDecor(slot, fill)
      }
      layoutMarkers()
      layoutBlobs()
    },
    setMarkers(state) {
      markerState = state
      layoutMarkers()
    },
    setTier(next) {
      if (next === tier) return
      tier = next
      // A visual may differ by tier (S04h models can), so the room is rebuilt for it.
      group.remove(room.object)
      room.dispose()
      room = visuals.buildRoom(interior, tier)
      group.add(room.object)
      for (const placed of placedBySlot.values()) placed.visual.setCastShadow(tier === 'high')
      layoutBlobs()
    },
    screenSlots(camera, width, height) {
      return slots.flatMap((slot) => {
        const ndc = tapPoint(slot, marker.liftM).project(camera)
        if (ndc.z > 1) return []
        return [{ id: slot.id, x: ((ndc.x + 1) / 2) * width, y: ((1 - ndc.y) / 2) * height }]
      })
    },
    dispose() {
      for (const slotId of [...placedBySlot.keys()]) removeDecor(slotId)
      room.dispose()
      for (const mesh of [markers, blobs]) {
        mesh.geometry.dispose()
        ;(mesh.material as Material).dispose()
        mesh.dispose()
      }
    },
  }
}
