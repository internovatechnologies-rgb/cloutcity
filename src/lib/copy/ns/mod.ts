/** Registers the `mod.*` copy namespace (data/copy/mod). Import it where the copy is used. */
import base from '@data/copy/mod/base.json'
import { registerCopy } from '../registry'

registerCopy('mod', base, {})
