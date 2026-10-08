/** Registers the `travel.*` copy namespace (data/copy/travel). Import it where the copy is used. */
import base from '@data/copy/travel/base.json'
import { registerCopy } from '../registry'

registerCopy('travel', base, {})
