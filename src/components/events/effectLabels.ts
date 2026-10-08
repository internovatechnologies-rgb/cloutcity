import { copy, type CopyKey } from '@/lib/copy'
import { formatCount, formatMoney } from '@/lib/format'
import type { EventEffect } from '@/lib/data/schemas/content'
// Copy namespaces this module renders (DEC-11: they load with this module's chunk).
import '@/lib/copy/ns/events'

/**
 * Renders a copy key named by event data. The keys are checked against data/copy/events/base.json by
 * src/lib/data/events.test.ts, so the cast cannot reach a player as a missing string.
 */
export function eventText(key: string): string {
  return copy(key as CopyKey)
}

/** Plain text for one effect ("Costs $25", "30 min", "+8 mood"), in the place-action style. */
export function effectLabel(effect: EventEffect): string {
  switch (effect.kind) {
    case 'cash':
      return effect.amount > 0
        ? copy('events.effect.cashGain', { amount: formatMoney(effect.amount) })
        : copy('events.effect.cashCost', { amount: formatMoney(-effect.amount) })
    case 'stat':
      return copy(effect.amount > 0 ? 'events.effect.statUp' : 'events.effect.statDown', {
        stat: copy(`events.stat.${effect.stat}`),
        amount: formatCount(Math.abs(effect.amount)),
      })
    case 'time':
      return copy('events.effect.time', { minutes: formatCount(effect.minutes) })
    case 'clout':
      return copy(effect.amount > 0 ? 'events.effect.cloutUp' : 'events.effect.cloutDown', {
        amount: formatCount(Math.abs(effect.amount)),
      })
    case 'item':
      return copy(effect.op === 'grant' ? 'events.effect.itemGrant' : 'events.effect.itemConsume')
  }
}

/** All of a choice's effects as one line, in data order. Empty when it has none. */
export function effectsSummary(effects: readonly EventEffect[]): string {
  return effects.map(effectLabel).join(', ')
}

/**
 * A resolved choice's effects as they landed: its clout effects become one effect carrying
 * the clout actually applied (style-scaled, or clamped at 0), or none when nothing applied.
 */
export function appliedEffects(
  effects: readonly EventEffect[],
  cloutApplied: number,
): EventEffect[] {
  const first = effects.findIndex((effect) => effect.kind === 'clout')
  return effects.flatMap((effect, i): EventEffect[] => {
    if (effect.kind !== 'clout') return [effect]
    return i === first && cloutApplied !== 0 ? [{ kind: 'clout', amount: cloutApplied }] : []
  })
}
