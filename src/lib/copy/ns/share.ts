/** Registers the `share.*` copy namespace (data/copy/share). Import it where the copy is used. */
import base from '@data/copy/share/base.json'
import { registerCopy } from '../registry'

registerCopy('share', base, {})
