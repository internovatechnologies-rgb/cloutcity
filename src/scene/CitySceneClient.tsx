'use client'

/**
 * The shell side of the 3D map: a static background, the scene status, and the lazily loaded
 * canvas. The canvas is a `next/dynamic` import with `ssr: false`, so the shell (HUD, tabs) is
 * interactive before the 3D chunk arrives. Before the canvas mounts, the shell checks for WebGL2
 * and downloads and validates the geo layers (in parallel with the 3D chunk); an expected
 * failure (no WebGL, a failed or invalid download) shows the error status with one structured
 * warning, and nothing throws into React.
 *
 * Whenever the 3D map is unavailable (an error, or a lost WebGL context until the browser
 * restores it, S04c) the static stylised map (/geo/fallback) shows instead and the Places panel
 * opens by itself, without taking focus, so the game stays playable (A11Y-3).
 */
import dynamic from 'next/dynamic'
import { useCallback, useEffect, useRef, useState } from 'react'
import { modalStore } from '@/components/overlay/modalState'
import { log } from '@/lib/log'
import { perfMark } from '@/lib/perfMarks'
import { markMapPlayable } from '@/state/mapPlayable'
import { autoOpenPlacesPanel, closeAutoPlacesPanel } from '@/state/placesPanel'
import { loadGeoBase, registerGeoBaseUrl, type GeoLoadFailure } from './geo/load'
import { SCENE_FAILED_MESSAGE, SceneErrorBoundary } from './SceneErrorBoundary'
import type { SceneFailure, SceneProps, SceneStatus } from './types'
import { whenIdle } from './schedule'
import { probeDevice } from './webgl'

const CityCanvas = dynamic(() => import('./CityCanvas'), { ssr: false })
/** Runs `callback` once the modal slot's island has decided (at once if it has). */
function whenModalSettled(callback: () => void): () => void {
  if (modalStore.getState().settled) {
    callback()
    return () => undefined
  }
  const off = modalStore.subscribe((state) => {
    if (!state.settled) return
    off()
    callback()
  })
  return off
}

const loadQualityStore = () => import('@/state/quality').then((module) => module.qualityStore)

type SceneState =
  /**
   * `preload`: the device has WebGL2, so the 3D chunk is rendered (it renders nothing yet) to
   * download alongside the geo layers instead of after them.
   */
  | { readonly status: 'loading'; readonly preload: boolean }
  /**
   * Geo downloaded: the 3D chunk validates it, then mounts the canvas; `drawn` after frame 1;
   * `lost` while the WebGL context is lost.
   */
  | {
      readonly status: 'starting'
      readonly body: unknown
      readonly drawn: boolean
      readonly lost: boolean
    }
  | { readonly status: 'error'; readonly failure: SceneFailure }

