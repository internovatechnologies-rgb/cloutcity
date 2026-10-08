import { afterEach, describe, expect, it } from 'vitest'
import type { ApartmentView } from '@/scene/apartment/types'
import {
  apartmentViewStore,
  onApartmentSlotTap,
  setApartmentView,
  tapApartmentSlot,
} from './apartmentView'

afterEach(() => setApartmentView(null))

const view: ApartmentView = {
  home: 'queens-room',
  placed: {},
  heldKind: null,
  selectedSlotId: null,
  label: 'Your apartment, Queens room',
  minute: 0,
  tier: 'mid',
}

describe('apartment view', () => {
  it('holds the Home panel view until the panel clears it', () => {
    expect(apartmentViewStore.getState().view).toBeNull()
    setApartmentView(view)
    expect(apartmentViewStore.getState().view).toBe(view)
    setApartmentView(null)
    expect(apartmentViewStore.getState().view).toBeNull()
  })

  it('delivers room taps to listeners until they stop', () => {
    const taps: unknown[] = []
    const stop = onApartmentSlotTap((tap) => taps.push(tap))
    tapApartmentSlot({ kind: 'one', slotId: 'wall-1' })
    stop()
    tapApartmentSlot({ kind: 'many', slotIds: ['wall-1', 'floor-1'] })
    expect(taps).toEqual([{ kind: 'one', slotId: 'wall-1' }])
  })
})
