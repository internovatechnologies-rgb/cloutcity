'use client'

import { useEffect, useState } from 'react'
import { PANEL_BUTTON, PanelStatus } from '@/components/hud/PanelDialog'
import { copy } from '@/lib/copy'
import { log } from '@/lib/log'
import { rpcErrorText } from '@/lib/safety/errorCopy'
import { HELD_HANDLE_PLACEHOLDER } from '@/lib/safety/reports'
import type { ListedPlayer, SafetyApi } from '@/lib/supabase/safetyApi'
// Copy namespaces this module renders (DEC-11: they load with this module's chunk).
import '@/lib/copy/ns/safety'

type Lists =
  | { readonly state: 'loading' }
  | { readonly state: 'failed' }
  | {
      readonly state: 'ready'
      readonly blocked: readonly ListedPlayer[]
      readonly muted: readonly ListedPlayer[]
    }

const nameOf = (player: ListedPlayer) => player.handle ?? HELD_HANDLE_PLACEHOLDER

function PlayerList({
  kind,
  players,
  busy,
  onUndo,
}: {
  readonly kind: 'blocked' | 'muted'
  readonly players: readonly ListedPlayer[]
  readonly busy: string | null
  readonly onUndo: (player: ListedPlayer) => void
}) {
  const headingId = `me-${kind}-title`
  return (
    <div className="flex flex-col gap-1">
      <h4 id={headingId} className="text-sm font-bold text-fg">
        {copy(kind === 'blocked' ? 'safety.list.blocked' : 'safety.list.muted')}
      </h4>
      {players.length === 0 ? (
        <p className="text-sm text-muted">
          {copy(kind === 'blocked' ? 'safety.list.noneBlocked' : 'safety.list.noneMuted')}
        </p>
      ) : (
        <ul aria-labelledby={headingId} className="flex flex-col gap-1">
          {players.map((player) => {
            const handle = nameOf(player)
            return (
              <li
                key={player.playerId}
                data-safety-listed={kind}
                className="flex items-center justify-between gap-2 rounded-xl bg-raised px-3 py-1"
              >
                <span className="min-w-0 truncate text-fg">@{handle}</span>
                <button
                  type="button"
                  onClick={() => onUndo(player)}
                  aria-disabled={busy === player.playerId ? true : undefined}
                  aria-label={copy(
                    kind === 'blocked'
                      ? 'safety.actions.unblockLabel'
                      : 'safety.actions.unmuteLabel',
                    { handle },
                  )}
                  className={`${PANEL_BUTTON} shrink-0 bg-canvas text-fg`}
                >
                  {copy(kind === 'blocked' ? 'safety.actions.unblock' : 'safety.actions.unmute')}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

/**
 * The Me panel's "Blocked and muted" section (S18b): the players this player blocked or muted,
 * each with Unblock or Unmute. A block undone here never restores the friendship it ended (only
 * the toast's Undo, inside its window, does).
 */
export function BlockedMutedList({ api }: { readonly api: SafetyApi }) {
  const [lists, setLists] = useState<Lists>({ state: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [busy, setBusy] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    void Promise.all([api.listBlocks(), api.listMutes()]).then(([blocked, muted]) => {
      if (!live) return
      if (!blocked.ok || !muted.ok) {
        log.info('The blocked and muted lists did not load', {
          code: blocked.ok ? (muted.ok ? null : muted.code) : blocked.code,
        })
        setLists({ state: 'failed' })
        return
      }
      setLists({ state: 'ready', blocked: blocked.data, muted: muted.data })
    })
    return () => {
      live = false
    }
  }, [api, attempt])

  const undo = async (kind: 'blocked' | 'muted', player: ListedPlayer) => {
    if (busy !== null || lists.state !== 'ready') return
    setBusy(player.playerId)
    const result =
      kind === 'blocked' ? await api.unblock(player.playerId) : await api.unmute(player.playerId)
    setBusy(null)
    if (!result.ok) {
      setStatus(rpcErrorText(result.code))
      return
    }
    setLists((previous) =>
      previous.state !== 'ready'
        ? previous
        : {
            ...previous,
            [kind]: previous[kind].filter((listed) => listed.playerId !== player.playerId),
          },
    )
    setStatus(
      copy(kind === 'blocked' ? 'safety.toast.unblocked' : 'safety.toast.unmuted', {
        handle: nameOf(player),
      }),
    )
  }

  return (
    <section data-safety-lists="" aria-labelledby="me-safety-title" className="flex flex-col gap-2">
      <h3 id="me-safety-title" className="font-bold text-fg">
        {copy('safety.list.title')}
      </h3>
      <p className="text-sm text-muted">{copy('safety.list.explain')}</p>
      {lists.state === 'loading' ? (
        <p role="status" className="text-sm text-muted">
          {copy('safety.list.loading')}
        </p>
      ) : lists.state === 'failed' ? (
        <div className="flex flex-col items-start gap-2">
          <p role="alert" className="text-sm font-semibold text-danger">
            {copy('safety.list.failed')}
          </p>
          <button
            type="button"
            onClick={() => {
              setLists({ state: 'loading' })
              setAttempt((value) => value + 1)
            }}
            className={`${PANEL_BUTTON} bg-raised text-fg`}
          >
            {copy('safety.list.retry')}
          </button>
        </div>
      ) : (
        <>
          <PlayerList
            kind="blocked"
            players={lists.blocked}
            busy={busy}
            onUndo={(player) => void undo('blocked', player)}
          />
          <PlayerList
            kind="muted"
            players={lists.muted}
            busy={busy}
            onUndo={(player) => void undo('muted', player)}
          />
        </>
      )}
      <PanelStatus text={status} />
    </section>
  )
}
