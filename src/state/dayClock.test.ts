import { describe, expect, it, vi } from 'vitest'
import { dayClockStore, setMinuteOfDay } from './dayClock'

describe('day clock store', () => {
  it('starts unknown, records the minute of day and notifies only on a change', () => {
    expect(dayClockStore.getState().minuteOfDay).toBeNull()
    const listener = vi.fn()
    const stop = dayClockStore.subscribe(listener)
    setMinuteOfDay(600)
    setMinuteOfDay(600)
    expect(dayClockStore.getState().minuteOfDay).toBe(600)
    expect(listener).toHaveBeenCalledTimes(1)
    setMinuteOfDay(0)
    expect(listener).toHaveBeenCalledTimes(2)
    stop()
  })

  it.each([-1, 1440, 12.5, Number.NaN])('rejects %s', (minute) => {
    expect(() => setMinuteOfDay(minute)).toThrow(/minute of day/)
  })
})
