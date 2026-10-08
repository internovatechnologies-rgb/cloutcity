/** Registers the `goals.*` copy namespace (data/copy/goals). Import it where the copy is used. */
import base from '@data/copy/goals/base.json'
import nycPack from '@data/copy/goals/nyc.json'
import { registerCopy } from '../registry'

registerCopy('goals', base, { nyc: nycPack })
