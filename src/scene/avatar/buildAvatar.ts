/**
 * The player's avatar placeholder (S05): a toon capsule standing on a flat ring, in the player
 * colour. Two meshes (two draw calls, a few hundred triangles), built at unit height with its
 * feet at y = 0, so one uniform scale sets its height in metres. It renders state only and is
 * never picked: raycasting is off, taps go to the map.
 */
import {
  CapsuleGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshToonMaterial,
  RingGeometry,
  type Object3D,
} from 'three'
import type { SceneConfig } from '@/lib/data/schemas/scene'
import { createToonRamp } from '../toonRamp'
import { LAY_FLAT_X } from '../geo/coords'

export type AvatarConfig = SceneConfig['avatar']

/** Name of the avatar's group in the scene graph (the e2e hook finds it by name). */
export const PLAYER_AVATAR_NAME = 'player-avatar'

/** The avatar's height in metres for a camera distance: proportional, clamped. */
export function avatarSize(distance: number, avatar: AvatarConfig): number {
  return Math.min(
    avatar.maxHeightM,
    Math.max(avatar.minHeightM, distance * avatar.heightPerDistance),
  )
}

export interface AvatarObjects {
  readonly group: Group
  /** Shows or hides the capsule placeholder (hidden while the hand-made avatar stands in). */
  setCapsuleVisible(visible: boolean): void
  /** Sets the avatar's height in metres. */
  setHeight(heightM: number): void
  dispose(): void
}

const noRaycast: Object3D['raycast'] = () => {}

export function buildAvatar(
  color: string,
  toonRamp: readonly number[],
  avatar: AvatarConfig,
): AvatarObjects {
  const radius = avatar.radiusRatio
  // CapsuleGeometry(radius, height of the middle section, capSegments, radialSegments) in
  // three r182: the whole capsule is height + 2 × radius tall, centred on the origin.
  const body = new CapsuleGeometry(
    radius,
    1 - 2 * radius,
    avatar.capSegments,
    avatar.radialSegments,
  )
  body.translate(0, 0.5, 0)
  const ring = new RingGeometry(avatar.ringInnerRatio, avatar.ringOuterRatio, avatar.ringSegments)
  ring.rotateX(LAY_FLAT_X)
  ring.translate(0, avatar.ringLiftRatio, 0)

  const gradientMap = createToonRamp(toonRamp)
  const bodyMaterial = new MeshToonMaterial({ color, gradientMap })
  // Flat and unlit, like a sticker on the street; drawn over the land without writing depth.
  const ringMaterial = new MeshBasicMaterial({
    color,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  })

  const bodyMesh = new Mesh(body, bodyMaterial)
  bodyMesh.name = `${PLAYER_AVATAR_NAME}-body`
  // Seen only where the tier's sun casts a shadow (src/scene/SunLight.tsx).
  bodyMesh.castShadow = true
  const ringMesh = new Mesh(ring, ringMaterial)
  ringMesh.name = `${PLAYER_AVATAR_NAME}-ring`
  ringMesh.renderOrder = 3
  const group = new Group()
  group.name = PLAYER_AVATAR_NAME
  group.add(ringMesh, bodyMesh)
  for (const object of [group, bodyMesh, ringMesh]) object.raycast = noRaycast

  return {
    group,
    setCapsuleVisible(visible) {
      bodyMesh.visible = visible
    },
    setHeight(heightM) {
      group.scale.setScalar(heightM)
    },
    dispose() {
      body.dispose()
      ring.dispose()
      bodyMaterial.dispose()
      ringMaterial.dispose()
      gradientMap.dispose()
    },
  }
}
