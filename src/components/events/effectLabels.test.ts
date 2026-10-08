import { describe, expect, it } from 'vitest'
import { effectLabel, effectsSummary, eventText } from './effectLabels'

describe('event effect labels', () => {
  it('formats money with the shared formatter, gains and costs apart', () => {
    expect(effectLabel({ kind: 'cash', amount: 30 })).toBe('Get $30')
    expect(effectLabel({ kind: 'cash', amount: -1100 })).toBe('Costs $1,100')
  })

  it('names stats plainly, with a sign', () => {
    expect(effectLabel({ kind: 'stat', stat: 'mood', amount: 8 })).toBe('+8 mood')
    expect(effectLabel({ kind: 'stat', stat: 'hunger', amount: 25 })).toBe('+25 fullness')
    expect(effectLabel({ kind: 'stat', stat: 'energy', amount: -6 })).toBe('-6 energy')
  })

  it('covers time, clout and items', () => {
    expect(effectLabel({ kind: 'time', minutes: 90 })).toBe('90 min')
    expect(effectLabel({ kind: 'clout', amount: 3 })).toBe('+3 clout')
    expect(effectLabel({ kind: 'clout', amount: -2 })).toBe('-2 clout')
    expect(effectLabel({ kind: 'item', itemId: 'tee', op: 'grant' })).toBe('New item')
    expect(effectLabel({ kind: 'item', itemId: 'tee', op: 'consume' })).toBe('Uses an item')
  })

  it('joins a choice into one line, and is empty for no effects', () => {
    expect(
      effectsSummary([
        { kind: 'cash', amount: -2 },
        { kind: 'time', minutes: 5 },
        { kind: 'stat', stat: 'mood', amount: 10 },
      ]),
    ).toBe('Costs $2, 5 min, +10 mood')
    expect(effectsSummary([])).toBe('')
  })

  it('renders event copy keys and throws on an unknown one', () => {
    expect(eventText('events.bodegaCat.scratch.label')).toBe('Pet the cat')
    expect(() => eventText('events.nope.title')).toThrow(/Unknown copy key/)
  })
})
