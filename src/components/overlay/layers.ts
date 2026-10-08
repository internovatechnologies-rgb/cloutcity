import { layout } from '@/lib/data/config'
import type { LayoutConfig } from '@/lib/data/schemas/config'

/**
 * The overlay layer system (UX-1). Every piece of UI drawn over the scene lives in exactly one
 * named zone. Zones are rows of one CSS grid, so they can never overlap each other however much
 * content a zone holds: a zone clips or scrolls its own content instead of growing.
 *
 * Top to bottom: banner, HUD, free scene area, toast, sheet, tab bar.
 */
export const OVERLAY_ZONES = ['banner', 'hud', 'toast', 'sheet', 'tabs'] as const
export type OverlayZone = (typeof OVERLAY_ZONES)[number]

/**
 * Stacking order, lowest first. The scene sits underneath every zone; a modal (the welcome card,
 * later dialogs) sits above them all, in its own grid (see {@link MODAL_GRID_ROW}).
 */
export const OVERLAY_LAYER_ORDER = [
  'scene',
  'hud',
  'toast',
  'sheet',
  'banner',
  'tabs',
  'modal',
] as const
export type OverlayLayer = (typeof OVERLAY_LAYER_ORDER)[number]

export function layerZIndex(layer: OverlayLayer): number {
  return OVERLAY_LAYER_ORDER.indexOf(layer)
}

export type OverlayLayoutConfig = Readonly<LayoutConfig['overlay']>

export const overlayLayout: OverlayLayoutConfig = layout.overlay

/** Grid row for each zone (1-based, matching {@link overlayGridTracks}). */
export const ZONE_GRID_ROW: Readonly<Record<OverlayZone, number>> = {
  banner: 2,
  hud: 3,
  toast: 5,
  sheet: 6,
  tabs: 7,
}

/** Grid row of the free scene area between the HUD and the toast zone (no overlay zone). */
export const FREE_SCENE_GRID_ROW = 4

/**
 * Where a modal sits: from the free scene row down to the top of the tab bar (rows 4-6), so it
 * never covers the banner, HUD or tab bar.
 */
export const MODAL_GRID_ROW = `4 / ${ZONE_GRID_ROW.tabs}`

/**
 * The HUD row's height (S05): two rows of 44 px targets, or one row on a short, wide screen. The
 * overlay layout writes both heights on its root ({@link overlayCssVars}); globals.css switches
 * `--overlay-hud-h` to the compact height inside the same media query as the HUD's `hud-short`
 * variant, so the grid track and the HUD's own layout change together.
 */
export const HUD_HEIGHT_VAR = '--overlay-hud-h'
export const HUD_COMPACT_HEIGHT_VAR = '--overlay-hud-compact-h'

/**
 * The banner row's floor (UI-8): 0 while the banner is empty or holds only text, so a short
 * screen gives the room to the toast and sheet; the banner's height while it shows a notice
 * with buttons (the tour, the update notice, `data-cc-notice`), so its 44 px targets are never
 * clipped. globals.css raises it with `:has()`; no JS measures anything.
 */
export const BANNER_MIN_VAR = '--overlay-banner-min'
export const BANNER_HEIGHT_VAR = '--overlay-banner-h'

/** The HUD track: the CSS variable, falling back to the two-row height outside the layout. */
export function hudTrack(config: OverlayLayoutConfig): string {
  return `var(${HUD_HEIGHT_VAR}, ${config.hudHeightPx}px)`
}

/**
 * Custom properties the overlay layout sets on its root, inherited by every grid that repeats
 * the overlay rows (the modal layer, the scene's status row, the map attribution).
 */
export function overlayCssVars(config: OverlayLayoutConfig): Readonly<Record<string, string>> {
  return {
    [HUD_HEIGHT_VAR]: `${config.hudHeightPx}px`,
    [HUD_COMPACT_HEIGHT_VAR]: `${config.hudCompactHeightPx}px`,
    [BANNER_HEIGHT_VAR]: `${config.bannerHeightPx}px`,
    '--overlay-sheet-max-w': `${config.sheetMaxWidthPx}px`,
    '--overlay-loading-delay': `${config.loadingRevealDelayMs}ms`,
  }
}

/**
 * Rows: top safe-area inset, banner, HUD, free scene area, toast, sheet, tab bar (which also
 * absorbs the bottom safe-area inset so its background reaches the screen edge).
 *
 * Banner, toast and sheet are `minmax(0, max)`: the grid fills them to their max before the free
 * area gets more than its minimum, and on a short viewport (landscape phone) they shrink instead
 * of pushing the tab bar off screen. The banner keeps its full height while it shows a notice
 * with buttons ({@link BANNER_MIN_VAR}). HUD, tab bar and the free area's minimum
 * (`freeSceneMinHeightPx`, room for the map attribution) never shrink.
 */
export function overlayGridTracks(config: OverlayLayoutConfig): readonly string[] {
  return [
    'env(safe-area-inset-top, 0px)',
    `minmax(var(${BANNER_MIN_VAR}, 0px), ${config.bannerHeightPx}px)`,
    hudTrack(config),
    `minmax(${config.freeSceneMinHeightPx}px, 1fr)`,
    `minmax(0, ${config.toastHeightPx}px)`,
    `minmax(0, ${config.sheetMaxHeightVh}dvh)`,
    `calc(${config.tabBarHeightPx}px + env(safe-area-inset-bottom, 0px))`,
  ]
}

export function overlayGridTemplateRows(config: OverlayLayoutConfig): string {
  return overlayGridTracks(config).join(' ')
}
