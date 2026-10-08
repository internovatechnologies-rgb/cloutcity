'use client'

import { copy, type CopyKey } from '@/lib/copy'
import { closeHudPanel, openHudPanel, useHudPanel } from '@/state/hudPanel'

export const TABS = [
  { id: 'map', labelKey: 'tabs.map', icon: '🗺️', soon: false },
  { id: 'phone', labelKey: 'tabs.phone', icon: '📱', soon: true },
  { id: 'shop', labelKey: 'tabs.shop', icon: '🛍️', soon: true },
  { id: 'me', labelKey: 'tabs.me', icon: '🙂', soon: false },
] as const satisfies readonly { id: string; labelKey: CopyKey; icon: string; soon: boolean }[]

export type TabId = (typeof TABS)[number]['id']

/**
 * Bottom tab bar. Map is the city; the Me tab opens the Me panel in the sheet zone (S18a) and is
 * current while that panel is open, and Map closes it. Phone and Shop have no screen yet: they
 * show a "Soon" badge and are disabled (aria-disabled, so they stay focusable and their name says
 * why), never a tap that silently does nothing (UI-16). The Me tab carries
 * `data-hud-panel="me"`, so focus comes back to it when the panel closes (PanelDialog).
 */
export function BottomTabs() {
  const panel = useHudPanel()
  const active: TabId = panel === 'me' ? 'me' : 'map'

  const choose = (id: TabId) => {
    if (id === 'me') openHudPanel('me')
    else if (id === 'map' && panel === 'me') closeHudPanel()
  }

  return (
    <nav
      aria-label={copy('nav.main')}
      className="h-full border-t border-line glass pb-[env(safe-area-inset-bottom,0px)]"
    >
      <ul className="grid h-full grid-cols-4">
        {TABS.map((tab) => {
          const isActive = tab.id === active
          const label = copy(tab.labelKey)
          return (
            <li key={tab.id} className="flex">
              <button
                type="button"
                data-tab={tab.id}
                data-hud-panel={tab.id === 'me' ? 'me' : undefined}
                aria-current={isActive ? 'page' : undefined}
                {...(tab.soon
                  ? {
                      'aria-disabled': true,
                      'aria-label': copy('tabs.soonLabel', { tab: label }),
                      'data-tab-soon': '',
                    }
                  : { onClick: () => choose(tab.id) })}
                className={`relative flex min-h-11 min-w-11 flex-1 flex-col items-center justify-center gap-0.5 text-xs font-semibold focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus aria-disabled:cursor-not-allowed ${
                  isActive ? 'text-taxi-ink' : 'text-muted'
                }`}
              >
                <span
                  aria-hidden="true"
                  className={`text-xl leading-none ${tab.soon ? 'opacity-50 grayscale' : ''}`}
                >
                  {tab.icon}
                </span>
                {label}
                {tab.soon ? (
                  <span
                    aria-hidden="true"
                    className="absolute top-1 left-1/2 ml-2 rounded-full border border-line bg-raised px-1.5 text-[0.625rem] leading-4 font-bold text-fg"
                  >
                    {copy('tabs.soon')}
                  </span>
                ) : null}
              </button>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
