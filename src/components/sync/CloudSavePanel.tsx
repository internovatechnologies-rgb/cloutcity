'use client'

import { PANEL_BUTTON, PanelDialog } from '@/components/hud/PanelDialog'
import { copy } from '@/lib/copy'
import { closeHudPanel } from '@/state/hudPanel'
import { useSyncStatus } from '@/state/syncStatus'
import { syncSheetText, syncStatusText } from './syncCopy'
// Copy namespaces this module renders (DEC-11: they load with this module's chunk).
import '@/lib/copy/ns/sync'

/**
 * The cloud save panel (S18c), opened from the status chip or the More panel: where the save
 * stands, in a sentence. In a conflict the player keeps this device's progress or takes the
 * account game; while sync is paused or offline they can try again now, after the server refused
 * this device's save they can take the account game instead, and when the account game is from a
 * newer build they can reload. The controls come from the
 * running sync (src/state/cloudSync.ts); without a session there is nothing to press.
 */
export function CloudSavePanel() {
  const { status, rejected, controls } = useSyncStatus()
  const act = (run: () => void) => () => {
    run()
    closeHudPanel()
  }
  return (
    <PanelDialog
      title={copy('sync.sheet.title')}
      panel="cloud"
      feature="cc-feature:cloud-save-panel"
      onClose={closeHudPanel}
    >
      <p data-sync-status-line="" className="text-sm font-semibold text-taxi-ink">
        {syncStatusText(status)}
      </p>
      <p className="text-sm text-fg">{syncSheetText(status)}</p>
      {controls !== null && status === 'conflict' ? (
        <div className="flex flex-col gap-1.5">
          <button
            type="button"
            data-sync-choice="keep-local"
            onClick={act(() => controls.resolveConflict('keep-local'))}
            className={`${PANEL_BUTTON} bg-taxi text-on-taxi`}
          >
            {copy('sync.sheet.keepLocal')}
          </button>
          <button
            type="button"
            data-sync-choice="use-cloud"
            onClick={act(() => controls.resolveConflict('use-cloud'))}
            className={`${PANEL_BUTTON} bg-raised text-fg`}
          >
            {copy('sync.sheet.useCloud')}
          </button>
        </div>
      ) : null}
      {controls !== null && (status === 'paused' || status === 'offline') ? (
        <button
          type="button"
          data-sync-retry=""
          onClick={act(controls.retryNow)}
          className={`${PANEL_BUTTON} bg-raised text-fg`}
        >
          {copy('sync.sheet.retry')}
        </button>
      ) : null}
      {controls !== null && ((status === 'paused' && rejected) || status === 'behind') ? (
        <button
          type="button"
          data-sync-use-cloud=""
          onClick={act(controls.useCloud)}
          className={`${PANEL_BUTTON} bg-raised text-fg`}
        >
          {copy('sync.sheet.useCloud')}
        </button>
      ) : null}
      {status === 'update' ? (
        // The account game came from a newer build: a reload fetches it (and its service
        // worker), after which saving picks back up. Nothing else on this panel can fix it.
        <button
          type="button"
          data-sync-reload=""
          onClick={() => window.location.reload()}
          className={`${PANEL_BUTTON} bg-taxi text-on-taxi`}
        >
          {copy('sync.sheet.reload')}
        </button>
      ) : null}
    </PanelDialog>
  )
}
