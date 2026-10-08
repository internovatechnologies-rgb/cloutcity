/** Registers the `home.*` copy namespace (data/copy/home). Import it where the copy is used. */
import base from '@data/copy/home/base.json'
import nycPack from '@data/copy/home/nyc.json'
import { registerCopy } from '../registry'

registerCopy('home', base, { nyc: nycPack })
