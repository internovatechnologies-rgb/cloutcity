/** Registers the `items.*` copy namespace (data/copy/items). Import it where the copy is used. */
import base from '@data/copy/items/base.json'
import nycPack from '@data/copy/items/nyc.json'
import { registerCopy } from '../registry'

registerCopy('items', base, { nyc: nycPack })
