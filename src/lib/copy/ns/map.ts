/** Registers the `map.*` copy namespace (data/copy/map). Import it where the copy is used. */
import base from '@data/copy/map/base.json'
import nycPack from '@data/copy/map/nyc.json'
import { registerCopy } from '../registry'

registerCopy('map', base, { nyc: nycPack })
