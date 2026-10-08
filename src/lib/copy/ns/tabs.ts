/** Registers the `tabs.*` copy namespace (data/copy/tabs). Boot: the copy core imports it. */
import base from '@data/copy/tabs/base.json'
import { registerCopy } from '../registry'

registerCopy('tabs', base, {})
