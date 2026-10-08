'use client'

/**
 * The modelled landmarks on the map (S07a): bridges, buildings, stations and government halls
 * at their real coordinates and orientation (data/landmarks/frames.derived.json), each a drei
 * `Detailed` switching between its kit-built levels by camera distance and culled beyond the
 * tier's distance. Builds wait for the city's first frame and then run one landmark per slice,
 * nearest first, so the map is playable before any model exists (PERF-4).
 *
 * The tier sets the levels built (low skips L0), the switch and cull distances
 * (lodDistanceScale), and whether outlines show. Landmarks on "expanding soon" land draw in the
 * dimmed teaser material. Models are not pickable: their pins are (S04c, Q5). Name chips show
 * the server's copy only. Each landmark's model comes from landmarkSource(id): the kit today,
 * Blender glTF later (DEC-25).
 */
import { useContext, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useThree } from '@react-three/fiber'
import { Detailed } from '@react-three/drei/core/Detailed'
import { Mesh, MeshBasicMaterial, Vector3, type LOD, type Texture } from 'three'
import { MapControls } from 'three/addons/controls/MapControls.js'
import type { QualityTier } from '@/lib/data/schemas/config'
import type { CitySceneConfig } from '@/lib/data/schemas/scene'
import { log } from '@/lib/log'
import type { GeoLandmark } from '../geo/schema'
import { DayNightContext, isNightGlowExcluded, useNightGlow } from '../lighting/nightGlow'
import { useTierSettings } from '../quality/tierSettings'
import { createSlicer } from '../schedule'
import type { ScenePalette } from '../types'
import { buildLandmark, disposeLandmark, type BuiltLandmark } from './buildLandmark'
import { landmarkLod, type LandmarkLod } from './lod'
import { createLandmarkMaterials } from './materials'
import { buildNameChipGeometry, createNameAtlas, type NameChip } from './nameChips'
import { landmarkSource, type LandmarkSource } from './source'

/** One landmark as the e2e hook reads it (src/scene/testHooks.tsx). */
export interface LandmarkState {
  readonly id: string
  readonly source: LandmarkSource
  readonly style: GeoLandmark['style']
  /** Built level drawn now (0 finest), or null when culled or not built yet. */
  readonly level: number | null
  readonly built: boolean
  /** Triangles of each built level, finest first. */
  readonly triangles: readonly number[]
  readonly lod: LandmarkLod
  /** Where its anchor is on screen, in client CSS pixels (null when behind the camera). */
  readonly screen: { readonly x: number; readonly y: number } | null
  readonly outlineVisible: boolean
}

export interface LandmarksState {
  readonly tier: QualityTier
  /** Every landmark is built (or failed and was skipped). */
  readonly done: boolean
  readonly failed: readonly string[]
  readonly chips: { readonly visible: boolean; readonly texts: readonly string[] }
  readonly landmarks: readonly LandmarkState[]
}

export interface LandmarksHandle {
  state(): LandmarksState | null
}

interface LandmarksProps {
  readonly landmarks: readonly GeoLandmark[]
  readonly palette: ScenePalette
  readonly config: CitySceneConfig
  readonly groundY: number
  /** The city's shared toon ramp. */
  readonly gradientMap: Texture
  /** The city has drawn its first frame: building may start. */
  readonly active: boolean
  /** Display name per landmark id, from the server's copy. */
  readonly names: Readonly<Record<string, string>>
  /** Pin lift per landmark id (places layer `liftM`): chips float at the same height. */
  readonly pinLifts: ReadonlyMap<string, number>
  readonly handleRef: RefObject<LandmarksHandle | null>
}

const noRaycast = () => {}
const _anchor = new Vector3()

const isBridge = (entry: GeoLandmark) => entry.frame.base === 'water'

