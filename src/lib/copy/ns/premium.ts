/** Registers the `premium.*` copy namespace (data/copy/premium). Import it where the copy is used. */
import base from '@data/copy/premium/base.json'
import { registerCopy } from '../registry'

registerCopy('premium', base, {})
