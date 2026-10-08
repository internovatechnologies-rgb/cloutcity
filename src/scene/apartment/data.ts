/**
 * The apartment's data for its 3D chunk (S16): each home's interior (data/homes/interiors.json),
 * the scene's `apartment` block (data/config/scene.json), the room palette, decor colours and
 * the day/night keyframes the room's light follows (data/config/theme.json, scene.json
 * `dayNight`, S04f) and the per-tier budgets (data/config/perf.json). The files are
 * validated with their zod schemas in src/lib/data (data.test.ts, homes-data.test.ts); this chunk
 * reads the raw JSON so no config loader or classic zod ships to the browser, and narrows the
 * loosely typed JSON imports here, throwing at load on anything unexpected (fail fast).
 */
import interiorsJson from '@data/homes/interiors.json'
import perfJson from '@data/config/perf.json'
import sceneJson from '@data/config/scene.json'
import themeJson from '@data/config/theme.json'
import type { DecorFit } from '@/engine/itemCatalog'
import type { HomeIdLiteral } from '@/lib/data/homes'
import { resolveDayNight } from '@/lib/dayNight/resolveDayNight'
import type { DayNightModel, SceneDayNight, ThemeDayNight } from '@/lib/dayNight/types'
import type { QualityTier } from '@/lib/data/schemas/config'
import type { SceneConfig } from '@/lib/data/schemas/scene'

export type Vec3 = readonly [number, number, number]
export type ApartmentConfig = SceneConfig['apartment']
export type RoomWall = 'back' | 'left' | 'right'

export interface RoomOpening {
  readonly wall: RoomWall
  readonly centerM: number
  readonly widthM: number
  readonly heightM: number
  readonly sillM: number
}

export interface RoomSlot {
  readonly id: string
  readonly kind: DecorFit
  /** On the wall, floor or surface, in room metres (x right, y up, z toward the camera). */
  readonly position: Vec3
  readonly rotationDeg: number
}

export interface RoomInterior {
  readonly room: { readonly widthM: number; readonly depthM: number; readonly heightM: number }
  readonly window: RoomOpening
  readonly door: RoomOpening
  readonly camera: { readonly position: Vec3; readonly target: Vec3; readonly fovDeg: number }
  readonly slots: readonly RoomSlot[]
}

/** The room's colours as hex, resolved from theme.json `scene.apartment` world tokens. */
export interface RoomPalette {
  readonly background: string
  readonly floor: string
  readonly wall: string
  readonly trim: string
  readonly furniture: string
  readonly plant: string
  readonly glow: string
  readonly window: string
  readonly marker: string
  readonly markerActive: string
  readonly markerSelected: string
  readonly blob: string
  /** Warm lamp light mixed into the ambient at night. */
  readonly lamp: string
}

const KINDS: readonly string[] = ['wall', 'floor', 'surface']
const WALLS: readonly string[] = ['back', 'left', 'right']

function fail(what: string): never {
  throw new Error(`apartment data: ${what}`)
}

function vec3(value: readonly number[], what: string): Vec3 {
  const [x, y, z] = value
  if (value.length !== 3 || x === undefined || y === undefined || z === undefined) fail(what)
  return [x, y, z]
}

function opening(raw: (typeof interiorsJson.homes)['queens-room']['window'], what: string) {
  if (!WALLS.includes(raw.wall)) fail(`${what}.wall`)
  return { ...raw, wall: raw.wall as RoomWall }
}

function interior(home: HomeIdLiteral): RoomInterior {
  const raw = interiorsJson.homes[home]
  return {
    room: raw.room,
    window: opening(raw.window, `${home}.window`),
    door: opening(raw.door, `${home}.door`),
    camera: {
      position: vec3(raw.camera.position, `${home}.camera.position`),
      target: vec3(raw.camera.target, `${home}.camera.target`),
      fovDeg: raw.camera.fovDeg,
    },
    slots: raw.slots.map((slot) => {
      if (!KINDS.includes(slot.kind)) fail(`${home}.${slot.id}.kind`)
      return {
        id: slot.id,
        kind: slot.kind as DecorFit,
        position: vec3(slot.position, `${home}.${slot.id}.position`),
        rotationDeg: slot.rotationDeg,
      }
    }),
  }
}

