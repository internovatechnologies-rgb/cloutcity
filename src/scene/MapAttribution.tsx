interface MapAttributionProps {
  readonly nyc: string
  readonly mta: string
  /** One-line form for a short free scene row (landscape phones). */
  readonly compact: string
  readonly credits: string
  /** The chip's label ("Map data"). */
  readonly toggle: string
  /** The overlay grid rows and free scene row (src/components/overlay/layers.ts). */
  readonly gridTemplateRows: string
  readonly row: number
}

/**
 * Required map attribution (NYC Open Data, MTA; data/geo/SOURCES.md). A compact "ⓘ Map data"
 * chip in the bottom-end corner of the free scene row, so it never covers the middle of the map
 * on a phone (UX-9) nor any HUD, sheet, toast or tab bar (UX-1); one tap opens the attribution
 * and the link to /credits, where the full text lives. A native `<details>`: no JavaScript, so
 * nothing joins the shell, and it opens with the keyboard as well as a tap. When the row is too
 * short for the two-line text, a container query (globals.css, `.map-attribution-row`) swaps in
 * the one-line form; the row never shrinks below one 44 px target (layout.json
 * `freeSceneMinHeightPx`). It hides while the apartment has the screen (globals.css, UI-16): it
 * credits the map, and comes back with it.
 *
 * The credits link is a plain anchor, not next/link: next/link would cost the shell bundle about
 * 4.6 KB gz for one rarely used navigation.
 */
export function MapAttribution({
  nyc,
  mta,
  compact,
  credits,
  toggle,
  gridTemplateRows,
  row,
}: MapAttributionProps) {
  return (
    <div
      data-map-attribution-layer=""
      className="pointer-events-none absolute inset-0 grid grid-cols-1"
      style={{ gridTemplateRows }}
    >
      <div
        className="map-attribution-row flex min-h-0 items-end justify-end overflow-hidden px-2 py-1"
        style={{ gridRow: row }}
      >
        <details
          data-map-attribution=""
          className="pointer-events-auto relative text-[11px] leading-snug text-muted"
        >
          <summary className="flex min-h-11 min-w-11 cursor-pointer list-none items-center justify-end gap-1 rounded-lg glass px-3 font-semibold text-fg focus-visible:outline-2 focus-visible:outline-focus [&::-webkit-details-marker]:hidden">
            <span aria-hidden="true">ⓘ</span>
            {toggle}
          </summary>
          {/* Opens to the left of the chip, on the same bottom line, so it fits the shortest free
              row (one 44 px target tall) and never reaches into another zone. */}
          <div className="absolute right-full bottom-0 mr-1 flex w-max max-w-[calc(100vw-7.5rem)] items-center gap-2 rounded-lg glass py-0.5 pr-0.5 pl-2">
            <p className="map-attribution-full">
              {nyc}
              <br />
              {mta}
            </p>
            {/* Wraps rather than truncates: it is required attribution, so it must be readable
                in full. Two 11 px lines fit beside the 44 px Credits target. */}
            <p className="map-attribution-compact">{compact}</p>
            <a
              href="/credits"
              className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md px-2 font-semibold text-fg underline focus-visible:outline-2 focus-visible:outline-focus"
            >
              {credits}
            </a>
          </div>
        </details>
      </div>
    </div>
  )
}
