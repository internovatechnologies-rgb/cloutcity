'use client'

import { useEffect, useRef } from 'react'
import { copy } from '@/lib/copy'
// Copy namespaces this module renders (DEC-11: they load with this module's chunk).
import '@/lib/copy/ns/ageGate'

interface AgeLockNoticeProps {
  readonly titleId: string
  readonly bodyId: string
}

/**
 * The in-voice under-age screen. It offers no retry, form or hint of how long the lock lasts;
 * the gate stays locked on this device until the lock runs out.
 */
export function AgeLockNotice({ titleId, bodyId }: AgeLockNoticeProps) {
  const title = useRef<HTMLHeadingElement>(null)
  useEffect(() => title.current?.focus(), [])

  return (
    <div className="flex flex-col gap-3 py-4 text-center">
      <h2
        ref={title}
        id={titleId}
        tabIndex={-1}
        className="text-2xl font-extrabold tracking-tight text-fg focus:outline-none"
      >
        {copy('ageGate.title')}
      </h2>
      <p id={bodyId} className="text-fg">
        {copy('ageGate.body')}
      </p>
    </div>
  )
}
