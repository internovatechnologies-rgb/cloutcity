/**
 * Nothing overrides the player's sound choice, and nothing starts audio behind their back:
 *  - "My own music" (the onboarding `audioChoice`) is written only by the welcome card and
 *    src/lib/audio/controls.ts;
 *  - volumes are written only by the audio modules (settings sheet, store, runtime);
 *  - an AudioContext is created only in src/lib/audio/unlock.ts, from a deliberate tap (GR-13);
 *  - no app code touches navigator.mediaSession or creates <audio>/<video> elements to play.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '../../..')
const SRC = join(ROOT, 'src')

const sources = readdirSync(SRC, { withFileTypes: true, recursive: true })
  .filter((entry) => entry.isFile() && /\.[jt]sx?$/.test(entry.name))
  .map((entry) => relative(ROOT, join(entry.parentPath, entry.name)).split('\\').join('/'))
  .filter((file) => !/\.(test|spec)\.[jt]sx?$/.test(file) && !file.endsWith('/fakeWebAudio.ts'))

/** Files (outside `allowed`) whose code matches `pattern`. Comments are stripped first. */
function offenders(pattern: RegExp, allowed: readonly string[]): string[] {
  return sources.filter((file) => {
    if (allowed.some((prefix) => file === prefix || file.startsWith(prefix))) return false
    const code = readFileSync(join(ROOT, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
    return pattern.test(code)
  })
}

const CALL_SET_AUDIO_CHOICE = /\bsetAudioChoice\s*\(/
const CALL_COMPLETE_ADULT = /\bcompleteAdult\s*\(/
const CALL_SET_VOLUME = /\bsetVolume\s*\(/
const NEW_AUDIO_CONTEXT = /\bnew\s+(?:window\.|globalThis\.|self\.)?(?:webkit)?AudioContext\b/
const AUDIO_CONTEXT_VALUE = /\b(?:window|globalThis|self)\.(?:webkit)?AudioContext\b/
const MEDIA_SESSION = /\bmediaSession\b/
const MEDIA_ELEMENT =
  /\bnew\s+Audio\s*\(|createElement\(\s*['"]video['"]|<audio\b|<video\b|createMediaElementSource/

const GLOBAL_GESTURE_LISTENER =
  /\b(?:document|window|globalThis|self|document\.body|document\.documentElement)\s*\.\s*(?:addEventListener\s*\(\s*['"](?:click|pointerdown|pointerup|mousedown|mouseup|touchstart|touchend|keydown|keyup|keypress)['"]|on(?:click|pointerdown|pointerup|mousedown|mouseup|touchstart|touchend|keydown|keyup|keypress)\s*=)/
const CREATE_AUDIO_ELEMENT = /createElement\(\s*['"]audio['"]/

describe('nothing overrides the sound choice (S05b)', () => {
  it('scans the app sources', () => {
    expect(sources).toContain('src/lib/audio/unlock.ts')
    expect(sources).toContain('src/components/welcome/WelcomeCard.tsx')
  })

  it('only the welcome card and controls.ts change "My own music"', () => {
    const allowed = [
      'src/components/welcome/WelcomeCard.tsx',
      'src/lib/audio/controls.ts',
      // Declares and defines the actions.
      'src/state/onboarding.ts',
    ]
    expect(offenders(CALL_SET_AUDIO_CHOICE, allowed)).toEqual([])
    expect(offenders(CALL_COMPLETE_ADULT, allowed)).toEqual([])
  })

  it('only the audio modules set volumes', () => {
    const allowed = ['src/lib/audio/', 'src/components/audio/', 'src/state/audioSettings.ts']
    expect(offenders(CALL_SET_VOLUME, allowed)).toEqual([])
  })

  it('only unlock.ts creates or reaches for an AudioContext', () => {
    expect(offenders(NEW_AUDIO_CONTEXT, ['src/lib/audio/unlock.ts'])).toEqual([])
    expect(offenders(AUDIO_CONTEXT_VALUE, ['src/lib/audio/unlock.ts'])).toEqual([])
  })

  it('no app code touches the media session or plays through media elements', () => {
    expect(offenders(MEDIA_SESSION, [])).toEqual([])
    expect(offenders(MEDIA_ELEMENT, [])).toEqual([])
  })

  it('no document- or window-level gesture listeners (only a deliberate tap on the sound choice unlocks)', () => {
    expect(offenders(GLOBAL_GESTURE_LISTENER, [])).toEqual([])
  })

  it('the only <audio> element is the detached canPlayType probe in runtime.ts, never attached or played', () => {
    expect(offenders(CREATE_AUDIO_ELEMENT, ['src/lib/audio/runtime.ts'])).toEqual([])
    const runtime = readFileSync(join(ROOT, 'src/lib/audio/runtime.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
    expect(runtime.match(new RegExp(CREATE_AUDIO_ELEMENT.source, 'g'))).toHaveLength(1)
    expect(runtime).not.toMatch(/\bprobe\??\.(?:play|load|src|srcObject|setAttribute)\b/)
    expect(runtime).not.toMatch(
      /\b(?:appendChild|append|prepend|insertBefore|replaceChildren)\s*\(\s*probe\b/,
    )
  })

  it('the patterns see what they must (self-check)', () => {
    expect(CALL_SET_AUDIO_CHOICE.test("store.getState().setAudioChoice('own')")).toBe(true)
    expect(CALL_SET_VOLUME.test('state.setVolume(channel, 5, now)')).toBe(true)
    expect(NEW_AUDIO_CONTEXT.test('const c = new window.AudioContext()')).toBe(true)
    expect(NEW_AUDIO_CONTEXT.test('new webkitAudioContext()')).toBe(true)
    expect(AUDIO_CONTEXT_VALUE.test('const C = window.AudioContext')).toBe(true)
    expect(NEW_AUDIO_CONTEXT.test('attach(context: AudioContext)')).toBe(false)
    expect(MEDIA_ELEMENT.test('const a = new Audio("/x.mp3")')).toBe(true)
    expect(MEDIA_ELEMENT.test('<audio src="x" />')).toBe(true)
    expect(GLOBAL_GESTURE_LISTENER.test("document.addEventListener('pointerdown', unlock)")).toBe(
      true,
    )
    expect(GLOBAL_GESTURE_LISTENER.test('window.addEventListener("keydown", f)')).toBe(true)
    expect(GLOBAL_GESTURE_LISTENER.test('document.body.onclick = f')).toBe(true)
    expect(GLOBAL_GESTURE_LISTENER.test("document.addEventListener('visibilitychange', f)")).toBe(
      false,
    )
    expect(CREATE_AUDIO_ELEMENT.test("document.createElement('audio')")).toBe(true)
  })
})
