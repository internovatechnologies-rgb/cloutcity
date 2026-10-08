import { afterEach, describe, expect, it } from 'vitest'
import { sceneFocusStore, setSceneFocus } from './sceneFocus'

afterEach(() => setSceneFocus('city'))

describe('scene focus', () => {
  it('starts on the city and switches to the room and back', () => {
    expect(sceneFocusStore.getState().focus).toBe('city')
    setSceneFocus('room')
    expect(sceneFocusStore.getState().focus).toBe('room')
    setSceneFocus('city')
    expect(sceneFocusStore.getState().focus).toBe('city')
  })

  it('notifies subscribers only when the focus changes', () => {
    let calls = 0
    const stop = sceneFocusStore.subscribe(() => (calls += 1))
    setSceneFocus('room')
    setSceneFocus('room')
    setSceneFocus('city')
    stop()
    expect(calls).toBe(2)
  })
})
