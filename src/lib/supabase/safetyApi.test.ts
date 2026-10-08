import { describe, expect, it } from 'vitest'
import { createProfileApi } from './profileApi'
import type { RpcResponse } from './rpc'
import { createSafetyApi, lazySafetyApi, unavailableSafetyApi, type SafetyApi } from './safetyApi'

const TARGET = '33333333-3333-4333-8333-333333333333'

/** A transport answering each function from `answers`, recording calls. */
function transport(answers: Readonly<Record<string, RpcResponse | Error>>) {
  const calls: { fn: string; args: unknown }[] = []
  const reply = (key: string) => {
    const answer = answers[key]
    if (answer === undefined) return Promise.reject(new Error(`no answer for ${key}`))
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)
  }
  return {
    calls,
    rpc: (fn: string, args?: Readonly<Record<string, unknown>>) => {
      calls.push({ fn, args })
      return reply(fn)
    },
    openNotices: () => reply('notices'),
  }
}

const ok = (data: unknown): RpcResponse => ({ data, error: null })
const refused = (message: string, code = 'PT400'): RpcResponse => ({
  data: null,
  error: { code, message },
})

describe('safetyApi', () => {
  it('block returns the undo token and what ended', async () => {
    const t = transport({
      block_player: ok([
        {
          undo_id: 'u1',
          undo_expires_at: '2026-10-07T00:00:10Z',
          friendship_ended: true,
          roommate_ended: false,
        },
      ]),
    })
    expect(await createSafetyApi(t).block(TARGET)).toEqual({
      ok: true,
      data: {
        undoId: 'u1',
        undoExpiresAt: '2026-10-07T00:00:10Z',
        friendshipEnded: true,
        roommateEnded: false,
      },
    })
    expect(t.calls).toEqual([{ fn: 'block_player', args: { p_target: TARGET } }])
  })

  it('block of a player already blocked is a success with no undo (the server changes nothing)', async () => {
    const t = transport({
      block_player: ok([
        { undo_id: null, undo_expires_at: null, friendship_ended: false, roommate_ended: false },
      ]),
    })
    expect(await createSafetyApi(t).block(TARGET)).toEqual({
      ok: true,
      data: { undoId: null, undoExpiresAt: null, friendshipEnded: false, roommateEnded: false },
    })
  })

  it('unblock passes the undo id only when given', async () => {
    const row = ok([{ unblocked: true, friendship_restored: true, roommate_restored: false }])
    const t = transport({ unblock_player: row })
    const api = createSafetyApi(t)
    await api.unblock(TARGET)
    await api.unblock(TARGET, 'u1')
    expect(t.calls.map((call) => call.args)).toEqual([
      { p_target: TARGET },
      { p_target: TARGET, p_undo: 'u1' },
    ])
  })

  it('maps a server refusal to its machine code, and anything unexpected to unknown', async () => {
    const api = createSafetyApi(
      transport({
        mute_player: refused('mute_limit', 'PT409'),
        list_my_blocks: ok([{ player_id: 1 }]),
        list_my_mutes: new TypeError('Failed to fetch'),
        submit_report: refused('something new'),
      }),
    )
    expect(await api.mute(TARGET)).toEqual({ ok: false, code: 'mute_limit' })
    expect(await api.listBlocks()).toEqual({ ok: false, code: 'unknown' })
    expect(await api.listMutes()).toEqual({ ok: false, code: 'unknown' })
    expect(
      await api.report({
        target: TARGET,
        kind: 'player',
        reason: 'spam',
        note: '',
        idempotencyKey: 'k-12345678',
      }),
    ).toEqual({ ok: false, code: 'unknown' })
  })

  it('report sends the note as typed and reads duplicate', async () => {
    const t = transport({ submit_report: ok([{ report_id: 'r1', duplicate: true }]) })
    const result = await createSafetyApi(t).report({
      target: TARGET,
      kind: 'handle',
      reason: 'offensive_name',
      note: ' rude ',
      idempotencyKey: 'key-12345678',
    })
    expect(result).toEqual({ ok: true, data: { report_id: 'r1', duplicate: true } })
    expect(t.calls[0]?.args).toEqual({
      p_target: TARGET,
      p_kind: 'handle',
      p_reason: 'offensive_name',
      p_note: ' rude ',
      p_idempotency_key: 'key-12345678',
    })
  })

  it('reads open notices and lists', async () => {
    const api = createSafetyApi(
      transport({
        notices: ok([
          {
            id: 'n1',
            kind: 'suspension',
            reason: 'spam',
            ends_at: '2026-10-14T00:00:00Z',
            created_at: '2026-10-07T00:00:00Z',
            sanction_id: 's1',
          },
        ]),
        list_my_mutes: ok([{ player_id: 'p', handle: null, muted_at: '2026-10-07T00:00:00Z' }]),
      }),
    )
    expect(await api.openNotices()).toEqual({
      ok: true,
      data: [
        {
          id: 'n1',
          kind: 'suspension',
          reason: 'spam',
          endsAt: '2026-10-14T00:00:00Z',
          createdAt: '2026-10-07T00:00:00Z',
          sanctionId: 's1',
        },
      ],
    })
    expect(await api.listMutes()).toEqual({
      ok: true,
      data: [{ playerId: 'p', handle: null, at: '2026-10-07T00:00:00Z' }],
    })
  })

  it('lazySafetyApi connects once, and retries after a failed connection', async () => {
    let connects = 0
    const api = lazySafetyApi(() => {
      connects += 1
      if (connects === 1) return Promise.reject(new Error('chunk failed'))
      return Promise.resolve(unavailableSafetyApi('not_authenticated') satisfies SafetyApi)
    })
    expect(await api.mute(TARGET)).toEqual({ ok: false, code: 'unknown' })
    expect(await api.mute(TARGET)).toEqual({ ok: false, code: 'not_authenticated' })
    expect(await api.unmute(TARGET)).toEqual({ ok: false, code: 'not_authenticated' })
    expect(connects).toBe(2)
  })
})

describe('profileApi', () => {
  const profile = {
    handle: 'Claude_qa',
    public_level: 'nobody',
    career_path: null,
    avatar: {},
    handle_generated: false,
    free_handle_change: false,
    handle_changes_left: 1,
    next_handle_change_at: null,
  }

  it('sets the handle exactly as given', async () => {
    const t = transport({ set_handle: ok([profile]), check_handle: ok('taken') })
    const api = createProfileApi(t)
    expect(await api.setHandle('claude_qa')).toEqual({ ok: true, data: profile })
    expect(await api.checkHandle('claude_qa')).toEqual({ ok: true, data: 'taken' })
    expect(t.calls.map((call) => call.args)).toEqual([
      { p_handle: 'claude_qa' },
      { p_handle: 'claude_qa' },
    ])
  })

  it('reads handle refusals and rejects odd answers', async () => {
    const api = createProfileApi(
      transport({
        set_handle: refused('handle_change_limited', 'PT429'),
        check_handle: ok('maybe'),
        get_my_profile: ok([]),
      }),
    )
    expect(await api.setHandle('x')).toEqual({ ok: false, code: 'handle_change_limited' })
    expect(await api.checkHandle('x')).toEqual({ ok: false, code: 'unknown' })
    expect(await api.getMyProfile()).toEqual({ ok: false, code: 'unknown' })
  })
})
