'use client'

import { copy, type CopyKey } from '@/lib/copy'
import { useModalPresence } from './modalState'

/** Where a lazy island renders: an overlay zone, or the modal layer. */
export type IslandZone = 'banner' | 'hud' | 'toast' | 'sheet' | 'modal'

interface ZoneStateProps {
  readonly zone: IslandZone
  /** Names what is loading ("Loading this place"); also the status's accessible name. */
  readonly labelKey: CopyKey
}

// The modal layer sits in a grid cell that ignores touches; its card takes them back.
// The banner, HUD and toast zones are one short row: their states stay a single compact line.
const CARD: Readonly<Record<IslandZone, string>> = {
  banner: 'mx-2 flex h-full items-center gap-2 rounded-2xl border border-line glass px-3',
  hud: 'flex items-center gap-2',
  toast: 'mx-2 flex items-center gap-2 rounded-2xl border border-line glass px-3 py-1 shadow-lg',
  sheet: 'm-2 rounded-2xl border border-line glass p-3 shadow-lg',
  modal:
    'pointer-events-auto w-full max-w-[var(--overlay-sheet-max-w)] self-center rounded-3xl border border-line glass p-5 shadow-2xl',
}

const COMPACT: ReadonlySet<IslandZone> = new Set(['banner', 'hud', 'toast'])

// The HUD row has no room for the sentence beside the title: it stays for screen readers only.
const FAILED_TEXT: Readonly<Record<IslandZone, string>> = {
  banner: 'min-w-0 flex-1 text-xs leading-tight text-fg',
  hud: 'sr-only',
  toast: 'min-w-0 flex-1 text-xs leading-tight text-fg',
  sheet: 'text-sm text-fg',
  modal: 'text-sm text-fg',
}

/** A modal placeholder keeps the page behind it inert: the gate fails closed while it loads. */
function ModalPresence({ zone }: { readonly zone: IslandZone }) {
  useModalPresence(zone === 'modal')
  return null
}

/**
 * The loading state of a lazy feature, drawn inside its own zone (UX-1). The status is
 * announced at once; the skeleton only appears after the reveal delay (`.cc-reveal`), so a fast
 * load shows nothing.
 */
export function ZoneLoading({ zone, labelKey }: ZoneStateProps) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={copy(labelKey)}
      data-zone-loading={zone}
      className={CARD[zone]}
    >
      <ModalPresence zone={zone} />
      {COMPACT.has(zone) ? (
        <div aria-hidden="true" className="cc-reveal flex flex-col items-end gap-1">
          <div className="h-3 w-16 rounded-full bg-pressed motion-safe:animate-pulse" />
          <div className="h-2 w-28 rounded-full bg-raised motion-safe:animate-pulse" />
        </div>
      ) : (
        <div aria-hidden="true" className="cc-reveal flex flex-col gap-2">
          <div className="h-4 w-1/2 rounded-full bg-pressed motion-safe:animate-pulse" />
          <div className="h-3 w-5/6 rounded-full bg-raised motion-safe:animate-pulse" />
          <div className="h-11 w-full rounded-xl bg-raised motion-safe:animate-pulse" />
        </div>
      )}
    </div>
  )
}

/** A feature that failed to load (offline, a dropped chunk), with a retry, inside its zone. */
export function ZoneLoadFailed({
  zone,
  onRetry,
}: {
  readonly zone: IslandZone
  readonly onRetry: () => void
}) {
  return (
    <div
      data-zone-error={zone}
      className={COMPACT.has(zone) ? CARD[zone] : `${CARD[zone]} flex flex-col gap-2`}
    >
      <ModalPresence zone={zone} />
      <p className={FAILED_TEXT[zone]}>{copy('loading.failed')}</p>
      <button
        type="button"
        onClick={onRetry}
        className="min-h-11 self-start rounded-full bg-taxi px-5 text-sm font-extrabold text-on-taxi focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        {copy('loading.retry')}
      </button>
    </div>
  )
}
