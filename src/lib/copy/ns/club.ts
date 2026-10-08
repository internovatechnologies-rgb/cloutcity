/** Registers the `club.*` copy namespace (data/copy/club). Import it where the copy is used. */
import base from '@data/copy/club/base.json'
import nycPack from '@data/copy/club/nyc.json'
import { registerCopy } from '../registry'

registerCopy('club', base, { nyc: nycPack })
