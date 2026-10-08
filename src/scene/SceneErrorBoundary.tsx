'use client'

import { Component, type ReactNode } from 'react'
import { log } from '@/lib/log'

/** The one warning logged when the 3D map is unavailable (expected by the e2e failure specs). */
export const SCENE_FAILED_MESSAGE = '3D scene failed to start; showing the static map background'

interface Props {
  readonly children: ReactNode
  readonly onError: () => void
}

/**
 * Last line of defence for an unexpected failure inside the 3D scene (a renderer or chunk
 * error): the shell keeps working over the static fallback map, with the Places panel open
 * (CitySceneClient). Expected failures (no WebGL, a failed or invalid geo download) never get
 * here; CitySceneClient handles them before the canvas mounts.
 */
export class SceneErrorBoundary extends Component<Props, { failed: boolean }> {
  override state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  override componentDidCatch(error: Error): void {
    // The logger keeps only the error's name: messages can echo payload text.
    log.warn(SCENE_FAILED_MESSAGE, { reason: 'render', error })
    this.props.onError()
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children
  }
}
