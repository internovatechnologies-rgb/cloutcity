'use client'

/**
 * Frames the map so the camera target, where the player's avatar stands and where a flight to
 * a place lands (S04c `focusPose`), sits at the centre of the free scene row instead of the
 * canvas centre (S05). On a phone the canvas centre falls in the toast zone, so a level-up toast
 * would cover the player.
 *
 * The canvas spans the whole screen under the overlay; `camera.setViewOffset` slides the
 * rendered window by the distance between the two centres, so the projection itself puts the
 * target in the row and every projection user (MapControls, pin picking, the e2e hooks) agrees.
 * The row is measured from the DOM (the scene status row, which repeats the overlay grid from
 * src/components/overlay/layers.ts), and a ResizeObserver re-frames on a resize and whenever the
 * HUD switches between its two-row and compact heights. Each change requests one frame.
 */
import { useEffect } from 'react'
import { useThree } from '@react-three/fiber'
import { PerspectiveCamera } from 'three'
import { FREE_SCENE_ROW_SELECTOR } from '../types'

export function FreeRowFraming() {
  const camera = useThree((state) => state.camera)
  const gl = useThree((state) => state.gl)
  const size = useThree((state) => state.size)
  const invalidate = useThree((state) => state.invalidate)

  useEffect(() => {
    const row = document.querySelector<HTMLElement>(FREE_SCENE_ROW_SELECTOR)
    if (!(camera instanceof PerspectiveCamera) || row === null) return
    const canvas = gl.domElement

    const apply = () => {
      const full = canvas.getBoundingClientRect()
      const free = row.getBoundingClientRect()
      if (full.width === 0 || full.height === 0) return
      // Positive when the row's centre is below the canvas centre: slide the view window up by
      // that much so the scene, and the target with it, moves down into the row.
      const shift = Math.round(free.top + free.height / 2 - (full.top + full.height / 2))
      camera.setViewOffset(full.width, full.height, 0, -shift, full.width, full.height)
      invalidate()
    }

    apply()
    const observer = new ResizeObserver(apply)
    observer.observe(row)
    observer.observe(canvas)
    return () => {
      observer.disconnect()
      camera.clearViewOffset()
      invalidate()
    }
  }, [camera, gl, size, invalidate])

  return null
}
