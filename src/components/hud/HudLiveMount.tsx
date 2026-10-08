'use client'

import { lazyIsland } from '@/components/overlay/lazyIsland'
import { HudSkeleton } from './HudSkeleton'

/**
 * The HUD's live cells (S05): money, clock, speed, clout with the goal line, and the stats. A
 * boot island (DEC-11): the game store, engine and HUD copy load in its chunk right after the
 * shell, and until then the skeleton holds the same boxes, from the server-rendered HTML on.
 */
export const HudLiveMount = lazyIsland(() => import('./HudLive').then((module) => module.HudLive), {
  zone: 'hud',
  labelKey: 'loading.hud',
  eager: true,
  placeholder: <HudSkeleton />,
})
