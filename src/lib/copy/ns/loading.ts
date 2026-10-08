/** Registers the `loading.*` copy namespace (data/copy/loading). Boot: the copy core imports it. */
import base from '@data/copy/loading/base.json'
import { registerCopy } from '../registry'

registerCopy('loading', base, {})
