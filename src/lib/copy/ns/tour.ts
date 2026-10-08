/** Registers the `tour.*` copy namespace (data/copy/tour). Import it where the copy is used. */
import base from '@data/copy/tour/base.json'
import { registerCopy } from '../registry'

registerCopy('tour', base, {})
