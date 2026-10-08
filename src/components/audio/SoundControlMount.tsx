'use client'

import { lazyIsland } from '@/components/overlay/lazyIsland'

/**
 * The HUD's sound control slot (S05b). The control reads the zod-backed onboarding and audio
 * settings stores, so it is a boot island: it starts loading when the shell runs and keeps the
 * shell small (DEC-11). Until it arrives the HUD shows its loading pill; audio never starts
 * without a tap on the control itself (GR-13), so nothing is lost while it loads.
 */
export const SoundControlMount = lazyIsland(
  () => import('./SoundControl').then((module) => module.SoundControl),
  { zone: 'hud', labelKey: 'loading.sound', eager: true },
)
