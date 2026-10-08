import { afterEach, describe, expect, it } from 'vitest'
import { createLogger, type LogRecord } from '@/lib/log'
import { unavailableSafetyApi, type SafetyApi } from '@/lib/supabase/safetyApi'
import { accountNoticesStore, clearAccountNotices } from '@/state/accountNotices'
import { loadAccountNotices } from './loadNotices'

afterEach(clearAccountNotices)

const notice = {
  id: 'n1',
  kind: 'warning' as const,
  reason: 'spam' as const,
  endsAt: null,
  createdAt: '2026-10-07T00:00:00Z',
  sanctionId: 's1',
}

describe('loadAccountNotices', () => {
  it('puts open notices in the store with the API that loaded them', async () => {
    const api: SafetyApi = {
      ...unavailableSafetyApi(),
      openNotices: () => Promise.resolve({ ok: true, data: [notice] }),
    }
    await loadAccountNotices(api)
    expect(accountNoticesStore.getState()).toEqual({ notices: [notice], api })
  })

  it('logs a failure at info and shows nothing', async () => {
    const records: LogRecord[] = []
    await loadAccountNotices(
      unavailableSafetyApi('unknown'),
      createLogger({ sink: (record) => records.push(record) }),
    )
    expect(accountNoticesStore.getState().notices).toEqual([])
    expect(records.map((record) => record.level)).toEqual(['info'])
  })
})
