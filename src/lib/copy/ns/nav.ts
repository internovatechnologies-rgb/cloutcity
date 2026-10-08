/** Registers the `nav.*` copy namespace (data/copy/nav). Boot: the copy core imports it. */
import base from '@data/copy/nav/base.json'
import { registerCopy } from '../registry'

registerCopy('nav', base, {})
