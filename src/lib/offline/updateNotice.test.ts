import { describe, expect, it } from 'vitest'
import { updateIds } from './serviceWorker'
import { updateNoticeShown, type UpdateNoticeState } from './updateNotice'

const WAITING: UpdateNoticeState = {
  update: 1,
  dismissed: null,
  modalOpen: false,
  touring: false,
}

describe('updateNoticeShown', () => {
  it('shows when a new build waits and nothing else holds the screen', () => {
    expect(updateNoticeShown(WAITING)).toBe(true)
  })

  it('stays hidden with no waiting build, or once that build is put off', () => {
    expect(updateNoticeShown({ ...WAITING, update: null })).toBe(false)
    expect(updateNoticeShown({ ...WAITING, dismissed: 1 })).toBe(false)
  })

  it('offers a newer build again after an older one was put off (F6)', () => {
    expect(updateNoticeShown({ ...WAITING, update: 2, dismissed: 1 })).toBe(true)
  })

  it('waits behind a modal and the tour, and shows once both are gone', () => {
    expect(updateNoticeShown({ ...WAITING, modalOpen: true })).toBe(false)
    expect(updateNoticeShown({ ...WAITING, touring: true })).toBe(false)
    expect(updateNoticeShown({ ...WAITING, modalOpen: true, touring: true })).toBe(false)
    // The same waiting build, after the tour ends and the modal closes.
    expect(updateNoticeShown({ ...WAITING, modalOpen: false, touring: false })).toBe(true)
  })
})

describe('updateIds', () => {
  it('gives each worker one id, in order of arrival', () => {
    const idOf = updateIds()
    const first = {} as ServiceWorker
    const second = {} as ServiceWorker
    expect(idOf(first)).toBe(1)
    expect(idOf(second)).toBe(2)
    // The waiting worker that later controls the page is the same object: the same id.
    expect(idOf(first)).toBe(1)
  })
})
