'use client'

/**
 * The active quality tier's render settings inside the 3D canvas (S04b). Scene parts read what
 * they need from here: district buildings (S04d) take `buildingDensity` and `lodDistanceScale`,
 * landmarks (S07a) `lodDistanceScale` and `outlines`. The value changes when the tier changes
 * (a settings choice or a runtime step-down).
 */
import { createContext, useContext } from 'react'
import type { QualityTier } from '@/lib/data/schemas/config'
import type { TierRenderSettings } from '../types'

export interface ActiveTierSettings extends TierRenderSettings {
  readonly tier: QualityTier
}

export const TierSettingsContext = createContext<ActiveTierSettings | null>(null)

export function useTierSettings(): ActiveTierSettings {
  const settings = useContext(TierSettingsContext)
  if (settings === null) throw new Error('useTierSettings needs the city canvas')
  return settings
}
