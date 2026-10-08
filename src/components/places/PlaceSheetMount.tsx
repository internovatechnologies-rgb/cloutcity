'use client'

import { useEffect } from 'react'
import { lazyIsland } from '@/components/overlay/lazyIsland'
import { log } from '@/lib/log'
import { useOpenPlaceId, usePlaceAnnouncement } from '@/state/placeSheet'
import { useActiveTrip } from '@/state/trip'

// DEC-11: the shell carries only the boot path. The action sheet, with the game store, engine,
// place data and copy it needs, loads in its own chunk the first time a place opens, with a
// loading state in the sheet zone.
const PlaceSheet = lazyIsland(() => import('./PlaceSheet').then((module) => module.PlaceSheet), {
  zone: 'sheet',
  labelKey: 'loading.place',
})

/**
 * The sheet zone's place slot: nothing until a place is opened (`openPlace`), then the lazily
 * loaded action sheet (or, while a trip animates, its progress card). In builds with test hooks the e2e hook is installed from its own chunk,
 * so no test code ships in the shell (or at all in production).
 *
 * The selection status (S04c, A11Y-3) is always rendered, so screen readers already track the
 * live region when the first place is picked, from the map or the Places panel. It is passive
 * (`data-overlay-passive`): on its own it does not make the sheet zone catch touches meant for
 * the map (OverlayLayout).
 */
export function PlaceSheetMount() {
  const placeId = useOpenPlaceId()
  const announcement = usePlaceAnnouncement()
  // A trip under way (S08) shows its progress card in the place slot until it lands.
  const travelling = useActiveTrip() !== null

  useEffect(() => {
    // Inlined at build time (next.config.ts): production builds drop the hook entirely.
    if (process.env.NEXT_PUBLIC_TEST_HOOKS !== '1') return
    import('./placeTestHook').then(
      (module) => module.installPlaceTestHook(),
      // Offline before the chunk was cached: tests then see no hook, players never load it.
      () => log.info('The place test hook could not load'),
    )
  }, [])

  return (
    <>
      <p role="status" data-overlay-passive="" data-place-announcer="" className="sr-only">
        {announcement}
      </p>
      {placeId === null && !travelling ? null : <PlaceSheet placeId={placeId} />}
    </>
  )
}
