/**
 * Which day/night keyframe (S04f) a personal-clock minute falls in, for copy that names the light
 * ("at golden hour", "after dark"): the last keyframe reached that day, wrapping past midnight.
 *
 * Client code: it reads scene.json directly (validated by the scene config schema in
 * src/lib/data/data.test.ts), taking only each keyframe's id and start, so the copy and the sky
 * always agree on the time of day.
 */
import sceneJson from '@data/config/scene.json'
import { MINUTES_PER_DAY, type KeyframeId } from './types'

const starts: readonly { readonly id: KeyframeId; readonly atMinute: number }[] =
  sceneJson.dayNight.keyframes.map((keyframe) => ({
    id: keyframe.id as KeyframeId,
    atMinute: keyframe.atMinute,
  }))

/** The keyframe in force at personal-clock `minute` (any minute; days wrap). */
export function keyframeOfDay(minute: number): KeyframeId {
  const ofDay = ((Math.floor(minute) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY
  const last = starts[starts.length - 1]
  if (last === undefined) throw new Error('scene.json dayNight has no keyframes')
  let current = last
  for (const entry of starts) if (entry.atMinute <= ofDay) current = entry
  return current.id
}
