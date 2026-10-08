'use client'

/**
 * The 3D chunk's entry (loaded with next/dynamic, ssr: false, from CitySceneClient): the
 * react-three-fiber canvas with the city, place pins, the player's avatar, lights, camera rig and
 * test hooks. Renders on demand only, so an idle map draws zero frames, and none at all while
 * the apartment has the screen (src/state/sceneFocus.ts).
 *
 * Quality tiers (S04b): the active tier (src/state/quality.ts) sets the DPR cap, outlines and
 * shadows live, and antialiasing when the WebGL context is created; TierMonitor steps it down
 * when the frame rate stays low. The city is built (yielding to the browser) before the canvas
 * mounts, and its shaders compile before its first frame (PERF-4).
 *
 * The light follows the personal game clock (S04f, lighting/DayNightRig.tsx): the rig wraps the
 * scene so every glowing material reads its shared night-glow uniform.
 *
 * A lost WebGL context (S04c) is restored in place: three re-creates its GL state when the
 * browser restores the context, so the canvas is never remounted; this only reports the loss
 * and, after the first frame drawn again, the recovery.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Group } from 'three'
import { addAfterEffect, Canvas, useFrame, useThree } from '@react-three/fiber'
import { PCFShadowMap } from 'three'
import { joinSkyColors } from '@/lib/dayNight/joinSky'
import { PLAYABLE_MARK, perfMark } from '@/lib/perfMarks'
import { usePlayerHome } from '@/state/playerHome'
import { useSceneFocus } from '@/state/sceneFocus'
import { usePlayerSpot } from '@/state/trip'
import { useActiveTier } from '@/state/quality'
import { PlayerAvatar } from './avatar/PlayerAvatar'
import { CameraRig } from './camera/CameraRig'
import { FreeRowFraming } from './camera/FreeRowFraming'
import { nearFar } from './camera/limits'
import { Buildings, type BuildingsHandle } from './buildings/Buildings'
import { buildCity, City, type CityObjects } from './City'
import { landTopY } from './geo/buildLand'
import type { GeoLoadFailure } from './geo/load'
import { safeParseGeoBase } from './geo/schema'
import { Landmarks, type LandmarksHandle } from './landmarks/Landmarks'
import { ReleaseProgramsOnShadowChange } from './quality/releasePrograms'
import { TierMonitor } from './quality/TierMonitor'
import { TierSettingsContext, type ActiveTierSettings } from './quality/tierSettings'
import { yieldToMain } from './schedule'
import { DayNightRig } from './lighting/DayNightRig'
import { createDayNightUniforms } from './lighting/nightGlow'
import { useDayNightLighting } from './lighting/useDayNightLighting'
import { TestHooks } from './testHooks'
import { TravelAnimator } from './travel/TravelAnimator'
import type { SceneProps } from './types'

perfMark('cc:3d:chunk')

// R3F turns a boolean `shadows` into PCFSoftShadowMap, which three 0.182 deprecates with a
// console warning (and CLAUDE.md never allows): both values name PCFShadowMap explicitly.
const SHADOWS_ON = { enabled: true, type: PCFShadowMap }
const SHADOWS_OFF = { enabled: false, type: PCFShadowMap }

const GL = {
  alpha: false,
  stencil: false,
  powerPreference: 'high-performance',
} as const

export interface CityCanvasProps extends Pick<
  SceneProps,
  | 'palette'
  | 'skyColors'
  | 'config'
  | 'homesLocal'
  | 'startHome'
  | 'boundsLocal'
  | 'quality'
  | 'buildings'
  | 'travelAnimation'
  | 'playerModel'
> {
  /**
   * The downloaded geo body, validated here before the canvas mounts; null while it downloads
   * (the chunk is rendered early so it loads in parallel, and renders nothing until then).
   */
  readonly geo: { readonly body: unknown } | null
  /** Called (once) instead of mounting the canvas when the body fails the schema. */
  readonly onInvalidGeo: (failure: GeoLoadFailure) => void
  readonly label: string
  /** The "expanding soon" chip text, rendered by the server. */
  readonly expandingSoon: string
  /** Landmark name chip text by id, rendered by the server (S07a). */
  readonly landmarkNames: Readonly<Record<string, string>>
  readonly onReady: () => void
  /** The WebGL context was lost: the map shows nothing until it is restored. */
  readonly onContextLost: () => void
  /** A frame has drawn again after the context came back. */
  readonly onContextRestored: () => void
}

