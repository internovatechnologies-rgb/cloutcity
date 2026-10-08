/** Registers the `profile.*` copy namespace (data/copy/profile). Import it where the copy is used. */
import base from '@data/copy/profile/base.json'
import { registerCopy } from '../registry'

registerCopy('profile', base, {})
