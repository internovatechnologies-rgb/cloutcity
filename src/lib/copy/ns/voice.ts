/** Registers the `voice.*` copy namespace (data/copy/voice). Import it where the copy is used. */
import base from '@data/copy/voice/base.json'
import nycPack from '@data/copy/voice/nyc.json'
import { registerCopy } from '../registry'

registerCopy('voice', base, { nyc: nycPack })
