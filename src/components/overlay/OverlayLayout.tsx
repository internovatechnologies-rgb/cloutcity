import type { CSSProperties, ReactNode } from 'react'
import { OverlayBackground } from './OverlayBackground'
import {
  MODAL_GRID_ROW,
  OVERLAY_ZONES,
  ZONE_GRID_ROW,
  layerZIndex,
  overlayCssVars,
  overlayGridTemplateRows,
  overlayLayout,
  type OverlayZone,
} from './layers'

export type OverlaySlots = Partial<Record<OverlayZone, ReactNode>>

interface OverlayLayoutProps {
  /** The scene under every overlay (the 3D map from S04a). */
  readonly children: ReactNode
  /** Content for each named zone. A zone is reserved even when empty. */
  readonly slots: OverlaySlots
  /**
   * A modal over everything (the welcome card). It sits between the HUD and the tab bar, and
   * while it reports itself open (modalState.ts) the scene and zones behind it are inert.
   */
  readonly modal?: ReactNode
}

// Width rules per zone. The sheet and toasts stay readable on desktop instead of spanning
// 1280 px; the HUD, banner and tab bar span the full width.
const ZONE_CLASS: Readonly<Record<OverlayZone, string>> = {
  banner: 'w-full',
  hud: 'w-full',
  toast: 'mx-auto w-full max-w-[var(--overlay-sheet-max-w)]',
  sheet: 'mx-auto w-full max-w-[var(--overlay-sheet-max-w)]',
  tabs: 'w-full',
}

// Only toasts announce themselves; everything else is read in document order.
const ZONE_ARIA: Readonly<Partial<Record<OverlayZone, Record<string, string>>>> = {
  toast: { role: 'status', 'aria-live': 'polite' },
}

/**
 * The single way to put UI over the scene (UX-1). Each zone is a grid row, so zones cannot
 * overlap; content that does not fit is clipped to its zone and scrolls inside it. Empty zones
 * let touches fall through to the scene.
 */
export function OverlayLayout({ children, slots, modal }: OverlayLayoutProps) {
  const rootStyle: CSSProperties = { gridTemplateRows: overlayGridTemplateRows(overlayLayout) }

  return (
    // `cc-overlay`: globals.css switches the HUD row to its compact height here (layers.ts).
    <div
      className="cc-overlay fixed inset-0 overflow-hidden"
      style={overlayCssVars(overlayLayout) as CSSProperties}
    >
      <OverlayBackground holdForModal={modal !== undefined} scrimZIndex={layerZIndex('modal')}>
        {/* tabIndex -1: focus lands here when a modal closes. */}
        <main
          tabIndex={-1}
          className="absolute inset-0 focus:outline-none"
          style={{ zIndex: layerZIndex('scene') }}
        >
          {children}
        </main>
        <div
          data-overlay-root=""
          className="pointer-events-none absolute inset-0 grid grid-cols-1"
          style={rootStyle}
        >
          {OVERLAY_ZONES.map((zone) => (
            <div
              key={zone}
              data-overlay-zone={zone}
              className={`min-h-0 overflow-hidden ${ZONE_CLASS[zone]}`}
              style={{ gridRow: ZONE_GRID_ROW[zone], zIndex: layerZIndex(zone) }}
              {...ZONE_ARIA[zone]}
            >
              {slots[zone] === undefined ? null : (
                // `empty:` lets touches through a zone whose client content renders nothing
                // (a sheet with no event or place open), and so does a zone holding only a
                // passive element (an always-present sr-only status, `data-overlay-passive`).
                <div className="pointer-events-auto h-full overflow-y-auto overscroll-contain empty:pointer-events-none [&:has(>[data-overlay-passive]:only-child)]:pointer-events-none">
                  {slots[zone]}
                </div>
              )}
            </div>
          ))}
        </div>
      </OverlayBackground>
      {modal === undefined ? null : (
        <div
          data-overlay-modal=""
          className="pointer-events-none absolute inset-0 grid grid-cols-1"
          style={{ ...rootStyle, zIndex: layerZIndex('modal') }}
        >
          <div
            className="flex min-h-0 justify-center px-3 py-2"
            style={{ gridRow: MODAL_GRID_ROW }}
          >
            {modal}
          </div>
        </div>
      )}
    </div>
  )
}
