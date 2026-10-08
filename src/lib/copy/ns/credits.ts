/** Registers the `credits.*` copy namespace (data/copy/credits). Import it where the copy is used. */
import base from '@data/copy/credits/base.json'
import { registerCopy } from '../registry'

registerCopy('credits', base, {})
