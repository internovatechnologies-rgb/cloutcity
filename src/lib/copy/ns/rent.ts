/** Registers the `rent.*` copy namespace (data/copy/rent). Import it where the copy is used. */
import base from '@data/copy/rent/base.json'
import nycPack from '@data/copy/rent/nyc.json'
import { registerCopy } from '../registry'

registerCopy('rent', base, { nyc: nycPack })
