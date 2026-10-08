'use client'

/**
 * The base city: borough land, water, parks, subway ribbons, station markers and line letters,
 * plus the place pins and the "expanding soon" chips on dimmed boroughs (S04c), built once from
 * the fetched geo layers into merged/instanced meshes (under twenty draw calls). Renders state
 * only; the camera rig owns the view and PlacePins owns picking.
 *
 * Start-up (S04b, PERF-4): the canvas builds the city before mounting it, giving the browser a
 * turn between layers, and the city's shaders are compiled (asynchronously where the browser
 * supports it) before the first frame that shows it, so neither step is one long blocking task.
 */
import { useEffect, useRef, useState, type RefObject } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Color, Group, InstancedMesh, Mesh, MeshBasicMaterial, type Texture } from 'three'
import { MapControls } from 'three/addons/controls/MapControls.js'
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js'
import type { CitySceneConfig } from '@/lib/data/schemas/scene'
import { buildLandGeometry, buildWaterGeometry, landTopY } from './geo/buildLand'
import { buildLabelGeometry, terminalChips } from './geo/buildLabels'
import { buildParkGeometry, polygonsOfKind } from './geo/buildParks'
import {
  buildStationGeometry,
  stationPositions,
  stationRadius,
  writeStationMatrices,
} from './geo/buildStations'
import { buildSubwayGeometry, lineColors, subwaySegments } from './geo/buildSubway'
import { createLabelAtlas } from './geo/labelAtlas'
import type { BoroughId, GeoBase } from './geo/schema'
import type { KeyframeColors } from '@/lib/dayNight/types'
import type { DayNightUniforms } from './lighting/nightGlow'
import { createCityMaterials } from './materials'
import { buildChipGeometry, chipAnchor, createChipTexture } from './pins/buildChips'
import { buildPins, type PinObjects } from './pins/buildPins'
import { PlacePins } from './pins/PlacePins'
import type { ScenePalette } from './types'
import { perfMark } from '@/lib/perfMarks'
import { yieldToMain } from './schedule'

/** How one borough is drawn (the test hook reports it). */
export interface BoroughView {
  readonly id: BoroughId
  readonly land: 'normal' | 'dimmed'
  readonly pinCount: number
  /** Whether an "expanding soon" chip lies on it. */
  readonly chip: boolean
}

/** The built scene graph plus the per-view updates the camera drives. */
export interface CityObjects {
  readonly group: Group
  readonly pins: PinObjects
  readonly boroughs: readonly BoroughView[]
  /** The shared toon ramp: district buildings and landmarks shade with the same steps. */
  readonly gradientMap: Texture
  /** Boroughs drawn as "expanding soon" land. */
  readonly dimmed: ReadonlySet<BoroughId>
  /** Rescales station markers and pins and toggles line letters for a camera distance. */
  applyDistance(distance: number): void
  /** Shows or hides the outlines (the subway casing), per quality tier. */
  setOutlines(visible: boolean): void
  /**
   * Follows the day/night cycle (S04f): the harbour takes the keyframe's water colour, and the
   * unlit overlays (subway ribbons and casing, line letters, ground chips) dim with the light so
   * they never glare at night.
   */
  applyDayNight(colors: Pick<KeyframeColors<string>, 'water' | 'unlitTint'>): void
  dispose(): void
}

/**
 * Builds the city, awaiting `pause` between layers so the main thread is never blocked for the
 * whole build. Shadows are received by the ground layers and cast by the pins; they show only
 * where the tier's light casts one (SunLight.tsx).
 */
