import { describe, expect, it } from 'vitest'
import {
  FREE_SCENE_GRID_ROW,
  MODAL_GRID_ROW,
  OVERLAY_LAYER_ORDER,
  OVERLAY_ZONES,
  ZONE_GRID_ROW,
  BANNER_HEIGHT_VAR,
  BANNER_MIN_VAR,
  HUD_COMPACT_HEIGHT_VAR,
  HUD_HEIGHT_VAR,
  layerZIndex,
  overlayCssVars,
  overlayGridTracks,
  overlayLayout,
} from './layers'

describe('overlay layers', () => {
  it('gives every zone its own grid row', () => {
    const rows = OVERLAY_ZONES.map((zone) => ZONE_GRID_ROW[zone])
    expect(new Set(rows).size).toBe(OVERLAY_ZONES.length)
  })

  it('puts zones in top-to-bottom order around the free scene row', () => {
    const tracks = overlayGridTracks(overlayLayout)
    expect(tracks).toHaveLength(7)
    expect(tracks[3]).toBe(`minmax(${overlayLayout.freeSceneMinHeightPx}px, 1fr)`)
    expect(ZONE_GRID_ROW.banner).toBeLessThan(ZONE_GRID_ROW.hud)
    expect(ZONE_GRID_ROW.hud).toBeLessThan(4)
    expect(ZONE_GRID_ROW.toast).toBeGreaterThan(4)
    expect(ZONE_GRID_ROW.toast).toBeLessThan(ZONE_GRID_ROW.sheet)
    expect(ZONE_GRID_ROW.sheet).toBeLessThan(ZONE_GRID_ROW.tabs)
  })

  it('reserves a fixed tab bar and HUD at least 44 px tall', () => {
    const tracks = overlayGridTracks(overlayLayout)
    expect(tracks[2]).toBe(`var(${HUD_HEIGHT_VAR}, ${overlayLayout.hudHeightPx}px)`)
    expect(overlayLayout.tabBarHeightPx).toBeGreaterThanOrEqual(44)
    expect(tracks[6]).toContain('env(safe-area-inset-bottom')
  })

  it('sizes the HUD for two rows of 44 px targets, or one compact row (S05)', () => {
    // Two rows of 44 px, a 4 px gap and 6 px padding above and below.
    expect(overlayLayout.hudHeightPx).toBeGreaterThanOrEqual(2 * 44 + 4 + 2 * 6)
    expect(overlayLayout.hudCompactHeightPx).toBeGreaterThanOrEqual(44 + 2 * 6)
    expect(overlayCssVars(overlayLayout)).toMatchObject({
      [HUD_HEIGHT_VAR]: `${overlayLayout.hudHeightPx}px`,
      [HUD_COMPACT_HEIGHT_VAR]: `${overlayLayout.hudCompactHeightPx}px`,
    })
  })

  it('keeps the free scene row on a landscape phone with the compact HUD (S04a)', () => {
    // 844×390: the fixed rows (compact HUD, free scene minimum, tab bar) leave room to spare.
    const fixed =
      overlayLayout.hudCompactHeightPx +
      overlayLayout.freeSceneMinHeightPx +
      overlayLayout.tabBarHeightPx
    expect(fixed).toBeLessThanOrEqual(390)
    const tracks = overlayGridTracks(overlayLayout)
    expect(tracks[3]).toBe(`minmax(${overlayLayout.freeSceneMinHeightPx}px, 1fr)`)
  })

  it('floors the banner row at its height only while it shows a notice with buttons (UI-8)', () => {
    const tracks = overlayGridTracks(overlayLayout)
    expect(tracks[1]).toBe(`minmax(var(${BANNER_MIN_VAR}, 0px), ${overlayLayout.bannerHeightPx}px)`)
    expect(overlayLayout.bannerHeightPx).toBeGreaterThanOrEqual(44 + 2 * 2)
    expect(overlayCssVars(overlayLayout)).toMatchObject({
      [BANNER_HEIGHT_VAR]: `${overlayLayout.bannerHeightPx}px`,
    })
    // 568x320 with the two-row HUD: the banner, HUD, free scene minimum and tab bar still fit.
    const fixed =
      overlayLayout.bannerHeightPx +
      overlayLayout.hudHeightPx +
      overlayLayout.freeSceneMinHeightPx +
      overlayLayout.tabBarHeightPx
    expect(fixed).toBeLessThanOrEqual(320)
  })

  it('keeps a free scene row tall enough for the map attribution and its 44 px link', () => {
    expect(overlayLayout.freeSceneMinHeightPx).toBeGreaterThanOrEqual(44)
  })

  it('stacks the scene below every zone', () => {
    for (const layer of OVERLAY_LAYER_ORDER.filter((l) => l !== 'scene')) {
      expect(layerZIndex(layer)).toBeGreaterThan(layerZIndex('scene'))
    }
  })

  it('stacks a modal above every zone, between the HUD and the tab bar', () => {
    for (const layer of OVERLAY_LAYER_ORDER.filter((l) => l !== 'modal')) {
      expect(layerZIndex('modal')).toBeGreaterThan(layerZIndex(layer))
    }
    const [start, end] = MODAL_GRID_ROW.split(' / ').map(Number)
    expect(start).toBe(ZONE_GRID_ROW.hud + 1)
    expect(start).toBe(FREE_SCENE_GRID_ROW)
    expect(end).toBe(ZONE_GRID_ROW.tabs)
  })
})
