/** Registers the `clout.*` copy namespace (data/copy/clout). Import it where the copy is used. */
import base from '@data/copy/clout/base.json'
import nycPack from '@data/copy/clout/nyc.json'
import { registerCopy } from '../registry'

registerCopy('clout', base, { nyc: nycPack })
