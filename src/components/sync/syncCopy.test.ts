import { describe, expect, it } from 'vitest'
import base from '@data/copy/sync/base.json'
import { SYNC_STATUSES } from '@/state/syncStatus'
import { syncCopyKey, syncSheetText, syncStatusText } from './syncCopy'

const strings: Record<string, string> = base.strings

describe('cloud save copy (UI-11)', () => {
  it('has a status line and an explanation for every status', () => {
    for (const status of SYNC_STATUSES) {
      expect(strings[syncCopyKey('status', status)], status).toBeTruthy()
      expect(strings[syncCopyKey('sheet', status)], status).toBeTruthy()
      expect(syncStatusText(status)).toBe(strings[syncCopyKey('status', status)])
      expect(syncSheetText(status)).toBe(strings[syncCopyKey('sheet', status)])
    }
  })

  it('keys the synced copy by who owns the account game, so a signed-in variant can join', () => {
    expect(syncCopyKey('status', 'synced')).toBe('sync.status.synced.guest')
    expect(syncCopyKey('sheet', 'synced', 'guest')).toBe('sync.sheet.synced.guest')
  })

  it('says "this device" and names the account copy "account game" (one name)', () => {
    const all = Object.values(strings).join('\n')
    expect(all).not.toMatch(/\bphone\b/i)
    expect(all).not.toMatch(/cloud game|account save\b(?! paused)|account's game/i)
  })
})
