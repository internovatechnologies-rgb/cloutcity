'use client'

import dynamic from 'next/dynamic'
import { useState } from 'react'
import type { ShowcaseScene } from './types'

// The canvas, three and the model runtime load in this route's own lazy chunk.
const ShowcaseCanvas = dynamic(() => import('./ShowcaseCanvas'), { ssr: false })

export type ShowcaseStatus = 'loading' | 'ready' | 'error'

export function ShowcaseClient({
  scene,
  loading,
  error,
}: {
  readonly scene: ShowcaseScene
  readonly loading: string
  readonly error: string
}) {
  const [status, setStatus] = useState<ShowcaseStatus>('loading')
  return (
    <>
      <ShowcaseCanvas scene={scene} onStatus={setStatus} />
      {status !== 'ready' && (
        <p
          role="status"
          className="absolute right-2 bottom-2 rounded glass px-2 py-1 text-xs text-fg"
        >
          {status === 'error' ? error : loading}
        </p>
      )}
    </>
  )
}
