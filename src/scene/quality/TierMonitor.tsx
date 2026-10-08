'use client'

/**
 * The runtime step-down (S04b, CLAUDE.md: one tier down when average FPS stays below the floor
 * for `sustainMs`, with hysteresis; never an automatic step up). drei's PerformanceMonitor
 * samples FPS over `sampleMs` windows; a decline (more than `threshold` of the
 * `sustainMs / sampleMs` windows below `belowFps`) goes through stepDecision, and the quality
 * store records a step-down when it allows one.
 *
 * PerformanceMonitor counts frames over wall time, and the map renders on demand, so it runs
 * only inside the continuous window (continuity.ts): while a gesture or a flight is under way
 * the monitor requests every frame, and it restarts from scratch each time the window opens, so
 * idle time never reads as a low frame rate. Outside the window the map stays idle, and the
 * monitor is off altogether while no step-down is possible (canStepDown: the low tier, a
 * settings choice, data saver, or the session's step limit reached).
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { PerformanceMonitor } from '@react-three/drei'
import { useFrame, useThree } from '@react-three/fiber'
import type { FpsStepDown } from '@/lib/data/schemas/config'
import { qualityStore } from '@/state/quality'
import { continuousSince, subscribeContinuous } from './continuity'
import { canStepDown, onMonitorDecline } from './decline'

const serverSince = () => null
const serverArmed = () => false

export function TierMonitor({
  stepDown,
  paused = false,
}: {
  readonly stepDown: FpsStepDown
  /** The map is off screen (the apartment has it, S16): never measure or force frames. */
  readonly paused?: boolean
}) {
  const invalidate = useThree((state) => state.invalidate)
  const since = useSyncExternalStore(subscribeContinuous, continuousSince, serverSince)
  const armedNow = useCallback(() => canStepDown(qualityStore.getState(), stepDown), [stepDown])
  const armed = useSyncExternalStore(qualityStore.subscribe, armedNow, serverArmed)
  const measuring = armed && since !== null && !paused

  // Inside the window every frame requests the next, so FPS reflects the device rather than
  // how often input arrives.
  useFrame(() => {
    if (!paused && continuousSince() !== null && armedNow()) invalidate()
  })
  useEffect(() => {
    if (measuring) invalidate()
  }, [measuring, invalidate])

  const onDecline = useCallback(
    () => onMonitorDecline(qualityStore, stepDown, performance.now()),
    [stepDown],
  )
  const bounds = useCallback((): [number, number] => [stepDown.belowFps, Infinity], [stepDown])

  if (!measuring) return null
  return (
    <PerformanceMonitor
      // A new window starts a new measurement.
      key={since}
      ms={stepDown.sampleMs}
      iterations={stepDown.sustainMs / stepDown.sampleMs}
      threshold={stepDown.threshold}
      bounds={bounds}
      onDecline={onDecline}
    />
  )
}
