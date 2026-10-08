/**
 * The travel animation as a pure timeline: real milliseconds since the animation started to the
 * avatar's position on the route and how far the personal clock has fast-forwarded.
 *
 * The whole trip plays in `min(animation.maxMs, durationMin * animation.msPerGameMinute)`, and
 * each leg gets a share proportional to its game minutes, so a long ride never runs past the
 * cap. Within a subway leg the avatar holds at the platform for the wait, then rides along the
 * line path. With reduced motion the timeline has zero length: every query is the arrival
 * (an instant cut, CLAUDE.md "Art direction").
 */
import type { LocalPoint } from '@/lib/geo/projection'
import type { TransitConfig } from './config'
import type { Route, TravelMode } from './plan'
import { measurePath, pointAtArc, type MeasuredPath } from './polyline'

export interface TimelineOptions {
  readonly reducedMotion: boolean
  readonly animation: TransitConfig['animation']
}

export interface TimelineFrame {
  readonly point: LocalPoint
  readonly legIndex: number
  readonly mode: TravelMode
  /** True while holding at a subway platform. */
  readonly waiting: boolean
  /** Game minutes elapsed on the personal clock, 0..route.durationMin (fractional). */
  readonly gameMinutes: number
  readonly done: boolean
}

export interface Timeline {
  /** Real milliseconds the animation lasts; 0 means cut straight to the arrival. */
  readonly durationMs: number
  /** Start and end of each leg, in real milliseconds. */
  readonly legs: readonly { readonly startMs: number; readonly endMs: number }[]
  frameAt(elapsedMs: number): TimelineFrame
}

interface Span {
  readonly legIndex: number
  readonly mode: TravelMode
  readonly startMs: number
  readonly endMs: number
  /** Fraction of the leg spent holding still before moving. */
  readonly holdFraction: number
  readonly path: MeasuredPath
  readonly startMinutes: number
  readonly minutes: number
}

/** Thrown for a route no animation can be made of (a non-finite or negative duration). */
export class TimelineError extends RangeError {
  readonly code = 'INVALID_ROUTE'
}

export function createTimeline(route: Route, options: TimelineOptions): Timeline {
  const badLeg = route.legs.some((leg) => !Number.isFinite(leg.minutes) || leg.minutes < 0)
  if (!Number.isFinite(route.durationMin) || route.durationMin < 0 || badLeg) {
    throw new TimelineError(`route duration must be finite and non-negative: ${route.durationMin}`)
  }
  const durationMs = options.reducedMotion
    ? 0
    : Math.min(
        options.animation.maxMs,
        Math.max(0, route.durationMin * options.animation.msPerGameMinute),
      )
  const legMinutes = route.legs.reduce((sum, leg) => sum + leg.minutes, 0)
  // Leg minutes are fractional and the route rounds up (and the clock may run slower when a
  // stat is at zero), so game time is spread over the legs in proportion.
  const minuteScale = legMinutes > 0 ? route.durationMin / legMinutes : 0

  const spans: Span[] = []
  let cursorMs = 0
  let cursorMin = 0
  route.legs.forEach((leg, legIndex) => {
    const share = legMinutes > 0 ? leg.minutes / legMinutes : 1 / route.legs.length
    const isLast = legIndex === route.legs.length - 1
    const endMs = isLast ? durationMs : cursorMs + share * durationMs
    const minutes = leg.minutes * minuteScale
    const holdFraction = leg.mode === 'subway' && leg.minutes > 0 ? leg.waitMin / leg.minutes : 0
    spans.push({
      legIndex,
      mode: leg.mode,
      startMs: cursorMs,
      endMs,
      holdFraction,
      path: measurePath(leg.polyline.length > 0 ? leg.polyline : [leg.from, leg.to]),
      startMinutes: cursorMin,
      minutes,
    })
    cursorMs = endMs
    cursorMin += minutes
  })

  const arrival = (): TimelineFrame => {
    const last = spans[spans.length - 1]
    return {
      point: route.to,
      legIndex: last?.legIndex ?? 0,
      mode: last?.mode ?? route.mode,
      waiting: false,
      gameMinutes: route.durationMin,
      done: true,
    }
  }

  return {
    durationMs,
    legs: spans.map(({ startMs, endMs }) => ({ startMs, endMs })),
    frameAt(elapsedMs: number): TimelineFrame {
      if (!(elapsedMs < durationMs)) return arrival()
      const t = Math.max(0, elapsedMs)
      const span = spans.find((candidate) => t < candidate.endMs) ?? spans[spans.length - 1]
      if (span === undefined) return arrival()
      const length = span.endMs - span.startMs
      const legT = length > 0 ? (t - span.startMs) / length : 1
      const moveT =
        span.holdFraction >= 1
          ? 0
          : Math.max(0, (legT - span.holdFraction) / (1 - span.holdFraction))
      return {
        point: pointAtArc(span.path, moveT * span.path.lengthM),
        legIndex: span.legIndex,
        mode: span.mode,
        waiting: legT < span.holdFraction,
        gameMinutes: span.startMinutes + legT * span.minutes,
        done: false,
      }
    },
  }
}
