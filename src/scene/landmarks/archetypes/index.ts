/** The seven archetype builders, by name: `(params, level, frame) => Part[]`. */
import type { Archetype, ParamsOf } from '@/lib/data/schemas/landmarkModels'
import type { ArchetypeFrame, LodLevel, Part } from '../types'
import { cantileverBridge } from './cantileverBridge'
import { civicHall } from './civicHall'
import { setbackSpire } from './setbackSpire'
import { stationConcourse } from './stationConcourse'
import { suspensionBridge } from './suspensionBridge'
import { terminalHall } from './terminalHall'
import { wedgeTower } from './wedgeTower'

export type ArchetypeBuilder<A extends Archetype> = (
  params: ParamsOf<A>,
  level: LodLevel,
  frame: ArchetypeFrame,
) => Part[]

export const ARCHETYPE_BUILDERS: { readonly [A in Archetype]: ArchetypeBuilder<A> } = {
  civicHall,
  stationConcourse,
  setbackSpire,
  terminalHall,
  wedgeTower,
  suspensionBridge,
  cantileverBridge,
}
