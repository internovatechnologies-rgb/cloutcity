/**
 * S15's `toServerGrantRow` (src/engine/grants.ts) against the generated S18 table types: the
 * engine declares its row type itself (no Supabase imports in the engine), so this checks the
 * two stay in step. tests/integration/grant-row.test.ts inserts a row into the real table.
 */
import { describe, expect, expectTypeOf, it } from 'vitest'
import { engineConfig as config } from '@/engine/config'
import { syncGoals } from '@/engine/goals'
import { grant, toServerGrantRow, type ServerGrantRow } from '@/engine/grants'
import { initialSave } from '@/engine/save'
import { playerWithClout } from '@/engine/test-support'
import type { Database } from './database.types'

type GrantInsert = Database['public']['Tables']['grants']['Insert']
type GrantColumns = keyof Database['public']['Tables']['grants']['Row']

describe('toServerGrantRow vs the S18 grants columns', () => {
  it('is assignable to an insert, column for column', () => {
    expectTypeOf<ServerGrantRow>().toExtend<GrantInsert>()
    expectTypeOf<keyof ServerGrantRow>().toExtend<GrantColumns>()
  })

  it('fills every column the table requires, and only real columns', () => {
    const base = initialSave(config)
    const save = syncGoals(
      { ...base, player: playerWithClout(base.player, 150, config) },
      config,
    ).save
    const result = grant(
      save,
      { kind: 'goal_reward', goalId: 'reach-local', reward: { cash: 50, clout: 15 } },
      1_760_000_000_000,
      config,
    )
    if (!result.ok) throw new Error(result.error.code)
    const row = toServerGrantRow(result.record, '00000000-0000-4000-8000-000000000001')
    const columns: readonly GrantColumns[] = [
      'user_id',
      'kind',
      'idempotency_key',
      'cash_amount',
      'clout_amount',
      'item_id',
      'cap_amount',
      'clout_cap',
      'eligibility',
      'reason',
      'issued_by',
      'campaign_id',
    ]
    expect(Object.keys(row).sort()).toEqual([...columns].sort())
    // The table's checks: cash within its cap, amounts non-negative, a non-empty reason.
    expect(row.cash_amount).toBeLessThanOrEqual(row.cap_amount)
    expect(row.clout_amount).toBeGreaterThanOrEqual(0)
    expect(row.reason).not.toBe('')
    expect(row.clout_amount).toBeLessThanOrEqual(row.clout_cap)
    expect(row.clout_cap).toBe(result.record.cap.clout)
    expect(row.idempotency_key).toBe('goal:reach-local:r1')
  })
})