export async function buildCity(
  geo: GeoBase,
  palette: ScenePalette,
  config: CitySceneConfig,
  expandingSoon: string,
  pause: () => Promise<void>,
  dayNight: DayNightUniforms,
): Promise<CityObjects> {
  const top = landTopY(config.land)
  const colorById = lineColors(geo.subway.lines, palette.subwayLines)
  const atlas = createLabelAtlas(geo.subway.lines, colorById, palette.labelInk, config.labels)
  const dimmed = new Set(
    geo.places.boroughs.filter((borough) => borough.render === 'dimmed').map((b) => b.id),
  )
  const materials = createCityMaterials(palette, config, atlas.texture, dimmed)
  const group = new Group()
  group.name = 'city'

  for (const borough of geo.land.boroughs) {
    await pause()
    const mesh = new Mesh(
      buildLandGeometry(borough.polygons, config.land),
      materials.land[borough.id],
    )
    mesh.name = `land-${borough.id}`
    mesh.receiveShadow = true
    group.add(mesh)
  }
  await pause()

  const water = new Mesh(buildWaterGeometry(geo.water.sea, config.water.extraM), materials.water)
  water.name = 'water'
  group.add(water)

  // Parks on dimmed land draw dimmed, in their own mesh per kind (one extra call each).
  const parkY = top + config.parks.liftM
  for (const isDimmed of [false, true]) {
    for (const kind of ['park', 'cemetery'] as const) {
      const polygons = polygonsOfKind(geo.parks.parks, kind, { ids: dimmed, exclude: !isDimmed })
      if (polygons.length === 0) continue
      const material = isDimmed ? materials[`${kind}Dimmed`] : materials[kind]
      const mesh = new Mesh(buildParkGeometry(polygons, parkY), material)
      mesh.name = isDimmed ? `parks-${kind}-dimmed` : `parks-${kind}`
      mesh.receiveShadow = true
      group.add(mesh)
    }
  }
  await pause()

  const subwayGeometry = buildSubwayGeometry(
    subwaySegments(geo.subway.lines, colorById, top + config.subway.liftM),
  )
  const casing = config.subway.casing
    ? new LineSegments2(subwayGeometry, materials.subwayCasing)
    : null
  if (casing !== null) {
    casing.name = 'subway-casing'
    casing.renderOrder = 1
    group.add(casing)
  }
  const ribbons = new LineSegments2(subwayGeometry, materials.subway)
  ribbons.name = 'subway'
  ribbons.renderOrder = 2
  group.add(ribbons)

  const stationsAt = stationPositions(geo.subway.stations, top)
  const stations = new InstancedMesh(
    buildStationGeometry(config.stations.radialSegments),
    materials.station,
    geo.subway.stations.length,
  )
  stations.name = 'stations'
  group.add(stations)
  await pause()

  const chips = terminalChips(geo.subway.lines, geo.subway.stations)
  const labels = new Mesh(
    buildLabelGeometry(
      chips,
      atlas.cellIndex,
      atlas.layout,
      config.labels,
      top + config.labels.liftM,
    ),
    materials.label,
  )
  labels.name = 'line-labels'
  group.add(labels)

  const anchors = geo.land.boroughs.flatMap((borough) => {
    if (!dimmed.has(borough.id)) return []
    const anchor = chipAnchor(borough.polygons)
    return anchor === null ? [] : [{ id: borough.id, anchor }]
  })
  const chipTexture = createChipTexture(
    expandingSoon,
    palette.chip.fill,
    palette.chip.ink,
    config.chips,
  )
  const chipMaterial = new MeshBasicMaterial({
    map: chipTexture,
    alphaTest: config.chips.alphaTest,
  })
  if (anchors.length > 0) {
    const chips = new Mesh(
      buildChipGeometry(
        anchors.map((entry) => entry.anchor),
        config.chips,
        top + config.chips.liftM,
      ),
      chipMaterial,
    )
    chips.name = 'expanding-soon-chips'
    group.add(chips)
  }

  await pause()
  const pins = buildPins(
    geo.places.pins,
    palette,
    config,
    top,
    materials.gradientMap,
    dayNight.uNightGlow,
  )
  pins.group.traverse((object) => {
    if (object instanceof Mesh) object.castShadow = true
  })
  group.add(pins.group)

  const chipped = new Set(anchors.map((entry) => entry.id))
  const boroughs: BoroughView[] = geo.places.boroughs.map((borough) => ({
    id: borough.id,
    land: borough.render,
    pinCount: pins.pins.filter((pin) => pin.borough === borough.id).length,
    chip: chipped.has(borough.id),
  }))

  const casingColor = materials.subwayCasing.color.clone()
  const tint = new Color()
  let scaledFor = 0
  return {
    group,
    pins,
    boroughs,
    gradientMap: materials.gradientMap,
    dimmed,
    setOutlines(visible) {
      if (casing !== null) casing.visible = visible
    },
    applyDayNight(colors) {
      materials.water.color.set(colors.water)
      tint.set(colors.unlitTint)
      for (const unlit of [materials.subway, materials.label, chipMaterial]) unlit.color.copy(tint)
      materials.subwayCasing.color.copy(casingColor).multiply(tint)
    },
    applyDistance(distance) {
      pins.applyDistance(distance)
      labels.visible = distance <= config.labels.maxDistanceM
      const ratio =
        scaledFor === 0 ? Infinity : Math.max(distance / scaledFor, scaledFor / distance)
      if (ratio > config.stations.rescaleRatio) {
        scaledFor = distance
        writeStationMatrices(
          stations,
          stationsAt,
          stationRadius(distance, config.stations),
          config.stations.heightM,
        )
      }
    },
    dispose() {
      group.traverse((object) => {
        if (object instanceof Mesh) object.geometry.dispose()
      })
      stations.dispose()
      pins.dispose()
      chipMaterial.dispose()
      chipTexture.dispose()
      materials.dispose()
    },
  }
}

