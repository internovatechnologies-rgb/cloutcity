'use client'

/**
 * The shell's side of the 3D apartment (S16), rendered inside the scene's static room slot
 * (`[data-scene-slot="room"]`, src/scene/CityScene.tsx), so the room draws where the map does,
 * under every overlay zone, while the Home panel stays in the sheet zone. It shows whatever view
 * the Home panel hands over (src/state/apartmentView.ts) and nothing while the panel is closed.
 *
 * The canvas is a `next/dynamic` import with `ssr: false`: its own chunk
 * (`cc-feature:apartment-scene`), loaded when the Home panel first opens, which `npm run budget`
 * reports apart from the map's chunk. The import sits here in the shell, not in the Home panel's
 * lazy chunk, because Turbopack lists a `next/dynamic` nested in a lazily imported module in the
 * route's loadable manifest under a chunk it never writes; this module costs the shell a few
 * hundred bytes.
 *
 * While the room shows, the city hands it the screen (src/state/sceneFocus.ts): the map renders
 * no frames and is hidden. Without WebGL2, or when the room fails to start, nothing mounts and the
 * city keeps the screen; the Home panel's lists place and move everything without 3D (A11Y-3).
 */
import dynamic from 'next/dynamic'
import { Component, useEffect, useState, type ReactNode } from 'react'
import { log } from '@/lib/log'
import { tapApartmentSlot, useApartmentView } from '@/state/apartmentView'
import { setSceneFocus } from '@/state/sceneFocus'
import { webgl2Available } from '../webgl'

const ApartmentCanvas = dynamic(() => import('./ApartmentCanvas'), { ssr: false })

/** Logged once when the 3D room fails to start (an unexpected render or chunk error). */
export const ROOM_FAILED_MESSAGE = '3D apartment failed to start; the Home panel still works'

class RoomErrorBoundary extends Component<
  { readonly children: ReactNode; readonly onError: () => void },
  { failed: boolean }
> {
  override state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  override componentDidCatch(error: Error): void {
    // The logger keeps only the error's name: messages can echo payload text.
    log.warn(ROOM_FAILED_MESSAGE, { reason: 'render', error })
    this.props.onError()
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children
  }
}

let webglProbe: boolean | undefined

/** Whether this device can draw the room: probed once, the first time a view arrives. */
function canDrawRoom(): boolean {
  webglProbe ??= webgl2Available()
  return webglProbe
}

export function ApartmentMount() {
  const view = useApartmentView()
  const [failed, setFailed] = useState(false)
  // No view exists on the server or before the panel opens, so the probe only runs in the browser.
  const showing = view !== null && !failed && canDrawRoom()

  useEffect(() => {
    if (!showing) return
    setSceneFocus('room')
    return () => setSceneFocus('city')
  }, [showing])

  if (!showing) return null
  return (
    <RoomErrorBoundary onError={() => setFailed(true)}>
      <ApartmentCanvas {...view} onSlotTap={tapApartmentSlot} />
    </RoomErrorBoundary>
  )
}
