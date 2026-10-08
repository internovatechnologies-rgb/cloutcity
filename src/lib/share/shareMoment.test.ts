import { describe, expect, it, vi } from 'vitest'
import { shareMoment, type ShareNavigator } from './shareMoment'

const TEXT = 'I reached Icon. Tap In. Blow Up. | Clout City: NYC'
const URL = 'https://cloutcity.example'

const named = (name: string) => Object.assign(new Error(name), { name })

describe('shareMoment (S15)', () => {
  it('uses the share sheet with the text and the origin only', async () => {
    const share = vi.fn<(data: ShareData) => Promise<void>>().mockResolvedValue(undefined)
    const writeText = vi.fn<(text: string) => Promise<void>>()
    expect(await shareMoment(TEXT, URL, { share, clipboard: { writeText } })).toEqual({
      kind: 'shared',
    })
    expect(share).toHaveBeenCalledWith({ text: TEXT, url: URL })
    expect(writeText).not.toHaveBeenCalled()
  })

  it('a cancelled share sheet does nothing more', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>()
    const nav: ShareNavigator = {
      share: () => Promise.reject(named('AbortError')),
      clipboard: { writeText },
    }
    expect(await shareMoment(TEXT, URL, nav)).toEqual({ kind: 'cancelled' })
    expect(writeText).not.toHaveBeenCalled()
  })

  it('falls back to the clipboard when sharing is not allowed or missing', async () => {
    for (const share of [() => Promise.reject(named('NotAllowedError')), undefined]) {
      const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)
      const nav: ShareNavigator =
        share === undefined ? { clipboard: { writeText } } : { share, clipboard: { writeText } }
      expect(await shareMoment(TEXT, URL, nav)).toEqual({ kind: 'copied' })
      expect(writeText).toHaveBeenCalledWith(`${TEXT} ${URL}`)
    }
  })

  it('shows the text when neither works', async () => {
    const nav: ShareNavigator = {
      share: () => Promise.reject(named('TypeError')),
      clipboard: { writeText: () => Promise.reject(named('NotAllowedError')) },
    }
    expect(await shareMoment(TEXT, URL, nav)).toEqual({ kind: 'shown', text: `${TEXT} ${URL}` })
    expect(await shareMoment(TEXT, URL, {})).toEqual({ kind: 'shown', text: `${TEXT} ${URL}` })
  })
})
