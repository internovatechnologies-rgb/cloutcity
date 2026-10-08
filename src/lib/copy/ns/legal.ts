/** Registers the `legal.*` copy namespace (data/copy/legal). Import it where the copy is used. */
import base from '@data/copy/legal/base.json'
import { registerCopy } from '../registry'

registerCopy('legal', base, {})
