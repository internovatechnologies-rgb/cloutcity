import type { Page } from '@playwright/test'

/** Helpers for audio specs (S05b): count every way a page can start audio, and read the mixer. */

export interface AudioProbe {
  contexts: number
  mediaElements: number
  plays: number
}

export const SILENT: AudioProbe = { contexts: 0, mediaElements: 0, plays: 0 }

/** Counts AudioContexts, media elements and play() calls. Silent: it never logs. */
export async function installAudioProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const probe = { contexts: 0, mediaElements: 0, plays: 0 }
    Object.defineProperty(window, '__audioProbe', { value: probe })
    const w = window as unknown as Record<string, unknown>
    for (const name of ['AudioContext', 'webkitAudioContext', 'OfflineAudioContext']) {
      const Original = w[name] as (new (...args: unknown[]) => object) | undefined
      if (typeof Original !== 'function') continue
      w[name] = class extends Original {
        constructor(...args: unknown[]) {
          super(...args)
          probe.contexts += 1
        }
      }
    }
    const OriginalAudio = window.Audio
    window.Audio = class extends OriginalAudio {
      constructor(src?: string) {
        super(src)
        probe.mediaElements += 1
      }
    }
    const play = HTMLMediaElement.prototype.play
    HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
      probe.plays += 1
      return play.call(this)
    }
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof HTMLMediaElement) probe.mediaElements += 1
          if (node instanceof Element)
            probe.mediaElements += node.querySelectorAll('audio, video').length
        }
      }
    }).observe(document, { childList: true, subtree: true })
  })
}

export const probeOf = (page: Page): Promise<AudioProbe> =>
  page.evaluate(() => (window as unknown as { __audioProbe: AudioProbe }).__audioProbe)

const AUDIO_PATH = /\/audio\/|\.(mp3|ogg|oga|opus|wav|m4a|aac|flac|weba|webm)(\?|$)/i

/** Every audio request the page makes (by path, resource type or response type). */
export function trackAudioRequests(page: Page): string[] {
  const found: string[] = []
  page.on('request', (request) => {
    if (request.resourceType() === 'media' || AUDIO_PATH.test(request.url())) {
      found.push(request.url())
    }
  })
  page.on('response', (response) => {
    const type = response.headers()['content-type'] ?? ''
    if (type.startsWith('audio/') && !AUDIO_PATH.test(response.url())) {
      found.push(`${response.url()} (${type})`)
    }
  })
  return found
}

type Gains = Record<'master' | 'music' | 'sfx' | 'ambience' | 'voice', number>

/** The e2e audio hook (src/lib/audio/testHook.ts); throws until the runtime has loaded. */
export const audio = {
  ready: (page: Page) => page.evaluate(() => window.__cloutcityTest?.audio !== undefined),
  contextState: (page: Page) =>
    page.evaluate(() => window.__cloutcityTest?.audio?.contextState() ?? 'no-runtime'),
  gains: (page: Page): Promise<Gains> =>
    page.evaluate(() => {
      const hook = window.__cloutcityTest?.audio
      if (hook === undefined) throw new Error('audio runtime not loaded')
      return hook.gains()
    }),
  targetGains: (page: Page): Promise<Gains> =>
    page.evaluate(() => {
      const hook = window.__cloutcityTest?.audio
      if (hook === undefined) throw new Error('audio runtime not loaded')
      return hook.targetGains()
    }),
  playing: (page: Page) =>
    page.evaluate(
      () => window.__cloutcityTest?.audio?.playing() ?? { music: null, ambience: null },
    ),
  sfxStarted: (page: Page) =>
    page.evaluate(() => window.__cloutcityTest?.audio?.sfxStarted() ?? -1),
  playSfx: (page: Page, id: 'ui-tap' | 'purchase' | 'clout-up') =>
    page.evaluate((sfx) => window.__cloutcityTest?.audio?.playSfx(sfx), id),
}

/** The squared slider curve of src/lib/audio/mixer.ts, as float32 like AudioParam.value. */
export const gainOf = (volume: number) => Math.fround((volume / 100) ** 2)
