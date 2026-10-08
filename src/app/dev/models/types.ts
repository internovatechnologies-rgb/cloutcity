/**
 * Serialisable props of the /dev/models showcase (S04h): the server resolves
 * data/assets/showcase.json (theme tokens to hex, model ids to ModelRefs) so the client imports
 * neither the manifest nor zod.
 */
import type { AvatarColors } from '@/scene/models/AvatarModel'
import type { ModelPlacement } from '@/scene/models/ModelInstances'
import type { SlotColors } from '@/scene/models/slots'
import type { ModelRef, ModelsConfig, ModelTier } from '@/scene/models/types'
import type { ShowcaseLight, ShowcaseView } from '@/lib/data/schemas/assets'

export type ShowcaseViewId = 'avatars' | 'street' | 'room' | 'catalog'
export type ShowcaseTime = 'day' | 'golden' | 'night'

export interface ShowcaseGroup {
  readonly model: ModelRef
  readonly colors?: SlotColors
  readonly placements: readonly ModelPlacement[]
}

export interface ShowcaseScene {
  readonly view: ShowcaseViewId
  readonly time: ShowcaseTime
  readonly tier: ModelTier
  readonly camera: ShowcaseView['camera']
  readonly grounds: readonly {
    readonly color: string
    readonly center: readonly [number, number, number]
    readonly size: readonly [number, number]
  }[]
  /** Static placements, one instanced draw per model and recolour. */
  readonly groups: readonly ShowcaseGroup[]
  readonly lineup?: {
    readonly columns: { readonly landscape: number; readonly portrait: number }
    readonly spacingM: number
    readonly rowDepthM: number
    readonly clip: string
    readonly rig: ModelRef
    readonly avatars: readonly {
      readonly head: ModelRef
      readonly body: ModelRef
      readonly colors: AvatarColors
    }[]
  }
  readonly grid?: {
    readonly cellM: number
    readonly columns: { readonly landscape: number; readonly portrait: number }
    readonly models: readonly ModelRef[]
  }
  readonly light: ShowcaseLight
  /** The shared `uNightGlow` value for this time of day: 1 at night, else 0. */
  readonly nightGlow: number
  readonly models: ModelsConfig
}
