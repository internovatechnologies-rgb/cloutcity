/**
 * Transit balance numbers (data/config/balance.json `transit`, validated by TransitConfigSchema
 * in src/lib/data/data.test.ts). Read through src/engine/config.ts (`transitBalance`), which
 * reads the JSON directly so the engine stays off classic zod. The subway fare is the
 * `costs.subwayFare` anchor.
 */
import type { TransitConfig as BalanceTransitConfig } from '@/lib/data/schemas/config'
import { transitBalance } from '../config'

export interface TransitConfig extends BalanceTransitConfig {
  /** Whole dollars for one subway trip, however many transfers it has. */
  readonly subwayFare: number
}

export const transitConfig: TransitConfig = transitBalance
