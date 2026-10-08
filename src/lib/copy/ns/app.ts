/** Registers the `app.*` copy namespace (data/copy/app). Boot: the copy core imports it. */
import base from '@data/copy/app/base.json'
import { registerCopy } from '../registry'

registerCopy('app', base, {})
