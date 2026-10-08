/**
 * The lighting for the personal game clock's minute (S04f), as a value whose identity changes
 * only when the lighting does: during a keyframe's hold (and in step mode, under reduced motion)
 * every minute maps to the keyframe itself, so readers that depend on it neither re-render the
 * scene nor redraw it.
 */
import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { lightingAt } from '@/lib/dayNight/lightingAt'
import type { DayNightModel, Lighting } from '@/lib/dayNight/types'
import { useReducedMotion } from '@/lib/useReducedMotion'
import { dayClockStore } from '@/state/dayClock'

/**
 * The minute whose lighting stands for `minute`'s: the keyframe's own minute while it shows
 * unblended, else the quantised minute. Equal results mean equal lighting.
 */
export function canonicalMinute(minute: number, model: DayNightModel, step: boolean): number {
  const lighting = lightingAt(minute, model, { step })
  if (lighting.t !== 0) return lighting.minute
  const keyframe = model.keyframes.find((entry) => entry.id === lighting.keyframe)
  return keyframe === undefined ? lighting.minute : keyframe.atMinute
}

/**
 * `unknownMinute` stands in until the HUD has read the save. The caller subscribes to the
 * canonical minute, not the clock's: the clock ticks every game minute, and a re-render of the
 * canvas's React tree makes react-three-fiber draw a frame, so an idle map would draw one per
 * game minute.
 */
export function useDayNightLighting(model: DayNightModel, unknownMinute: number): Lighting {
  const step = useReducedMotion()
  const canonicalNow = useCallback(
    () => canonicalMinute(dayClockStore.getState().minuteOfDay ?? unknownMinute, model, step),
    [model, step, unknownMinute],
  )
  const serverCanonical = useCallback(
    () => canonicalMinute(unknownMinute, model, step),
    [model, step, unknownMinute],
  )
  const canonical = useSyncExternalStore(dayClockStore.subscribe, canonicalNow, serverCanonical)
  return useMemo(() => lightingAt(canonical, model, { step }), [canonical, model, step])
}