const INTERIORS: Readonly<Record<HomeIdLiteral, RoomInterior>> = {
  'queens-room': interior('queens-room'),
  'brooklyn-1br': interior('brooklyn-1br'),
  'manhattan-loft': interior('manhattan-loft'),
}

export function roomInterior(home: HomeIdLiteral): RoomInterior {
  return INTERIORS[home]
}

export const apartmentConfig: ApartmentConfig = sceneJson.apartment
/** What counts as a tap: the map's rule (src/scene/pins/tap.ts), shared so both feel the same. */
export const tapOptions = { slopPx: sceneJson.pins.tapSlopPx, maxMs: sceneJson.pins.tapMaxMs }
/** The toon ramp the whole game shares. */
export const toonRamp: readonly number[] = themeJson.scene.toonRamp

const colors: Readonly<Record<string, string>> = themeJson.colors
const worldColors: Readonly<Record<string, string>> = { ...themeJson.world, ...themeJson.models }

/** A decor colour token's hex (item variants name DOM palette tokens, theme.json `colors`). */
export function tokenHex(token: string): string {
  return colors[token] ?? fail(`unknown palette token "${token}"`)
}

/** A room colour token's hex (theme.json `world` or `models`). */
function worldHex(token: string): string {
  return worldColors[token] ?? fail(`unknown world token "${token}"`)
}

/**
 * The city's day/night model, resolved here like the rest of this chunk's data (resolveDayNight
 * checks ids, order and tokens, failing at load).
 */
export const dayNightModel: DayNightModel = resolveDayNight(
  sceneJson.dayNight as SceneDayNight,
  { colors: worldColors, sky: themeJson.sky } as ThemeDayNight,
)
export const dayNightConfig: { readonly room: SceneConfig['dayNight']['room'] } = {
  room: sceneJson.dayNight.room,
}

const refs = themeJson.scene.apartment

export const roomPalette: RoomPalette = {
  background: worldHex(refs.background),
  floor: worldHex(refs.floor),
  wall: worldHex(refs.wall),
  trim: worldHex(refs.trim),
  furniture: worldHex(refs.furniture),
  plant: worldHex(refs.plant),
  glow: worldHex(refs.glow),
  window: worldHex(refs.window),
  marker: worldHex(refs.marker),
  markerActive: worldHex(refs.markerActive),
  markerSelected: worldHex(refs.markerSelected),
  blob: worldHex(refs.blob),
  lamp: worldHex(refs.lamp),
}

export interface TierBudget {
  readonly dprCap: number
  readonly shadows: 'none' | 'blob-or-baked' | 'pcf-directional'
  readonly drawCallsMax: number
  readonly trianglesMax: number
}

const SHADOW_MODES: readonly string[] = ['none', 'blob-or-baked', 'pcf-directional']

/** The apartment's render settings and caps for one quality tier (perf.json). */
export function tierBudget(tier: QualityTier): TierBudget {
  const shadows = perfJson.shadows[tier]
  if (!SHADOW_MODES.includes(shadows)) fail(`perf.shadows.${tier}`)
  return {
    dprCap: perfJson.dprCap[tier],
    shadows: shadows as TierBudget['shadows'],
    drawCallsMax: perfJson.apartment.drawCallsMax[tier],
    trianglesMax: perfJson.apartment.trianglesMax[tier],
  }
}

/** Kept free inside every tier's caps for the 3D avatar in the room (S16a). */
export const avatarReserve: { readonly drawCalls: number; readonly triangles: number } =
  perfJson.apartment.avatarReserve
