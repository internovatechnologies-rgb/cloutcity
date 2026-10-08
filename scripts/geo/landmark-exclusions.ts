/**
 * INT-7: landmark models (S07a) replace the real building under them, so district footprints
 * whose centroid falls inside a landmark's `exclusion` rectangle are dropped. The rectangles are
 * the `landmarks[].exclusion` of the frames file (data/landmarks/frames.derived.json), which the
 * same geo build derives just before the districts (INT-8), so a rebuild never reads a stale file.
 *
 * Only the `exclusion` of each frame is read; the rest of the file belongs to S07a. Frames that do
 * not match fail the build rather than silently excluding nothing.
 */
import { z } from 'zod'
import type { LocalPoint } from '../../src/lib/geo/projection.ts'

/** A rotated rectangle in local metres: centre, half extents, and the long axis's angle. */
export const LandmarkExclusionSchema = z.strictObject({
  x: z.number(),
  y: z.number(),
  halfLengthM: z.number().positive(),
  halfWidthM: z.number().positive(),
  /** Degrees counter-clockwise from east to the rectangle's length axis. */
  angleDeg: z.number(),
})
export type LandmarkExclusion = z.infer<typeof LandmarkExclusionSchema>

const FramesSchema = z.object({
  landmarks: z.array(z.object({ exclusion: LandmarkExclusionSchema })),
})

export const FRAMES_PATH = 'landmarks/frames.derived.json'

/** The exclusion rectangle of every landmark in a frames file. */
export function readLandmarkExclusions(json: unknown): LandmarkExclusion[] {
  const result = FramesSchema.safeParse(json)
  if (!result.success) {
    throw new Error(`Invalid data/${FRAMES_PATH} (INT-7):\n${z.prettifyError(result.error)}`)
  }
  return result.data.landmarks.map((frame) => frame.exclusion)
}

export function insideExclusion(point: LocalPoint, rect: LandmarkExclusion): boolean {
  const angle = (rect.angleDeg * Math.PI) / 180
  const dx = point.x - rect.x
  const dy = point.y - rect.y
  const along = dx * Math.cos(angle) + dy * Math.sin(angle)
  const across = -dx * Math.sin(angle) + dy * Math.cos(angle)
  return Math.abs(along) <= rect.halfLengthM && Math.abs(across) <= rect.halfWidthM
}

export const insideAnyExclusion = (point: LocalPoint, rects: readonly LandmarkExclusion[]) =>
  rects.some((rect) => insideExclusion(point, rect))
