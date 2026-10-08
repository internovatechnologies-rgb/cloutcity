import { describe, expect, it } from 'vitest'
import { pickPin, type ScreenPin } from './pick'

const options = { hitRadiusPx: 24, ambiguityPx: 6 }
const pin = (id: string, x: number, y: number): ScreenPin => ({ id, x, y })

describe('pickPin', () => {
  it('picks nothing when every pin is beyond the hit radius', () => {
    expect(pickPin([pin('a', 100, 100)], { x: 125, y: 100 }, options)).toEqual({ kind: 'none' })
    expect(pickPin([], { x: 0, y: 0 }, options)).toEqual({ kind: 'none' })
  })

  it('hits a pin anywhere within the radius: a target at least 44 px across', () => {
    for (const [dx, dy] of [
      [0, 0],
      [24, 0],
      [0, -24],
      [-16, 16],
    ] as const) {
      expect(pickPin([pin('a', 100, 100)], { x: 100 + dx, y: 100 + dy }, options)).toEqual({
        kind: 'one',
        id: 'a',
      })
    }
  })

  it('picks the nearest pin when the next one is clearly farther', () => {
    const pins = [pin('far', 120, 100), pin('near', 102, 100)]
    expect(pickPin(pins, { x: 100, y: 100 }, options)).toEqual({ kind: 'one', id: 'near' })
  })

  it('offers a choice, nearest first, when pins are within the ambiguity margin', () => {
    const pins = [pin('b', 105, 100), pin('a', 100, 100), pin('c', 140, 100), pin('d', 98, 104)]
    expect(pickPin(pins, { x: 101, y: 100 }, options)).toEqual({
      kind: 'many',
      ids: ['a', 'b', 'd'],
    })
  })

  it('treats stacked pins as ambiguous, in layer order', () => {
    const pins = [pin('first', 50, 50), pin('second', 50, 50)]
    expect(pickPin(pins, { x: 60, y: 50 }, options)).toEqual({
      kind: 'many',
      ids: ['first', 'second'],
    })
  })

  it('never offers a pin outside the hit radius, even within the margin of the nearest', () => {
    const pins = [pin('in', 120, 100), pin('out', 126, 100)]
    expect(pickPin(pins, { x: 100, y: 100 }, options)).toEqual({ kind: 'one', id: 'in' })
  })
})
