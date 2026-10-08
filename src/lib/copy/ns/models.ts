/**
 * Registers the `models.*` copy namespace (data/copy/models): human names of the hand-made 3D
 * models and of every model palette swatch (A11Y-1/2). Import it where the copy is used.
 */
import base from '@data/copy/models/base.json'
import { registerCopy } from '../registry'

registerCopy('models', base, {})
