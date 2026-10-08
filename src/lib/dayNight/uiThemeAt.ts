import { keyframeAt } from './lightingAt'
import type { DayNightModel, UiTheme } from './types'

/**
 * The interface palette at a game minute: the current keyframe's `ui`, switching exactly when
 * the keyframe is reached. Always equals `lightingAt(minute, model).ui`, without the blending.
 */
export function uiThemeAt(minute: number, model: DayNightModel): UiTheme {
  return keyframeAt(minute, model).ui
}
