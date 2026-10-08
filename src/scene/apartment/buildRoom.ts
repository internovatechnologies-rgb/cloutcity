/**
 * The apartment shell (S16): floor slab, back, left and right walls, baseboards, the window pane
 * and the door, and a ledge or side table under every surface slot, merged into one vertex-
 * coloured geometry (one draw call).
 *
 * The cutaway: walls are single planes facing into the room and the material culls back faces,
 * so whichever wall stands between the camera and the room is not drawn, and the open front never
 * needs a wall at all. Trim, pane and door are drawn `insetM` in front of their wall.
 *
 * Room space (data/homes/interiors.json): metres, x right, y up, z toward the camera, the floor's
 * centre at the origin. Along the back wall an opening's `centerM` runs with x; along a side wall
 * it runs with z.
 */
import { PlaneGeometry, type BufferGeometry } from 'three'
import type {
  ApartmentConfig,
  RoomInterior,
  RoomOpening,
  RoomPalette,
  RoomSlot,
  RoomWall,
} from './data'
import { boxAt, mergeParts, paintedPart } from './parts'

type RoomColors = Pick<RoomPalette, 'floor' | 'wall' | 'trim' | 'furniture' | 'window'>

/** A rectangle on a wall: centred `along` the wall, from `bottom` up `height`, `inset` in front. */
function wallQuad(
  wall: RoomWall,
  room: RoomInterior['room'],
  rect: { along: number; width: number; bottom: number; height: number },
  inset: number,
): BufferGeometry {
  const quad = new PlaneGeometry(rect.width, rect.height)
  const y = rect.bottom + rect.height / 2
  switch (wall) {
    case 'back':
      quad.translate(rect.along, y, -room.depthM / 2 + inset)
      break
    case 'left':
      // A plane faces +z; a quarter turn faces it +x, into the room.
      quad.rotateY(Math.PI / 2)
      quad.translate(-room.widthM / 2 + inset, y, rect.along)
      break
    case 'right':
      quad.rotateY(-Math.PI / 2)
      quad.translate(room.widthM / 2 - inset, y, rect.along)
      break
  }
  return quad
}

function wallLength(wall: RoomWall, room: RoomInterior['room']): number {
  return wall === 'back' ? room.widthM : room.depthM
}

function openingQuad(opening: RoomOpening, room: RoomInterior['room'], inset: number) {
  return wallQuad(
    opening.wall,
    room,
    {
      along: opening.centerM,
      width: opening.widthM,
      bottom: opening.sillM,
      height: opening.heightM,
    },
    inset,
  )
}

/** The wall a surface slot leans on, if it is within the ledge depth of one. */
function ledgeWall(slot: RoomSlot, room: RoomInterior['room'], depth: number): RoomWall | null {
  const [x, , z] = slot.position
  if (x <= -room.widthM / 2 + depth) return 'left'
  if (x >= room.widthM / 2 - depth) return 'right'
  if (z <= -room.depthM / 2 + depth) return 'back'
  return null
}

/** A ledge from the wall under a surface slot near a wall, else a side table under it. */
function furnitureUnder(
  slot: RoomSlot,
  room: RoomInterior['room'],
  config: ApartmentConfig,
): BufferGeometry[] {
  const [x, y, z] = slot.position
  const thick = config.ledgeThicknessM
  const span = config.tableSizeM * 2
  const top = y - thick / 2
  switch (ledgeWall(slot, room, config.ledgeDepthM)) {
    case 'left':
      return [
        boxAt(
          [config.ledgeDepthM, thick, span],
          [-room.widthM / 2 + config.ledgeDepthM / 2, top, z],
        ),
      ]
    case 'right':
      return [
        boxAt(
          [config.ledgeDepthM, thick, span],
          [room.widthM / 2 - config.ledgeDepthM / 2, top, z],
        ),
      ]
    case 'back':
      return [
        boxAt(
          [span, thick, config.ledgeDepthM],
          [x, top, -room.depthM / 2 + config.ledgeDepthM / 2],
        ),
      ]
    case null: {
      const size = config.tableSizeM
      const post = Math.max(0.01, y - thick)
      return [boxAt([size, thick, size], [x, top, z]), boxAt([0.08, post, 0.08], [x, post / 2, z])]
    }
  }
}

/** The room shell as one vertex-coloured geometry. */
export function buildRoomGeometry(
  interior: RoomInterior,
  config: ApartmentConfig,
  colors: RoomColors,
): BufferGeometry {
  const { room } = interior
  const inset = config.insetM
  const walls: readonly RoomWall[] = ['back', 'left', 'right']
  const parts: BufferGeometry[] = [
    paintedPart(
      boxAt(
        [room.widthM, config.floorThicknessM, room.depthM],
        [0, -config.floorThicknessM / 2, 0],
      ),
      colors.floor,
    ),
    ...walls.map((wall) =>
      paintedPart(
        wallQuad(
          wall,
          room,
          { along: 0, width: wallLength(wall, room), bottom: 0, height: room.heightM },
          0,
        ),
        colors.wall,
      ),
    ),
    ...walls.map((wall) =>
      paintedPart(
        wallQuad(
          wall,
          room,
          { along: 0, width: wallLength(wall, room), bottom: 0, height: config.trimHeightM },
          inset,
        ),
        colors.trim,
      ),
    ),
    paintedPart(openingQuad(interior.window, room, inset), colors.window),
    paintedPart(openingQuad(interior.door, room, inset), colors.furniture),
    ...interior.slots
      .filter((slot) => slot.kind === 'surface')
      .flatMap((slot) => furnitureUnder(slot, room, config))
      .map((piece) => paintedPart(piece, colors.furniture)),
  ]
  return mergeParts(parts, 'room')
}

/** The room's bounding box: floor slab to ceiling, wall to open front. */
export function roomBounds(interior: RoomInterior, config: ApartmentConfig) {
  const { room } = interior
  return {
    min: [-room.widthM / 2, -config.floorThicknessM, -room.depthM / 2] as const,
    max: [room.widthM / 2, room.heightM, room.depthM / 2] as const,
  }
}
