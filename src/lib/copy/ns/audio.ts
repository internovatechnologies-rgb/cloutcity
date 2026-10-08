/** Registers the `audio.*` copy namespace (data/copy/audio). Import it where the copy is used. */
import base from '@data/copy/audio/base.json'
import nycPack from '@data/copy/audio/nyc.json'
import { registerCopy } from '../registry'

registerCopy('audio', base, { nyc: nycPack })
