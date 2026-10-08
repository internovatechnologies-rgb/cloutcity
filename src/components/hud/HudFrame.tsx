import type { ReactNode } from 'react'
import { SoundControlMount } from '@/components/audio/SoundControlMount'
import { copy } from '@/lib/copy'
import { uiThemeClock } from '@/lib/theme'
import { HudLiveMount } from './HudLiveMount'
import { HudPanelButtonsMount } from './HudPanelButtonsMount'
import { HUD_CELL, HUD_GRID } from './hudLayout'

interface HudFrameProps {
  /**
   * The Places button (S04c), placed in the actions cell between the sound control and the
   * panel buttons. It stays visible on phones (A11Y-3: the DOM path to every place). Nothing
   * is drawn here until it is passed.
   */
  readonly places?: ReactNode
}

/**
 * The HUD (S05): a server-rendered frame in the HUD zone with the page's heading (for screen
 * readers; the name and tagline are in the title and metadata), the live cells, and the
 * actions. No store here: the live cells load as a boot island over a skeleton of the same
 * boxes (HudLiveMount), and each action is its own island.
 */
export function HudFrame({ places }: HudFrameProps) {
  return (
    <header data-hud="" className={HUD_GRID}>
      <h1 className="sr-only">{copy('app.name')}</h1>
      <HudLiveMount themeClock={uiThemeClock()} />
      <div data-hud-cell="actions" className={HUD_CELL.actions}>
        <div data-hud-slot="sound" className="flex shrink-0">
          <SoundControlMount />
        </div>
        {places === undefined ? null : (
          <div data-hud-slot="places" className="flex shrink-0">
            {places}
          </div>
        )}
        <HudPanelButtonsMount />
      </div>
    </header>
  )
}