function ContextWatcher({
  onLost,
  onRestored,
}: {
  readonly onLost: () => void
  readonly onRestored: () => void
}) {
  const gl = useThree((state) => state.gl)
  const invalidate = useThree((state) => state.invalidate)
  const restored = useRef(false)

  useEffect(() => {
    const canvas = gl.domElement
    // three's renderer listens first and calls preventDefault(), which is what lets the browser
    // restore the context at all.
    const lost = () => {
      restored.current = false
      onLost()
    }
    const back = () => {
      restored.current = true
      invalidate()
    }
    canvas.addEventListener('webglcontextlost', lost)
    canvas.addEventListener('webglcontextrestored', back)
    return () => {
      canvas.removeEventListener('webglcontextlost', lost)
      canvas.removeEventListener('webglcontextrestored', back)
    }
  }, [gl, invalidate, onLost])

  useFrame(() => {
    if (!restored.current) return
    restored.current = false
    onRestored()
  })

  return null
}

/** Draws one frame when the map gets the screen back from the apartment (S16). */
function FocusRedraw({ hidden }: { readonly hidden: boolean }) {
  const invalidate = useThree((state) => state.invalidate)
  useEffect(() => {
    if (!hidden) invalidate()
  }, [hidden, invalidate])
  return null
}

/**
 * Marks the first frame that has drawn the city with the player's avatar placed: the map is
 * playable (`cc:playable`, timed by `npm run e2e:perf`). Runs after each frame is rendered.
 */
function PlayableMark({
  readyRef,
  placedRef,
}: {
  readonly readyRef: { readonly current: boolean }
  readonly placedRef: { readonly current: boolean }
}) {
  useEffect(() => {
    const stop = addAfterEffect(() => {
      if (!readyRef.current || !placedRef.current) return
      perfMark('cc:3d:first-frame')
      perfMark(PLAYABLE_MARK)
      stop()
    })
    return stop
  }, [readyRef, placedRef])
  return null
}

export default function CityCanvas({ geo, ...props }: CityCanvasProps) {
  return geo === null ? null : <CityScene3D geoBody={geo.body} {...props} />
}

type CityScene3DProps = Omit<CityCanvasProps, 'geo'> & { readonly geoBody: unknown }

