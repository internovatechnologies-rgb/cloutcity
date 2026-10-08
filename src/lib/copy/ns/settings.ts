/**
 * Registers the `settings.*` copy namespace (data/copy/settings): the Settings sheet's own
 * sections beyond sound, such as Graphics (NOTE-21). Import it where the copy is used.
 */
import base from '@data/copy/settings/base.json'
import { registerCopy } from '../registry'

registerCopy('settings', base, {})