interface CityProps {
  /** Built by the canvas (buildCity), which also disposes of it. */
  readonly city: CityObjects
  readonly config: CitySceneConfig
  /** The tier's outlines setting. */
  readonly outlines: boolean
  /** Called once, after the first frame that shows the city. */
  readonly onReady: () => void
  /** Receives the built city for the test hooks. */
  readonly cityRef: RefObject<CityObjects | null>
}

export function City({ city, config, outlines, onReady, cityRef }: CityProps) {
  useEffect(() => {
    cityRef.current = city
    return () => {
      if (cityRef.current === city) cityRef.current = null
    }
  }, [city, cityRef])
  const gl = useThree((state) => state.gl)
  const camera = useThree((state) => state.camera)
  const scene = useThree((state) => state.scene)
  const controls = useThree((state) => state.controls)
  const invalidate = useThree((state) => state.invalidate)
  const placed = useRef(false)
  const reported = useRef(false)
  const [compiled, setCompiled] = useState(false)

  useEffect(() => {
    city.setOutlines(outlines)
    invalidate()
  }, [city, outlines, invalidate])

  // The shaders compile before the city joins the scene (lit by the scene's lights), so the
  // first frame that shows it does not stall on compilation. compileAsync needs
  // KHR_parallel_shader_compile (three warns without it, e.g. on SwiftShader); without it the
  // compile is synchronous but still happens before the city's first frame.
  useEffect(() => {
    let active = true
    const done = () => {
      if (!active) return
      perfMark('cc:3d:compiled')
      setCompiled(true)
      invalidate()
    }
    if (gl.extensions.has('KHR_parallel_shader_compile')) {
      void gl.compileAsync(city.group, camera, scene).then(done)
    } else {
      gl.compile(city.group, camera, scene)
      // A task later, so the compile is not one task with the commit that mounted the city.
      void yieldToMain().then(done)
    }
    return () => {
      active = false
    }
  }, [city, gl, camera, scene, invalidate])

  useEffect(() => {
    if (!(controls instanceof MapControls)) return
    const update = () => city.applyDistance(controls.getDistance())
    update()
    placed.current = true
    controls.addEventListener('change', update)
    invalidate()
    return () => controls.removeEventListener('change', update)
  }, [city, controls, invalidate])

  // Ready once a frame has drawn the city with its markers placed for the camera.
  useFrame(() => {
    if (reported.current || !placed.current || !compiled) return
    reported.current = true
    onReady()
  })

  if (!compiled) return null
  return (
    <>
      <primitive object={city.group} />
      <PlacePins pins={city.pins} config={config} groundY={landTopY(config.land)} />
    </>
  )
}
