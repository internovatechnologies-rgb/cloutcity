/**
 * The save plausibility ceilings the server checks every upload against (S18c): built once from
 * the engine config, the economy bot's fixture (data/sim, S12) and data/config/sync.json.
 */
import 'server-only'
import baselineJson from '@data/sim/economy-baseline.derived.json'
import { engineConfig } from '@/engine/config'
import { plausibilityCeilings, type PlausibilityCeilings } from '@/engine/plausibility'
import { sync } from '@/lib/data/config'
import { EconomyBaselineSchema } from '@/lib/data/schemas/sim'

let built: PlausibilityCeilings | undefined

export function serverCeilings(): PlausibilityCeilings {
  built ??= plausibilityCeilings(engineConfig, EconomyBaselineSchema.parse(baselineJson), sync)
  return built
}
