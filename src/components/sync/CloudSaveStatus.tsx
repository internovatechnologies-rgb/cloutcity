'use client'

import { useEffect, useRef, useState } from 'react'
import type { HudPanel } from '@/state/hudPanel'
import { useSyncStatus, type SyncStatus } from '@/state/syncStatus'
import { announces, syncLabel, syncStatusText } from './syncCopy'

const SHADE: Readonly<Record<SyncStatus, string>> = {
  local: 'text-muted',
  syncing: 'text-taxi-ink',
  synced: 'text-fg',
  offline: 'text-muted',
  paused: 'text-taxi-ink',
  conflict: 'text-taxi-ink',
  update: 'text-taxi-ink',
  behind: 'text-taxi-ink',
}

/**
 * The cloud save chip (S18c) in the HUD's actions cell where it has room (704 px and wider; at
 * 640 to 703 px Inventory, Rent and the sound controls fill the cell): a 44 px cloud whose
 * accessible name says where the save stands ("Cloud save: Saved on this phone"); it opens the
 * cloud save panel. On phones the same status is a row in the More panel. A polite status line
 * (every width) announces only notable changes (offline, paused, a conflict), never routine
 * saves.
 */
export function CloudSaveStatus({
  open,
  onToggle,
  className,
}: {
  readonly open: HudPanel | null
  readonly onToggle: () => void
  readonly className: string
}) {
  const { status } = useSyncStatus()
  const previous = useRef(status)
  const [announcement, setAnnouncement] = useState('')

  useEffect(() => {
    if (announces(previous.current, status)) setAnnouncement(syncStatusText(status))
    previous.current = status
  }, [status])

  const label = syncLabel(status)
  return (
    <>
      <button
        type="button"
        data-hud-panel="cloud"
        data-sync-status={status}
        aria-label={label}
        title={label}
        aria-expanded={open === 'cloud'}
        onClick={onToggle}
        className={`${className} ${open === 'cloud' ? 'bg-taxi text-on-taxi' : `bg-raised ${SHADE[status]}`}`}
      >
        <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5 fill-current">
          <path d="M7 18a5 5 0 0 1-.9-9.92A6 6 0 0 1 17.6 7.1 4.5 4.5 0 0 1 17.5 18H7z" />
        </svg>
      </button>
      <p role="status" data-sync-announce="" className="sr-only">
        {announcement}
      </p>
    </>
  )
}
