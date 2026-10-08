/**
 * Registers the shared `colors.*` copy namespace (data/copy/colors): human colour names for
 * colour variants (decor in S16), so no swatch is ever announced as a hex code (A11Y-1). Import
 * it where the names are rendered.
 */
import base from '@data/copy/colors/base.json'
import nycPack from '@data/copy/colors/nyc.json'
import { registerCopy } from '../registry'

registerCopy('colors', base, { nyc: nycPack })
