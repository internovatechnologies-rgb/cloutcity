'use client'

import layoutJson from '@data/config/layout.json'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { copy } from '@/lib/copy'
import { moderationConfig } from '@/lib/forms/report'
import { log } from '@/lib/log'
import { rpcErrorText } from '@/lib/safety/errorCopy'
import type { ReportKind } from '@/lib/safety/reports'
import { safetyApi as defaultApi, type SafetyApi } from '@/lib/supabase/safetyApi'
import { showSafetyToast } from '@/state/safetyToast'
import { BlockConfirm } from './BlockConfirm'
import { ReportForm, type ReportOutcome } from './ReportForm'
import { SAFETY_BUTTON } from './styles'
// Copy namespaces this module renders (DEC-11: they load with this module's chunk).
import '@/lib/copy/ns/safety'

/** The player the actions are about: their id and the handle shown to this player. */
export interface ActionTarget {
  readonly id: string
  readonly handle: string
}

/**
 * `inline`: the actions as a row of buttons (a player card, a friend list row). `menu`: one
 * Options button that reveals them (a map avatar, a crowded list). Either way every action is
 * at most two taps away.
 */
export type PlayerActionsLayout = 'inline' | 'menu'

/** The actions, in this order on every surface. Add friend joins with S20. */
export const PLAYER_ACTIONS = ['addFriend', 'mute', 'block', 'report'] as const
export type PlayerAction = (typeof PLAYER_ACTIONS)[number]

type View = 'actions' | 'block' | 'report'

/** When an Undo offered now closes. */
const msFromNow = (ms: number) => Date.now() + ms

/**
 * When a block's Undo closes: the server's `undo_expires_at` when it is sooner, else
 * `blockUndoSeconds` from when the request was sent (the server's window cannot have opened
 * before that). An Undo after the server's window would only unblock without restoring what
 * the block ended.
 */
export function blockUndoUntil(sentAtMs: number, serverExpiresAt: string): number {
  const local = sentAtMs + moderationConfig.blockUndoSeconds * 1000
  const server = Date.parse(serverExpiresAt)
  return Number.isNaN(server) ? local : Math.min(local, server)
}

/**
 * The one player-actions component every player surface uses (S18b; CLAUDE.md "Block, mute,
 * report on every player surface"): Add friend (hidden until S20 builds friends), Mute, Block and
 * Report. Mute acts at once with an Undo toast; Block asks first (BlockConfirm), then shows an
 * Undo toast for `moderation.blockUndoSeconds`, which also restores what the block ended; Report
 * opens the report form. The server decides every outcome; a refusal is shown in plain words.
 */
