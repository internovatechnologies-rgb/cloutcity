/** Registers the `safety.*` copy namespace (data/copy/safety). Import it where the copy is used. */
import base from '@data/copy/safety/base.json'
import { registerCopy } from '../registry'

registerCopy('safety', base, {})
