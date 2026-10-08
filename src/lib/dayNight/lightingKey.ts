import type { Lighting } from './types'

/**
 * Identity of a lighting state: equal keys mean equal lighting, so the scene re-renders
 * (`invalidate`) only when the key changes. A keyframe shown as is (its hold, or step mode)
 * keys by the keyframe alone, so a long hold costs no renders; a blend keys by its minute.
 */
export function lightingKey(lighting: Lighting): string {
  return lighting.t === 0 ? lighting.keyframe : `${lighting.keyframe}>${lighting.minute}`
}
