/** Registers the `boroughs.*` copy namespace (data/copy/boroughs). Import it where the copy is used. */
import base from '@data/copy/boroughs/base.json'
import nycPack from '@data/copy/boroughs/nyc.json'
import { registerCopy } from '../registry'

registerCopy('boroughs', base, { nyc: nycPack })
