'use client'

import { lazyIsland } from '@/components/overlay/lazyIsland'

/**
 * The HUD's Inventory and Rent buttons (S10a). A boot island (DEC-11): their labels live in
 * the `hud` copy namespace, which loads with them, so the shell keeps only this mount. They
 * load as soon as the shell runs, and render nothing until then (quiet): the welcome card
 * covers the HUD at first, and a placeholder would crowd the HUD row for no gain.
 */
export const HudPanelButtonsMount = lazyIsland(
  () => import('./HudPanelButtons').then((module) => module.HudPanelButtons),
  { zone: 'hud', labelKey: 'loading.hudPanels', eager: true, quiet: true },
)
