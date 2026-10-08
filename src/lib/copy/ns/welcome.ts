/** Registers the `welcome.*` copy namespace (data/copy/welcome). Import it where the copy is used. */
import base from '@data/copy/welcome/base.json'
import nycPack from '@data/copy/welcome/nyc.json'
import { registerCopy } from '../registry'

registerCopy('welcome', base, { nyc: nycPack })
