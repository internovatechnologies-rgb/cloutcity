'use client'

import { engineConfig } from '@/engine/config'
import { nextRentDueDay } from '@/engine/rent'
import { copy } from '@/lib/copy'
import { homeLine, nextRentDueLine, rentNotice, rentOwedLine } from '@/lib/economyCopy'
import { closeHudPanel } from '@/state/hudPanel'
import { useGameStore } from '@/state/store'
import { PanelDialog } from './PanelDialog'

/**
 * The rent panel (S10a), opened from the HUD: where the player lives, when the next rent is
 * due and how much, what they owe, and the last rent notice this session, all through the
 * S11 copy helpers. Loaded lazily by HudPanelMount (DEC-11).
 */
export function RentPanel() {
  const home = useGameStore((state) => state.player.home)
  const owed = useGameStore((state) => state.player.rent.owed)
  const minute = useGameStore((state) => state.clock.minute)
  const lastRentEvent = useGameStore((state) => state.lastRentEvent)
  const dueDay = nextRentDueDay(minute, engineConfig)

  return (
    <PanelDialog
      title={copy('rent.heading')}
      panel="rent"
      feature="cc-feature:rent-panel"
      onClose={closeHudPanel}
    >
      <div className="flex flex-col gap-1 text-sm text-fg">
        <p>{homeLine(home)}</p>
        <p data-rent-next-due="">{nextRentDueLine(home, dueDay)}</p>
        <p data-rent-owed="">{rentOwedLine(owed)}</p>
      </div>
      <section aria-label={copy('rent.lastNotice.heading')} className="flex flex-col gap-1">
        <h3 className="text-xs font-bold text-muted uppercase">
          {copy('rent.lastNotice.heading')}
        </h3>
        <p role="status" data-rent-notice="" className="text-sm font-semibold text-taxi-ink">
          {lastRentEvent === null ? copy('rent.lastNotice.none') : rentNotice(lastRentEvent)}
        </p>
      </section>
    </PanelDialog>
  )
}