/** The canvas itself, mounted once the geo body has arrived and the device's tier is known. */
function CityScene3D({
  geoBody,
  onInvalidGeo,
  palette,
  skyColors,
  config,
  homesLocal,
  startHome,
  boundsLocal,
  quality,
  buildings,
  travelAnimation,
  playerModel,
  label,
  expandingSoon,
  landmarkNames,
  onReady,
  onContextLost,
  onContextRestored,
}: CityScene3DProps) {
  perfMark('cc:3d:mount')
  const readyRef = useRef(false)
  // While the apartment has the screen (S16) the map draws nothing and is hidden.
  const hidden = useSceneFocus() === 'room'
  const placedRef = useRef(false)
  // The camera starts over the player's home and the avatar stands there (S05); after a trip
  // (S08) the avatar stands at the place's pin.
  const home = homesLocal[usePlayerHome() ?? startHome]
  const spot = usePlayerSpot()
  const avatarRef = useRef<Group | null>(null)
  const cityRef = useRef<CityObjects | null>(null)
  const buildingsRef = useRef<BuildingsHandle | null>(null)
  const landmarksRef = useRef<LandmarksHandle | null>(null)
  // District buildings and landmark models start after the city's first frame (PERF-4).
  const [cityReady, setCityReady] = useState(false)
  // The shell records the device's tier before mounting the canvas; low until then.
  const tier = useActiveTier() ?? 'low'
  const settings: ActiveTierSettings = useMemo(
    () => ({ tier, ...quality.tiers[tier] }),
    [tier, quality.tiers],
  )
  // Antialiasing is fixed when the WebGL context is created: a change applies on the next load.
  const [gl] = useState(() => ({ ...GL, antialias: settings.antialias }))
  // Validated outside the R3F root and without throwing: an invalid body is an expected
  // failure, reported to the shell instead of reaching React's error logging.
  const parsed = useMemo(() => {
    const result = safeParseGeoBase(geoBody)
    perfMark('cc:3d:parsed')
    return result
  }, [geoBody])
  useEffect(() => {
    if (!parsed.ok) onInvalidGeo({ reason: 'geo-invalid', paths: parsed.paths })
  }, [parsed, onInvalidGeo])

  const pinLifts = useMemo(
    () =>
      new Map(
        parsed.ok ? parsed.geo.places.pins.map((pin) => [pin.id, pin.liftM ?? 0] as const) : [],
      ),
    [parsed],
  )

  // One set for the scene's life: the city build, the rig and every glowing material share it.
  const [dayNightUniforms] = useState(createDayNightUniforms)
  const dayNight = useMemo(
    () => joinSkyColors(config.dayNight, skyColors),
    [config.dayNight, skyColors],
  )
  const lighting = useDayNightLighting(dayNight, config.dayNight.unknownMinute)

  // Built before the canvas mounts, yielding between layers (PERF-4). A build error is
  // rethrown during render so the scene's error boundary handles it like any scene failure.
  const [built, setBuilt] = useState<CityObjects | Error | null>(null)
  useEffect(() => {
    if (!parsed.ok) return
    let active = true
    let city: CityObjects | null = null
    buildCity(parsed.geo, palette, config, expandingSoon, yieldToMain, dayNightUniforms).then(
      (result) => {
        if (!active) {
          result.dispose()
          return
        }
        perfMark('cc:3d:built')
        city = result
        setBuilt(result)
      },
      (error: unknown) => {
        if (active) setBuilt(error instanceof Error ? error : new Error('city build failed'))
      },
    )
    return () => {
      active = false
      city?.dispose()
      setBuilt(null)
    }
  }, [parsed, palette, config, expandingSoon, dayNightUniforms])
  const placeId = spot?.kind === 'place' ? spot.placeId : null
  const rest = useMemo(() => {
    if (placeId === null || built === null || built instanceof Error) return home
    const ground = built.pins.groundOf(placeId)
    return ground === null ? home : { x: ground.x, y: -ground.z }
  }, [placeId, built, home])
  if (built instanceof Error) throw built

  const { camera } = config
  const groundY = landTopY(config.land)
  const clip = nearFar(camera.distanceM, camera)
  const shadows = settings.shadows === 'pcf-directional'

  if (!parsed.ok || built === null) return null

  return (
    <div
      role="img"
      aria-label={label}
      data-cc-feature="cc-feature:city-scene"
      data-scene-hidden={hidden ? '' : undefined}
      data-quality-tier={tier}
      className={`absolute inset-0 ${hidden ? 'invisible' : ''}`}
    >
      <Canvas
        frameloop={hidden ? 'never' : 'demand'}
        dpr={[1, settings.dprCap]}
        flat
        shadows={shadows ? SHADOWS_ON : SHADOWS_OFF}
        gl={gl}
        camera={{ fov: camera.fovDeg, near: clip.near, far: clip.far }}
        onCreated={() => perfMark('cc:3d:gl')}
      >
        <TierSettingsContext value={settings}>
          <DayNightRig
            lighting={lighting}
            uniforms={dayNightUniforms}
            target={built}
            fog={config.dayNight.fog}
            lights={config.lights}
            distanceM={camera.distanceM}
            shadowMapSizePx={shadows ? settings.shadowMapSizePx : 0}
          >
            <CameraRig camera={camera} start={rest} bounds={boundsLocal} groundY={groundY} />
            <FreeRowFraming />
            <City
              city={built}
              config={config}
              outlines={settings.outlines}
              cityRef={cityRef}
              onReady={() => {
                readyRef.current = true
                setCityReady(true)
                onReady()
              }}
            />
            <Buildings
              assets={buildings}
              palette={palette}
              config={config}
              groundY={groundY}
              gradientMap={built.gradientMap}
              dimmedBoroughs={built.dimmed}
              active={cityReady}
              handleRef={buildingsRef}
            />
            <Landmarks
              landmarks={parsed.geo.landmarks.models}
              palette={palette}
              config={config}
              groundY={groundY}
              gradientMap={built.gradientMap}
              active={cityReady}
              names={landmarkNames}
              pinLifts={pinLifts}
              handleRef={landmarksRef}
            />
            <PlayerAvatar
              at={rest}
              groupRef={avatarRef}
              groundY={groundY}
              color={palette.player}
              toonRamp={palette.toonRamp}
              avatar={config.avatar}
              model={playerModel}
              models={config.models}
              tier={tier}
              loadModel={cityReady}
              onPlaced={() => {
                placedRef.current = true
              }}
            />
            <TravelAnimator
              avatarRef={avatarRef}
              groundY={groundY}
              palette={palette.travel}
              gradientMap={built.gradientMap}
              config={config.travel}
              avatar={config.avatar}
              animation={travelAnimation}
              enabled={cityReady && !hidden}
              trail={tier !== 'low' || config.travel.trailOnLow}
            />
            <PlayableMark readyRef={readyRef} placedRef={placedRef} />
            {/* The apartment has the screen: nothing to measure, no frames forced. */}
            <TierMonitor stepDown={quality.stepDown} paused={hidden} />
            <ReleaseProgramsOnShadowChange
              shadowKey={shadows ? `pcf:${settings.shadowMapSizePx}` : 'off'}
              shadowsOn={shadows}
            />
            <FocusRedraw hidden={hidden} />
            <ContextWatcher onLost={onContextLost} onRestored={onContextRestored} />
            <TestHooks
              readyRef={readyRef}
              cityRef={cityRef}
              buildingsRef={buildingsRef}
              landmarksRef={landmarksRef}
              quality={quality}
              lighting={lighting}
            />
          </DayNightRig>
        </TierSettingsContext>
      </Canvas>
    </div>
  )
}
