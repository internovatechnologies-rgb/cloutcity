/** Registers the `hud.*` copy namespace (data/copy/hud). Import it where the copy is used. */
import base from '@data/copy/hud/base.json'
import { registerCopy } from '../registry'

registerCopy('hud', base, {})
