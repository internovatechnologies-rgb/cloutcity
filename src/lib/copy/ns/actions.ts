/** Registers the `actions.*` copy namespace (data/copy/actions). Import it where the copy is used. */
import base from '@data/copy/actions/base.json'
import nycPack from '@data/copy/actions/nyc.json'
import { registerCopy } from '../registry'

registerCopy('actions', base, { nyc: nycPack })
