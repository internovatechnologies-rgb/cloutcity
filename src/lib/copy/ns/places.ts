/** Registers the `places.*` copy namespace (data/copy/places). Import it where the copy is used. */
import base from '@data/copy/places/base.json'
import { registerCopy } from '../registry'

registerCopy('places', base, {})