export function PlayerActions({
  player,
  layout = 'inline',
  api = defaultApi,
  reportKind = 'player',
  initiallyMuted = false,
  initiallyBlocked = false,
}: {
  readonly player: ActionTarget
  readonly layout?: PlayerActionsLayout
  readonly api?: SafetyApi
  readonly reportKind?: ReportKind
  readonly initiallyMuted?: boolean
  readonly initiallyBlocked?: boolean
}) {
  const handle = player.handle
  const listId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<View>('actions')
  const [menuOpen, setMenuOpen] = useState(layout === 'inline')
  const [muted, setMuted] = useState(initiallyMuted)
  const [blocked, setBlocked] = useState(initiallyBlocked)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const focusAction = useCallback((action: PlayerAction) => {
    requestAnimationFrame(() =>
      rootRef.current?.querySelector<HTMLElement>(`[data-player-action="${action}"]`)?.focus(),
    )
  }, [])

  const backToActions = useCallback(
    (focus: PlayerAction) => {
      setView('actions')
      focusAction(focus)
    },
    [focusAction],
  )

  // Escape closes the menu and gives focus back to its button.
  useEffect(() => {
    const element = rootRef.current
    if (element === null || layout !== 'menu' || !menuOpen || view !== 'actions') return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setMenuOpen(false)
      triggerRef.current?.focus()
    }
    element.addEventListener('keydown', onKeyDown)
    return () => element.removeEventListener('keydown', onKeyDown)
  }, [layout, menuOpen, view])

  const fail = (code: Parameters<typeof rpcErrorText>[0], what: string) => {
    log.info(`A ${what} was refused`, { code })
    setError(rpcErrorText(code))
  }

  async function toggleMute() {
    if (busy) return
    setBusy(true)
    setError(null)
    if (muted) {
      const result = await api.unmute(player.id)
      setBusy(false)
      if (!result.ok) return fail(result.code, 'unmute')
      setMuted(false)
      showSafetyToast(copy('safety.toast.unmuted', { handle }))
      return
    }
    const result = await api.mute(player.id)
    setBusy(false)
    if (!result.ok) return fail(result.code, 'mute')
    setMuted(true)
    showSafetyToast(copy('safety.toast.muted', { handle }), {
      label: copy('safety.toast.undoLabel', { handle }),
      untilMs: msFromNow(layoutJson.overlay.toastMs),
      run: () => {
        void api.unmute(player.id).then((undone) => {
          if (!undone.ok) {
            showSafetyToast(rpcErrorText(undone.code))
            return
          }
          setMuted(false)
          showSafetyToast(copy('safety.toast.unmuted', { handle }))
        })
      },
    })
  }

  async function block(): Promise<boolean> {
    const sentAt = Date.now()
    const result = await api.block(player.id)
    if (!result.ok) {
      fail(result.code, 'block')
      return false
    }
    setBlocked(true)
    const { undoId, undoExpiresAt, friendshipEnded, roommateEnded } = result.data
    const ended = friendshipEnded || roommateEnded
    const text = copy(ended ? 'safety.toast.blockedEnded' : 'safety.toast.blocked', { handle })
    // Already blocked (another surface or device): nothing changed, so there is no Undo.
    if (undoId === null || undoExpiresAt === null) {
      showSafetyToast(text)
      return true
    }
    showSafetyToast(text, {
      label: copy('safety.toast.undoLabel', { handle }),
      untilMs: blockUndoUntil(sentAt, undoExpiresAt),
      run: () => {
        void api.unblock(player.id, undoId).then((undone) => {
          if (!undone.ok) {
            showSafetyToast(rpcErrorText(undone.code))
            return
          }
          setBlocked(false)
          const restored = undone.data.friendshipRestored || undone.data.roommateRestored
          showSafetyToast(
            copy(restored ? 'safety.toast.restored' : 'safety.toast.unblocked', { handle }),
          )
        })
      },
    })
    return true
  }

  async function confirmBlock() {
    if (busy) return
    setBusy(true)
    setError(null)
    await block()
    setBusy(false)
    backToActions('block')
  }

  async function unblock() {
    if (busy) return
    setBusy(true)
    setError(null)
    const result = await api.unblock(player.id)
    setBusy(false)
    if (!result.ok) return fail(result.code, 'unblock')
    setBlocked(false)
    showSafetyToast(copy('safety.toast.unblocked', { handle }))
  }

  async function reported(outcome: ReportOutcome) {
    if (outcome.alsoBlock && !blocked) {
      setBusy(true)
      const done = await block()
      setBusy(false)
      if (done) {
        showSafetyToast(copy('safety.toast.reportedBlocked', { handle }))
        backToActions('report')
        return
      }
    }
    showSafetyToast(
      copy(outcome.duplicate ? 'safety.toast.reportedAgain' : 'safety.toast.reported', { handle }),
    )
    backToActions('report')
  }

  const actionButton = (action: Exclude<PlayerAction, 'addFriend'>) => {
    const props = {
      mute: {
        label: copy(muted ? 'safety.actions.unmute' : 'safety.actions.mute'),
        name: copy(muted ? 'safety.actions.unmuteLabel' : 'safety.actions.muteLabel', { handle }),
        onClick: () => void toggleMute(),
        pressed: muted,
      },
      block: {
        label: copy(blocked ? 'safety.actions.unblock' : 'safety.actions.block'),
        name: copy(blocked ? 'safety.actions.unblockLabel' : 'safety.actions.blockLabel', {
          handle,
        }),
        onClick: () => {
          if (blocked) void unblock()
          else {
            setError(null)
            setView('block')
          }
        },
        pressed: undefined,
      },
      report: {
        label: copy('safety.actions.report'),
        name: copy('safety.actions.reportLabel', { handle }),
        onClick: () => {
          setError(null)
          setView('report')
        },
        pressed: undefined,
      },
    }[action]
    return (
      <li key={action}>
        <button
          type="button"
          data-player-action={action}
          aria-label={props.name}
          aria-pressed={props.pressed}
          aria-disabled={busy ? true : undefined}
          onClick={props.onClick}
          className={`${SAFETY_BUTTON} w-full ${
            action === 'report' ? 'bg-taxi text-on-taxi' : 'bg-raised text-fg'
          }`}
        >
          {props.label}
        </button>
      </li>
    )
  }

  const actions = (
    <ul
      id={listId}
      aria-label={copy('safety.actions.group', { handle })}
      className={layout === 'inline' ? 'grid grid-cols-3 gap-2' : 'flex flex-col gap-1.5 pt-1'}
    >
      {(['mute', 'block', 'report'] as const).map(actionButton)}
    </ul>
  )

  return (
    <div ref={rootRef} data-player-actions={layout} className="flex flex-col gap-2">
      {view === 'block' ? (
        <BlockConfirm
          handle={handle}
          busy={busy}
          onConfirm={() => void confirmBlock()}
          onCancel={() => backToActions('block')}
        />
      ) : view === 'report' ? (
        <ReportForm
          handle={handle}
          target={player.id}
          kind={reportKind}
          api={api}
          onSubmitted={(outcome) => void reported(outcome)}
          onCancel={() => backToActions('report')}
        />
      ) : layout === 'menu' ? (
        <div className="flex flex-col">
          <button
            ref={triggerRef}
            type="button"
            data-player-actions-menu=""
            aria-expanded={menuOpen}
            aria-controls={listId}
            aria-label={copy('safety.actions.menuLabel', { handle })}
            onClick={() => setMenuOpen((open) => !open)}
            className={`${SAFETY_BUTTON} self-start bg-raised text-fg`}
          >
            {copy('safety.actions.menu')}
          </button>
          {menuOpen ? actions : null}
        </div>
      ) : (
        actions
      )}
      {error === null ? null : (
        <p role="alert" className="text-sm font-semibold text-danger">
          {error}
        </p>
      )}
    </div>
  )
}
