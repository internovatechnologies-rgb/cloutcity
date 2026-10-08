'use client'

import { lazyIsland } from '@/components/overlay/lazyIsland'

/**
 * The modal slot for the welcome card (S05a). The card, its zod/mini form schema and the
 * persisted onboarding store are a boot island: they start loading when the shell runs, so the
 * shell stays small (DEC-11). Until the island decides, its loading state keeps the page behind
 * it inert: the 18+ gate fails closed.
 */
export const WelcomeMount = lazyIsland(
  () => import('./WelcomeGate').then((module) => module.WelcomeGate),
  { zone: 'modal', labelKey: 'loading.welcome', eager: true },
)