export function Landmarks({
  landmarks,
  palette,
  config,
  groundY,
  gradientMap,
  active,
  names,
  pinLifts,
  handleRef,
}: LandmarksProps) {
  const settings = useTierSettings()
  const tier = settings.tier
  const camera = useThree((state) => state.camera)
  const controls = useThree((state) => state.controls)
  const gl = useThree((state) => state.gl)
  const invalidate = useThree((state) => state.invalidate)
  const lods = useRef(new Map<string, LOD>())
  const [built, setBuilt] = useState<{ tier: QualityTier; models: BuiltLandmark[] } | null>(null)
  const [failed, setFailed] = useState<readonly string[]>([])
  const [chipsVisible, setChipsVisible] = useState(false)

  // Windows glow with the shared night-glow uniform (S04f contract); a landmark whose category
  // must never glow (a memorial) gets the same materials without it.
  const glow = useNightGlow()
  // Name chips are unlit: they share the rig's tint colour, so they dim with the night (S04f).
  const unlitTint = useContext(DayNightContext).unlitTint.value
  const needsPlain = landmarks.some((entry) => isNightGlowExcluded(entry.category))
  const materials = useMemo(
    () => createLandmarkMaterials(gradientMap, palette.landmarks, { uniform: glow }),
    [gradientMap, palette.landmarks, glow],
  )
  const plainMaterials = useMemo(
    () => (needsPlain ? createLandmarkMaterials(gradientMap, palette.landmarks) : null),
    [needsPlain, gradientMap, palette.landmarks],
  )
  useEffect(() => () => materials.dispose(), [materials])
  useEffect(() => () => plainMaterials?.dispose(), [plainMaterials])

  // Built once the city is on screen, nearest first, one landmark per slice; rebuilt per tier.
  useEffect(() => {
    if (!active) return
    let cancelled = false
    const done: BuiltLandmark[] = []
    const failures: string[] = []
    const settingsFor = {
      landTopY: groundY,
      heightScale: config.landmarks.heightScale,
      outlineWidthM: config.landmarks.outlineWidthM,
      outline: config.landmarks.outline,
      windows: config.landmarks.windows,
    }
    camera.getWorldPosition(_anchor)
    const order = [...landmarks].sort(
      (a, b) =>
        Math.hypot(a.frame.anchor.x - _anchor.x, a.frame.anchor.y + _anchor.z) -
        Math.hypot(b.frame.anchor.x - _anchor.x, b.frame.anchor.y + _anchor.z),
    )
    const step = createSlicer(config.buildings.buildSliceMs)
    void (async () => {
      for (const entry of order) {
        await step()
        if (cancelled) break
        if (landmarkSource(entry.id) !== 'kit') continue
        try {
          done.push(buildLandmark(entry.model, entry.frame, tier, palette.landmarks, settingsFor))
        } catch (error) {
          // A model that fails to build is left out; the rest of the map carries on.
          failures.push(entry.id)
          log.warn('Landmark model failed to build', {
            id: entry.id,
            reason: error instanceof Error ? error.message : String(error),
          })
        }
      }
      if (cancelled) {
        for (const model of done) disposeLandmark(model)
        return
      }
      setFailed(failures)
      setBuilt({ tier, models: done })
      invalidate()
    })()
    return () => {
      cancelled = true
    }
  }, [active, landmarks, tier, groundY, config, palette.landmarks, camera, invalidate])

  // Frees the previous tier's geometry once it is replaced (or on unmount).
  useEffect(
    () => () => {
      for (const model of built?.models ?? []) disposeLandmark(model)
    },
    [built],
  )

  const entries = useMemo(() => new Map(landmarks.map((entry) => [entry.id, entry])), [landmarks])

  // Name chips: one mesh, one atlas, built with the models.
  const chips = useMemo(() => {
    if (built === null) return null
    const list: NameChip[] = built.models.flatMap((model) => {
      const entry = entries.get(model.id)
      const text = names[model.id]
      if (entry === undefined || text === undefined) return []
      return [
        {
          x: entry.frame.anchor.x,
          y: entry.frame.anchor.y - config.landmarkChips.offsetM,
          height: groundY + (pinLifts.get(model.id) ?? 0) + config.landmarkChips.liftM,
          text,
        },
      ]
    })
    if (list.length === 0) return null
    const texture = createNameAtlas(
      list.map((chip) => chip.text),
      palette.chip.fill,
      palette.chip.ink,
      config.landmarkChips,
    )
    const material = new MeshBasicMaterial({
      map: texture,
      alphaTest: config.landmarkChips.alphaTest,
    })
    material.color = unlitTint
    const mesh = new Mesh(buildNameChipGeometry(list, config.landmarkChips), material)
    mesh.name = 'landmark-name-chips'
    mesh.raycast = noRaycast
    return { mesh, texture, material, texts: list.map((chip) => chip.text) }
  }, [built, entries, names, pinLifts, groundY, config.landmarkChips, palette.chip, unlitTint])
  useEffect(
    () => () => {
      chips?.mesh.geometry.dispose()
      chips?.material.dispose()
      chips?.texture.dispose()
    },
    [chips],
  )

  // Chips show near the camera target only, like the line letters.
  useEffect(() => {
    if (!(controls instanceof MapControls)) return
    const update = () =>
      setChipsVisible(controls.getDistance() <= config.landmarks.labelMaxDistanceM)
    update()
    controls.addEventListener('change', update)
    return () => controls.removeEventListener('change', update)
  }, [controls, config.landmarks.labelMaxDistanceM])

  useEffect(() => {
    handleRef.current = {
      state: () => {
        const rect = gl.domElement.getBoundingClientRect()
        return {
          tier,
          done: built !== null && built.tier === tier,
          failed: [...failed],
          chips: { visible: chips !== null && chipsVisible, texts: chips?.texts ?? [] },
          landmarks: landmarks.map((entry): LandmarkState => {
            const model = built?.models.find((m) => m.id === entry.id)
            const lod = lods.current.get(entry.id)
            const current = lod?.getCurrentLevel()
            const levels = model?.levels.length ?? 0
            _anchor.set(entry.frame.anchor.x, groundY, -entry.frame.anchor.y).project(camera)
            const onScreen = _anchor.z >= -1 && _anchor.z <= 1
            return {
              id: entry.id,
              source: landmarkSource(entry.id),
              style: entry.style,
              level:
                model === undefined || current === undefined || current >= levels
                  ? null
                  : (model.levels[current]?.level ?? null),
              built: model !== undefined,
              triangles: model?.triangles ?? [],
              lod: landmarkLod(config.landmarks, tier, settings.lodDistanceScale, isBridge(entry)),
              screen: onScreen
                ? {
                    x: rect.left + ((_anchor.x + 1) / 2) * rect.width,
                    y: rect.top + ((1 - _anchor.y) / 2) * rect.height,
                  }
                : null,
              outlineVisible:
                settings.outlines &&
                entry.style === 'normal' &&
                model?.levels[0]?.outline !== undefined,
            }
          }),
        }
      },
    }
    return () => {
      handleRef.current = null
    }
  }, [
    handleRef,
    gl,
    camera,
    tier,
    built,
    failed,
    chips,
    chipsVisible,
    landmarks,
    groundY,
    config.landmarks,
    settings,
  ])

  if (built === null) return null
  return (
    <group name="landmarks">
      {built.models.map((model) => {
        const entry = entries.get(model.id)
        if (entry === undefined) return null
        const lod = landmarkLod(config.landmarks, tier, settings.lodDistanceScale, isBridge(entry))
        const teaser = entry.style === 'teaser'
        const set =
          isNightGlowExcluded(entry.category) && plainMaterials !== null
            ? plainMaterials
            : materials
        return (
          <Detailed
            key={model.id}
            ref={(object: LOD | null) => {
              if (object === null) lods.current.delete(model.id)
              else lods.current.set(model.id, object)
            }}
            name={`landmark-${model.id}`}
            position={[entry.frame.anchor.x, 0, -entry.frame.anchor.y]}
            distances={[...lod.distances.slice(0, model.levels.length), lod.cullM]}
            hysteresis={config.landmarks.hysteresis}
          >
            {[
              ...model.levels.map((level) => (
                <group key={level.level} name={`landmark-${model.id}-l${level.level}`}>
                  <mesh
                    geometry={level.body}
                    material={teaser ? set.dimmed : set.body}
                    raycast={noRaycast}
                  />
                  {level.windows !== undefined && !teaser ? (
                    <mesh geometry={level.windows} material={set.windows} raycast={noRaycast} />
                  ) : null}
                  {level.outline !== undefined && !teaser ? (
                    <mesh
                      geometry={level.outline}
                      material={set.outline}
                      visible={settings.outlines}
                      raycast={noRaycast}
                    />
                  ) : null}
                </group>
              )),
              // Beyond the cull distance the landmark draws nothing.
              <group key="culled" name={`landmark-${model.id}-culled`} />,
            ]}
          </Detailed>
        )
      })}
      {chips !== null ? <primitive object={chips.mesh} visible={chipsVisible} /> : null}
    </group>
  )
}
