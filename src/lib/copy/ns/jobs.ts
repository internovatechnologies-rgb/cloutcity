/** Registers the `jobs.*` copy namespace (data/copy/jobs). Import it where the copy is used. */
import base from '@data/copy/jobs/base.json'
import nycPack from '@data/copy/jobs/nyc.json'
import { registerCopy } from '../registry'

registerCopy('jobs', base, { nyc: nycPack })
