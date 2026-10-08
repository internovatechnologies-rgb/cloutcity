/** Registers the `shop.*` copy namespace (data/copy/shop). Import it where the copy is used. */
import base from '@data/copy/shop/base.json'
import nycPack from '@data/copy/shop/nyc.json'
import { registerCopy } from '../registry'

registerCopy('shop', base, { nyc: nycPack })
