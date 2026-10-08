/**
 * The seam between the apartment's logic and its art (S16, DEC-24). Everything the room looks
 * like comes through `ApartmentVisuals`: the room shell for a home and tier, and one object per
 * placed decor item in its colour. The scene graph (buildApartment.ts), slots, markers, picking,
 * budgets and tests only ever see these interfaces, so the code-built placeholders here can be
 * swapped for CC0 glTF models from the S04h asset pipeline without touching any of them.
 *
 * Contract for an implementation:
 * - an object's origin is its slot point, +z faces into the room; a wall item hangs on the wall
 *   plane, a floor or surface item stands on y = 0 (the scene turns and moves it to the slot);
 * - it never raycasts (picking is screen-space, src/scene/pins/pick.ts);
 * - `dispose` frees what that object alone owns; shared resources go with `visuals.dispose`;
 * - it stays within perf.json `apartment` with `avatarReserve` kept free (home-apartment.spec.ts).
 */
import {
  FrontSide,
  Mesh,
  MeshBasicMaterial,
  MeshToonMaterial,
  type BufferGeometry,
  type Material,
  type Object3D,
} from 'three'
import type { QualityTier } from '@/lib/data/schemas/config'
import { createToonRamp } from '../toonRamp'
import { buildDecorModel, type DecorModel } from './buildDecor'
import { buildRoomGeometry } from './buildRoom'
import type { ApartmentConfig, RoomInterior, RoomPalette } from './data'

export interface RoomVisual {
  readonly object: Object3D
  dispose(): void
}

export interface DecorVisual {
  readonly object: Object3D
  /** Half the footprint's width, for the mid tier's blob shadow under floor and surface items. */
  readonly footprintM: number
  /** Casts into the high tier's shadow map. */
  setCastShadow(on: boolean): void
  dispose(): void
}

export interface ApartmentVisuals {
  /** The room shell for a home's layout at a tier. */
  buildRoom(layout: RoomInterior, tier: QualityTier): RoomVisual
  /** One placed decor item in a colour (hex), or null for an item with no visual yet. */
  buildDecor(itemId: string, color: string): DecorVisual | null
  /** Frees what the visuals share (textures, cached geometry, shared materials). */
  dispose(): void
}

const noRaycast: Object3D['raycast'] = () => {}

/**
 * The placeholder art: the code-built room (buildRoom.ts) and low-poly decor (buildDecor.ts), toon
 * shaded with the shared ramp. Kept until the S16 visuals pass replaces it with CC0 models.
 */
export function createPlaceholderVisuals(
  config: ApartmentConfig,
  palette: RoomPalette,
  toonRamp: readonly number[],
): ApartmentVisuals {
  const gradientMap = createToonRamp(toonRamp)
  const models = new Map<string, DecorModel | null>()
  const model = (itemId: string) => {
    if (!models.has(itemId)) models.set(itemId, buildDecorModel(itemId))
    return models.get(itemId) ?? null
  }
  const secondMaterials = new Map<string, MeshToonMaterial>()
  const secondMaterial = (role: NonNullable<DecorModel['second']>) => {
    let material = secondMaterials.get(role)
    if (material === undefined) {
      material = new MeshToonMaterial({ color: palette[role], gradientMap })
      secondMaterials.set(role, material)
    }
    return material
  }

  return {
    buildRoom(layout) {
      const geometry: BufferGeometry = buildRoomGeometry(layout, config, palette)
      // Single-sided: a wall between the camera and the room is culled (the cutaway).
      const material = new MeshToonMaterial({ vertexColors: true, gradientMap, side: FrontSide })
      const mesh = new Mesh(geometry, material)
      mesh.name = 'apartment-room'
      mesh.receiveShadow = true
      mesh.raycast = noRaycast
      return {
        object: mesh,
        dispose() {
          geometry.dispose()
          material.dispose()
        },
      }
    },
    buildDecor(itemId, color) {
      const built = model(itemId)
      if (built === null) return null
      const main = built.glows
        ? new MeshBasicMaterial({ color })
        : new MeshToonMaterial({ color, gradientMap })
      const materials: Material[] =
        built.second === null ? [main] : [main, secondMaterial(built.second)]
      const mesh = new Mesh(built.geometry, materials)
      mesh.raycast = noRaycast
      return {
        object: mesh,
        footprintM: built.footprintM,
        setCastShadow(on) {
          mesh.castShadow = on
        },
        dispose() {
          main.dispose()
        },
      }
    },
    dispose() {
      for (const built of models.values()) built?.geometry.dispose()
      for (const material of secondMaterials.values()) material.dispose()
      gradientMap.dispose()
    },
  }
}
