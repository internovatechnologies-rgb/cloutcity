/** Registers the `place.*` copy namespace (data/copy/place). Import it where the copy is used. */
import base from '@data/copy/place/base.json'
import nycPack from '@data/copy/place/nyc.json'
import { registerCopy } from '../registry'

registerCopy('place', base, { nyc: nycPack })
