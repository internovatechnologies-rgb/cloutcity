/** Registers the `venues.*` copy namespace (data/copy/venues). Import it where the copy is used. */
import base from '@data/copy/venues/base.json'
import nycPack from '@data/copy/venues/nyc.json'
import { registerCopy } from '../registry'

registerCopy('venues', base, { nyc: nycPack })
