/**
 * Serialisable props the server scene mount (CityScene.tsx) hands to the client scene. Types
 * only, so the client never imports a config loader.
 */
import type { DistrictAssets } from '@/lib/data/districts'
import type { SkyColors } from '@/lib/dayNight/types'
import type { HomeIdLiteral } from '@/lib/data/homes'
import type { FpsStepDown, PerfConfig, QualityTier, TierPicker } from '@/lib/data/schemas/config'
import type { CitySceneConfig } from '@/lib/data/schemas/scene'
import type { LocalPoint } from '@/lib/geo/projection'
import type { PlayerModel } from './avatar/PlayerAvatar'
import type { LocalBounds } from './camera/limits'
import type { BoroughId } from './geo/schema'
import type { LandmarkPalette } from './landmarks/types'

/** Scene colours as hex, resolved from theme.json tokens on the server (src/lib/theme.ts). */
export interface ScenePalette {
  /** The fixed neutral "expanding soon" land dims towards (the sky changes with the time). */
  readonly haze: string
  readonly water: string
  readonly land: Readonly<Record<BoroughId, string>>
  readonly park: string
  readonly cemetery: string
  readonly subwayLines: readonly string[]
  readonly subwayCasing: string
  readonly station: string
  /** The player's avatar placeholder and its ring (S05). */
  readonly player: string
  readonly labelInk: string
  readonly pins: {
    readonly venue: string
    readonly landmark: string
    readonly teaser: string
    /** Memorial pins: a muted, respectful colour. */
    readonly muted: string
    readonly selected: string
  }
  readonly chip: { readonly fill: string; readonly ink: string }
  /** Travel (S08): the taxi, the subway car and the trail. */
  readonly travel: { readonly taxi: string; readonly train: string; readonly trail: string }
  readonly toonRamp: readonly number[]
  /** District buildings and procedural blocks (S04d). */
  readonly buildings: {
    /** District facades, one picked per mass. */
    readonly walls: readonly string[]
    readonly roof: string
    /** The warm light of a lit window at night. */
    readonly window: string
    /** Low blocks outside the districts, one picked per block. */
    readonly blocks: readonly string[]
    /** The one colour blocks on "expanding soon" land are dimmed from. */
    readonly dimmedBlock: string
  }
  /** The landmark kit's role colours (S07a). */
  readonly landmarks: LandmarkPalette
}

export interface SceneCopy {
  readonly label: string
  readonly loading: string
  /** No WebGL on this device. */
  readonly errorDevice: string
  /** The geo download failed or was invalid, or the scene failed to start. */
  readonly errorLoad: string
  /** The WebGL context was lost: the map is paused until the browser restores it. */
  readonly lost: string
  /** Alt text of the static fallback map shown while the 3D map is unavailable. */
  readonly fallback: string
  /** The ground label on "expanding soon" boroughs. */
  readonly expandingSoon: string
  /**
   * Name chip text per modelled landmark id (S07a): the landmark's copy name, which is its
   * generic label where the real name is trademarked.
   */
  readonly landmarkNames: Readonly<Record<string, string>>
}

/** One quality tier's render settings (data/config/perf.json), resolved on the server. */
export interface TierRenderSettings {
  readonly dprCap: number
  /** Read when the canvas is created: a tier change applies it on the next load. */
  readonly antialias: boolean
  readonly shadows: PerfConfig['shadows'][QualityTier]
  /** The directional light's shadow map size; 0 where the tier has no such light. */
  readonly shadowMapSizePx: number
  /** Outlines: the subway casing today, inverted-hull outlines with S04d/S07a. */
  readonly outlines: boolean
  /** Share of district buildings drawn (S04d). */
  readonly buildingDensity: number
  /** Multiplies detail-level switch distances (S04d, S07a). */
  readonly lodDistanceScale: number
}

/** The quality tier rules and per-tier settings the client scene needs (S04b). */
export interface SceneQuality {
  readonly picker: TierPicker
  readonly stepDown: FpsStepDown
  readonly tiers: Readonly<Record<QualityTier, TierRenderSettings>>
}

/** How long a trip animates (balance.json `transit.animation`, S08). */
export interface TravelAnimation {
  readonly maxMs: number
  readonly msPerGameMinute: number
}

export interface SceneProps {
  /** /geo/base?v=<geoVersion>. */
  readonly geoUrl: string
  /** /geo/fallback?v=<geoVersion>: the static stylised map for when the 3D map is unavailable. */
  readonly fallbackUrl: string
  readonly palette: ScenePalette
  /** Each day/night keyframe's colours, resolved (S04f, src/lib/theme.ts `skyColors`). */
  readonly skyColors: SkyColors
  readonly config: CitySceneConfig
  /** Every home (data/homes/homes.json) projected to local metres. */
  readonly homesLocal: Readonly<Record<HomeIdLiteral, LocalPoint>>
  /**
   * The new player's home (balance.json `start.home`): where the camera and avatar start until
   * the HUD has read the save (src/state/playerHome.ts).
   */
  readonly startHome: HomeIdLiteral
  /** data/geo/bounds.json in local metres: the camera target never leaves it. */
  readonly boundsLocal: LocalBounds
  readonly quality: SceneQuality
  /** District building and block files per tier (S04d, src/lib/data/districts.ts). */
  readonly buildings: Readonly<Record<QualityTier, DistrictAssets>>
  readonly travelAnimation: TravelAnimation
  /** The player's hand-made avatar (S04h/S05), shown once loaded over the capsule placeholder. */
  readonly playerModel: PlayerModel
  /** The overlay grid rows (src/components/overlay/layers.ts), for the scene's own status row. */
  readonly overlayRows: string
  /** The free scene row of that grid (no overlay zone covers it). */
  readonly freeRow: number
  readonly copy: SceneCopy
}

/** `lost`: the WebGL context was lost after the map drew; it returns to `ready` once restored. */
export type SceneStatus = 'loading' | 'ready' | 'error' | 'lost'

/** Why the 3D map is unavailable: the device (no WebGL) or loading (download, data, start). */
export type SceneFailure = 'device' | 'load'

/**
 * Marks the scene's own status row, which repeats the overlay grid's free scene row: the camera
 * frames the target at its centre (src/scene/camera/FreeRowFraming.tsx).
 */
export const FREE_SCENE_ROW_SELECTOR = '[data-free-scene-row]'
