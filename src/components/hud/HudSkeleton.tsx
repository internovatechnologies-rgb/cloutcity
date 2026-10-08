'use client'

import { copy } from '@/lib/copy'
import { HUD_CELL } from './hudLayout'

const BAR = 'rounded-full bg-raised motion-safe:animate-pulse'

/**
 * The HUD's live cells before their island has loaded (S05): the same grid areas and boxes as
 * src/components/hud/HudLive.tsx, drawn on the server and until the island arrives, so nothing
 * moves when it does. No store, no feature copy: only the boot `loading` namespace, for the one
 * status that tells screen readers the stats are on their way.
 */
export function HudSkeleton() {
  return (
    <>
      <p role="status" aria-busy="true" data-hud-skeleton="" className="sr-only">
        {copy('loading.hud')}
      </p>
      <div aria-hidden="true" data-hud-cell="money" className={HUD_CELL.money}>
        <div className={`h-5 w-14 ${BAR}`} />
      </div>
      <div aria-hidden="true" data-hud-cell="clock" className={`${HUD_CELL.clock} gap-1`}>
        <div className={`h-2.5 w-9 ${BAR}`} />
        <div className={`h-3.5 w-14 ${BAR}`} />
      </div>
      <div aria-hidden="true" data-hud-cell="speed" className={HUD_CELL.speed}>
        <div className={`h-11 w-11 rounded-xl bg-raised`} />
      </div>
      <div
        aria-hidden="true"
        data-hud-cell="clout"
        className={`${HUD_CELL.clout} flex-col gap-1.5 px-2 py-1.5`}
      >
        <div className={`h-3 w-32 max-w-full ${BAR}`} />
        <div className={`h-2 w-full ${BAR}`} />
      </div>
      <div aria-hidden="true" data-hud-cell="stats" className={HUD_CELL.stats}>
        <div className={`h-2 flex-1 ${BAR}`} />
        <div className={`h-2 flex-1 ${BAR}`} />
        <div className={`h-2 flex-1 ${BAR}`} />
      </div>
    </>
  )
}
