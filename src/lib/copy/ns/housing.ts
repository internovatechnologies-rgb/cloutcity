/** Registers the `housing.*` copy namespace (data/copy/housing). Import it where the copy is used. */
import base from '@data/copy/housing/base.json'
import nycPack from '@data/copy/housing/nyc.json'
import { registerCopy } from '../registry'

registerCopy('housing', base, { nyc: nycPack })
