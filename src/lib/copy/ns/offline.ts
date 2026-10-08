/** Registers the `offline.*` copy namespace (data/copy/offline). Import it where the copy is used. */
import base from '@data/copy/offline/base.json'
import nycPack from '@data/copy/offline/nyc.json'
import { registerCopy } from '../registry'

registerCopy('offline', base, { nyc: nycPack })