export function CitySceneClient(props: SceneProps) {
  const [state, setState] = useState<SceneState>({ status: 'loading', preload: false })
  const { geoUrl, copy, overlayRows, freeRow } = props

  const { picker } = props.quality
  const { idleTimeoutMs } = props.config.startup
  useEffect(() => {
    // Travel reads the subway and land layers from the same body, with or without WebGL.
    registerGeoBaseUrl(geoUrl)
    let active = true
    let cancelStart = () => undefined as void
    const fail = (failure: SceneFailure, context: Record<string, unknown>) => {
      if (!active) return
      log.warn(SCENE_FAILED_MESSAGE, context)
      setState({ status: 'error', failure })
    }
    // Probe and download run after this effect returns (the result arrives in a callback).
    void Promise.resolve().then(async () => {
      perfMark('cc:3d:start')
      const device = probeDevice(picker)
      perfMark('cc:3d:probed')
      // The quality store is not shell code (it persists the settings choice): it loads in its
      // own chunk, and every device records its pick, so audio and settings see it even when
      // the map cannot start.
      const detected = loadQualityStore().then(
        (store) => {
          store.getState().setDetected(device.pick, device.dataSaver)
          return true
        },
        () => false,
      )
      if (!device.signals.webgl2) {
        // Recorded before the map counts as playable, which is when audio reads the tier.
        await detected
        fail('device', { reason: 'no-webgl' })
        return
      }
      // The 3D chunk starts downloading alongside the geo layers, once the boot hold has settled
      // (the welcome card goes first; the chunk is the page's largest).
      const stopPreload = whenModalSettled(() => {
        if (!active) return
        setState((current) =>
          current.status === 'loading' ? { status: 'loading', preload: true } : current,
        )
      })
      cancelStart = stopPreload
      const [result, stored] = await Promise.all([loadGeoBase(geoUrl), detected])
      if (!active) return
      perfMark('cc:3d:geo')
      if (!result.ok) {
        fail('load', { ...result.failure })
        return
      }
      if (!stored) {
        fail('load', { reason: 'chunk-failed', chunk: 'quality' })
        return
      }
      // Mounting the canvas is the page's heaviest task: let the shell and the other islands
      // finish their own start-up first.
      stopPreload()
      cancelStart = whenIdle(() => {
        if (active) setState({ status: 'starting', body: result.body, drawn: false, lost: false })
      }, idleTimeoutMs)
    })
    return () => {
      active = false
      cancelStart()
    }
  }, [geoUrl, picker, idleTimeoutMs])

  const onReady = useCallback(
    () =>
      setState((current) =>
        current.status === 'starting' ? { ...current, drawn: true } : current,
      ),
    [],
  )
  const onInvalidGeo = useCallback((failure: GeoLoadFailure) => {
    log.warn(SCENE_FAILED_MESSAGE, { ...failure })
    setState({ status: 'error', failure: 'load' })
  }, [])
  const onError = useCallback(() => setState({ status: 'error', failure: 'load' }), [])
  // Expected conditions (a GPU reset, a backgrounded tab), so info, not warn.
  const onContextLost = useCallback(() => {
    log.info('3D map context lost; showing the Places panel')
    setState((current) => (current.status === 'starting' ? { ...current, lost: true } : current))
  }, [])
  const onContextRestored = useCallback(() => {
    setState((current) =>
      current.status === 'starting' && current.lost
        ? { ...current, lost: false, drawn: true }
        : current,
    )
  }, [])

  const status: SceneStatus =
    state.status === 'error'
      ? 'error'
      : state.status === 'starting' && state.lost
        ? 'lost'
        : state.status === 'starting' && state.drawn
          ? 'ready'
          : 'loading'
  // Drawn or failed, the map is as playable as it gets (on failure the Places panel takes
  // over), so audio may start loading (src/state/mapPlayable.ts).
  useEffect(() => {
    if (status !== 'loading') markMapPlayable()
  }, [status])
  // Travel's routes (S08): built once the browser is idle after the map is playable, from the
  // geo body already downloaded, so the first "Get there" rows rarely wait. Its own chunk.
  const playable = status !== 'loading'
  useEffect(() => {
    if (!playable) return
    return whenIdle(() => {
      // The whole travel chunk (the place sheet's "Get there" rows load the same module).
      import('@/state/tripDriver').then(
        (module) => void module.ensureTransitWorld(),
        // Offline before the chunk was cached: the place sheet loads it again when needed.
        () => log.info('Travel routes could not be prepared yet'),
      )
    }, idleTimeoutMs)
  }, [playable, idleTimeoutMs])

  const unavailable = status === 'error' || status === 'lost'
  const previousStatus = useRef<SceneStatus>('loading')
  useEffect(() => {
    const previous = previousStatus.current
    previousStatus.current = status
    if (status === 'error' || status === 'lost') autoOpenPlacesPanel()
    else if (status === 'ready' && previous === 'lost') {
      log.info('3D map context restored')
      closeAutoPlacesPanel()
    }
  }, [status])

  const message =
    state.status === 'error'
      ? state.failure === 'device'
        ? copy.errorDevice
        : copy.errorLoad
      : status === 'lost'
        ? copy.lost
        : status === 'loading'
          ? copy.loading
          : ''

  return (
    <div data-scene-root="" data-scene-status={status} className="absolute inset-0">
      <div aria-hidden="true" className="absolute inset-0 bg-canvas" />
      {state.status === 'starting' || (state.status === 'loading' && state.preload) ? (
        <SceneErrorBoundary onError={onError}>
          <CityCanvas
            geo={state.status === 'starting' ? { body: state.body } : null}
            onInvalidGeo={onInvalidGeo}
            palette={props.palette}
            skyColors={props.skyColors}
            config={props.config}
            homesLocal={props.homesLocal}
            startHome={props.startHome}
            boundsLocal={props.boundsLocal}
            quality={props.quality}
            buildings={props.buildings}
            travelAnimation={props.travelAnimation}
            playerModel={props.playerModel}
            label={copy.label}
            expandingSoon={copy.expandingSoon}
            landmarkNames={copy.landmarkNames}
            onReady={onReady}
            onContextLost={onContextLost}
            onContextRestored={onContextRestored}
          />
        </SceneErrorBoundary>
      ) : null}
      {unavailable ? (
        // Above the (paused) canvas: a lost context leaves its last frame or a blank behind.
        <div
          role="img"
          aria-label={copy.fallback}
          data-scene-fallback=""
          className="absolute inset-0 bg-canvas bg-cover bg-center"
          style={{ backgroundImage: `url(${JSON.stringify(props.fallbackUrl)})` }}
        />
      ) : null}
      <div
        className="pointer-events-none absolute inset-0 grid grid-cols-1"
        style={{ gridTemplateRows: overlayRows }}
      >
        <p
          role="status"
          // The camera frames its target at this row's centre (camera/FreeRowFraming.tsx).
          data-free-scene-row=""
          className="flex min-h-0 items-center justify-center px-4 text-center text-sm font-semibold text-muted"
          style={{ gridRow: freeRow }}
        >
          {message}
        </p>
      </div>
    </div>
  )
}
