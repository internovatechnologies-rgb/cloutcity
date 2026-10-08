/** Registers the `ageGate.*` copy namespace (data/copy/ageGate). Import it where the copy is used. */
import base from '@data/copy/ageGate/base.json'
import nycPack from '@data/copy/ageGate/nyc.json'
import { registerCopy } from '../registry'

registerCopy('ageGate', base, { nyc: nycPack })
