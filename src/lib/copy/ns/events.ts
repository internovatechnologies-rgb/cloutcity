/** Registers the `events.*` copy namespace (data/copy/events). Import it where the copy is used. */
import base from '@data/copy/events/base.json'
import nycPack from '@data/copy/events/nyc.json'
import { registerCopy } from '../registry'

registerCopy('events', base, { nyc: nycPack })
