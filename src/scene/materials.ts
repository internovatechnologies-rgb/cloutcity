/**
 * Every material of the base city, created once per scene and disposed with it. All toon
 * materials share one gradient ramp texture (the sticker look), so tones step identically on
 * every layer. "Expanding soon" boroughs (S04c) get dimmed land and park colours: the palette
 * colour mixed towards the fixed haze (not the sky, which changes with the time of day).
 */
import { Color, MeshBasicMaterial, MeshToonMaterial } from 'three'
import type { DataTexture, Texture } from 'three'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import type { SceneConfig } from '@/lib/data/schemas/scene'
import { BOROUGH_IDS, type BoroughId } from './geo/schema'
import { createToonRamp } from './toonRamp'
import type { ScenePalette } from './types'

/** `hex` mixed a fraction `t` of the way towards `towards` (both sRGB hex). */
export function dimmedColor(hex: string, towards: string, t: number): Color {
  return new Color(hex).lerp(new Color(towards), t)
}

export interface CityMaterials {
  readonly gradientMap: DataTexture
  readonly land: Readonly<Record<BoroughId, MeshToonMaterial>>
  readonly water: MeshToonMaterial
  readonly park: MeshToonMaterial
  readonly cemetery: MeshToonMaterial
  /** Parks and cemeteries on dimmed land. */
  readonly parkDimmed: MeshToonMaterial
  readonly cemeteryDimmed: MeshToonMaterial
  readonly station: MeshToonMaterial
  readonly subway: LineMaterial
  readonly subwayCasing: LineMaterial
  readonly label: MeshBasicMaterial
  dispose(): void
}

export function createCityMaterials(
  palette: ScenePalette,
  config: Pick<SceneConfig, 'subway' | 'labels' | 'dimmed'>,
  labelAtlas: Texture,
  dimmedBoroughs: ReadonlySet<BoroughId>,
): CityMaterials {
  const gradientMap = createToonRamp(palette.toonRamp)
  const toon = (color: string | Color) => new MeshToonMaterial({ color, gradientMap })
  const dim = (hex: string) => dimmedColor(hex, palette.haze, config.dimmed.towardBackground)
  // Parks lie just above the land top: the offset wins the depth test without a visible gap.
  const ground = (color: string | Color) =>
    new MeshToonMaterial({
      color,
      gradientMap,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    })

  const land = Object.fromEntries(
    BOROUGH_IDS.map((id) => [
      id,
      toon(dimmedBoroughs.has(id) ? dim(palette.land[id]) : palette.land[id]),
    ]),
  ) as Record<BoroughId, MeshToonMaterial>
  const subway = new LineMaterial({
    vertexColors: true,
    linewidth: config.subway.lineWidthPx,
    worldUnits: false,
  })
  // The casing shares the ribbons' geometry and is drawn first without writing depth, so the
  // ribbons on top pass the depth test at the same depth.
  const subwayCasing = new LineMaterial({
    color: palette.subwayCasing,
    linewidth: config.subway.casingWidthPx,
    worldUnits: false,
    depthWrite: false,
  })
  const label = new MeshBasicMaterial({ map: labelAtlas, alphaTest: config.labels.alphaTest })

  const materials = {
    gradientMap,
    land,
    water: toon(palette.water),
    park: ground(palette.park),
    cemetery: ground(palette.cemetery),
    parkDimmed: ground(dim(palette.park)),
    cemeteryDimmed: ground(dim(palette.cemetery)),
    station: toon(palette.station),
    subway,
    subwayCasing,
    label,
  }
  return {
    ...materials,
    dispose() {
      for (const material of [
        ...Object.values(land),
        materials.water,
        materials.park,
        materials.cemetery,
        materials.parkDimmed,
        materials.cemeteryDimmed,
        materials.station,
        subway,
        subwayCasing,
        label,
      ]) {
        material.dispose()
      }
      gradientMap.dispose()
      labelAtlas.dispose()
    },
  }
}
