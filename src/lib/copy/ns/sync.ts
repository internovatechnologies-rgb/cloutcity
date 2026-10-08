/** Registers the `sync.*` copy namespace (data/copy/sync). Import it where the copy is used. */
import base from '@data/copy/sync/base.json'
import { registerCopy } from '../registry'

registerCopy('sync', base, {})
