/**
 * S15: a local grant record, mapped by `toServerGrantRow` (src/engine/grants.ts), is a row the
 * real S18 `grants` table accepts, once per user and key, and the owner can read it back. S18c
 * inserts these when it re-validates local grants for a session.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { engineConfig as config } from '@/engine/config'
import { syncGoals } from '@/engine/goals'
import { grant, toServerGrantRow, type GrantRecord } from '@/engine/grants'
import { initialSave } from '@/engine/save'
import { playerWithClout } from '@/engine/test-support'
import { newAttestedGuest, serviceClient, type Guest } from './helpers'

function localRecords(): readonly GrantRecord[] {
  const base = initialSave(config)
  let save = syncGoals({ ...base, player: playerWithClout(base.player, 5000, config) }, config).save
  for (const goalId of ['reach-local', 'reach-icon']) {
    const goal = config.goals.find((entry) => entry.id === goalId)
    if (goal === undefined) throw new Error(`no goal ${goalId}`)
    const result = grant(
      save,
      { kind: 'goal_reward', goalId, reward: goal.reward },
      1_760_000_000_000,
      config,
    )
    if (!result.ok) throw new Error(result.error.code)
    save = result.save
  }
  return save.grants.log
}

describe('toServerGrantRow against the real grants table', () => {
  const service = serviceClient()
  let a: Guest
  let b: Guest
  const records = localRecords()

  beforeAll(async () => {
    ;[a, b] = await Promise.all([newAttestedGuest(), newAttestedGuest()])
  })

  it('inserts cash, clout and badge grants as rows the owner reads back', async () => {
    const rows = records.map((record) => toServerGrantRow(record, a.id))
    const { error } = await service.from('grants').insert(rows)
    expect(error).toBeNull()
    const { data, error: readError } = await a.client
      .from('grants')
      .select('idempotency_key, cash_amount, clout_amount, item_id, cap_amount, eligibility')
      .order('idempotency_key')
    expect(readError).toBeNull()
    expect(data).toEqual(
      rows
        .map(
          ({ idempotency_key, cash_amount, clout_amount, item_id, cap_amount, eligibility }) => ({
            idempotency_key,
            cash_amount,
            clout_amount,
            item_id,
            cap_amount,
            eligibility,
          }),
        )
        .sort((x, y) => x.idempotency_key.localeCompare(y.idempotency_key)),
    )
  })

  it('the same key twice is refused for one user, but another user can hold it', async () => {
    const [first] = records
    if (first === undefined) throw new Error('no record')
    const again = await service.from('grants').insert(toServerGrantRow(first, a.id))
    expect(again.error?.code).toBe('23505')
    const other = await service.from('grants').insert(toServerGrantRow(first, b.id))
    expect(other.error).toBeNull()
  })
})

describe('SEC-8: the clout cap column', () => {
  it('refuses clout above its own cap', async () => {
    const guest = await newAttestedGuest()
    const [first] = localRecords()
    if (first === undefined) throw new Error('no record')
    const row = toServerGrantRow(first, guest.id)
    const { error } = await serviceClient()
      .from('grants')
      .insert({ ...row, clout_amount: row.clout_cap + 1 })
    expect(error?.code).toBe('23514')
  })
})
