/**
 * data/config/offline.json for client code, typed without zod (the shell stays off classic zod).
 * OfflineConfigSchema validates the file in src/lib/data/data.test.ts.
 */
import offlineJson from '@data/config/offline.json'
import type { OfflineConfig } from '@/lib/data/schemas/config'

export const offlineConfig: OfflineConfig = offlineJson
