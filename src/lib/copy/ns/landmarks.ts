/** Registers the `landmarks.*` copy namespace (data/copy/landmarks). Import it where the copy is used. */
import base from '@data/copy/landmarks/base.json'
import { registerCopy } from '../registry'

registerCopy('landmarks', base, {})
