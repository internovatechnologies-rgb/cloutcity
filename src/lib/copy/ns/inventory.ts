/** Registers the `inventory.*` copy namespace (data/copy/inventory). Import it where the copy is used. */
import base from '@data/copy/inventory/base.json'
import nycPack from '@data/copy/inventory/nyc.json'
import { registerCopy } from '../registry'

registerCopy('inventory', base, { nyc: nycPack })
