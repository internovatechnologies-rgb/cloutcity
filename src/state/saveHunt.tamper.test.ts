/**
 * Property tests: tampered or partial saves never throw on load, and whatever loads (or migrates)
 * is a valid current save. Older-format copies of played saves migrate with their progress.
 */
import { describe, expect, it } from 'vitest'
import { engineConfig as config } from '@/engine/config'
import { createRng } from '@/engine/rng'
import {
  createSaveSchema,
  loadSave,
  migrateSave,
  SAVE_VERSION,
  type SaveState,
} from '@/engine/save'
import { cloutSums } from '@/engine/clout'
import { checkUpload } from '@/engine/plausibility'
import { ceilings, run } from '@/lib/testing/saveHunt'

const schema = createSaveSchema(config)
/** Tampered copies per played save (the hunt ran 1500; widen with HUNT_MUTATIONS). */
const MUTATIONS = Number(process.env.HUNT_MUTATIONS ?? 60)
/** Loose JSON for building older save formats by hand. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- hand-built legacy JSON
type Any = any

function saves(): SaveState[] {
  const out: SaveState[] = []
  for (const policy of ['random', 'decorator', 'shopper', 'flexer'] as const) {
    for (let seed = 1; seed <= 3; seed += 1) {
      out.push(
        run({ seed: seed * 31, policy, steps: 400, uploadEvery: 1000, reloadEvery: 0 }).final,
      )
    }
  }
  out.push(run({ seed: 5, policy: 'icon', steps: 3500, uploadEvery: 1000, reloadEvery: 0 }).final)
  return out
}
const SAVES = saves()

const WEIRD: unknown[] = [
  null,
  undefined,
  -1,
  0,
  1,
  1.5,
  -0.5,
  1e20,
  Number.MAX_SAFE_INTEGER,
  2 ** 53,
  '1',
  '',
  'x',
  true,
  false,
  [],
  {},
  [1],
  { a: 1 },
  4294967296,
  -4294967296,
]

function paths(value: unknown, prefix: (string | number)[] = []): (string | number)[][] {
  if (value === null || typeof value !== 'object') return [prefix]
  const out: (string | number)[][] = [prefix]
  for (const [k, v] of Object.entries(value)) {
    out.push(...paths(v, [...prefix, Array.isArray(value) ? Number(k) : k]))
  }
  return out
}

function mutate(root: unknown, path: (string | number)[], value: unknown, del: boolean): unknown {
  const copy = structuredClone(root) as Record<string, unknown>
  if (path.length === 0) return value
  let node: Record<string | number, unknown> = copy
  for (const key of path.slice(0, -1)) node = node[key] as Record<string | number, unknown>
  const last = path.at(-1)!
  if (del) {
    if (Array.isArray(node)) node.splice(Number(last), 1)
    else delete node[last]
  } else node[last] = value
  return copy
}

describe('tampered saves', () => {
  it('loadSave never throws and what it returns is a valid current save', () => {
    const rng = createRng(12345)
    const problems: string[] = []
    for (const save of SAVES) {
      const json = JSON.parse(JSON.stringify(save))
      const all = paths(json)
      for (let i = 0; i < MUTATIONS; i += 1) {
        const path = all[Math.floor(rng.next() * all.length)]!
        const del = rng.next() < 0.2
        const value = WEIRD[Math.floor(rng.next() * WEIRD.length)]
        const tampered = JSON.parse(JSON.stringify(mutate(json, path, value, del)) ?? 'null')
        let result
        try {
          result = loadSave(tampered, config)
        } catch (error) {
          problems.push(`throw at ${path.join('.')}=${JSON.stringify(value)} del=${del}: ${error}`)
          continue
        }
        if (!result.ok) continue
        const check = schema.safeParse(JSON.parse(JSON.stringify(result.save)))
        if (!check.success) {
          problems.push(
            `invalid after load at ${path.join('.')}=${JSON.stringify(value)} del=${del}: ${check.error.issues.map((x) => `${x.path.join('.')} ${x.message}`).join('; ')}`,
          )
        }
        // Loading the loaded save again changes nothing (idempotent repair).
        const again = loadSave(JSON.parse(JSON.stringify(result.save)), config)
        if (
          !again.ok ||
          again.repaired.length > 0 ||
          JSON.stringify(again.save) !== JSON.stringify(result.save)
        ) {
          problems.push(
            `not idempotent at ${path.join('.')}=${JSON.stringify(value)} del=${del}: ${again.ok ? again.repaired.join(',') : 'fail'}`,
          )
        }
      }
    }
    const uniq = [...new Set(problems.map((p) => p.replace(/\.\d+/g, '.N')))]
    expect(uniq).toEqual([])
  })

  it('every older format of a played save migrates with its progress', () => {
    const problems: string[] = []
    for (const save of SAVES) {
      const j = JSON.parse(JSON.stringify(save)) as Record<string, Any>
      const p = j.player
      const v10 = { ...j }
      delete v10.actions
      const v9 = structuredClone(v10)
      delete v9.player.location
      delete v9.player.transit
      const v8 = structuredClone(v9)
      delete v8.player.apartment
      v8.player.inventory = { ...v8.player.inventory }
      delete v8.player.inventory.decor
      const v7 = structuredClone(v8)
      delete v7.goals
      delete v7.grants
      delete v7.prestige
      delete v7.player.visited
      v7.player.inventory.wearables = v7.player.inventory.wearables.map((w: Any) => {
        const rest = { ...w }
        delete rest.prestigeKept
        return rest
      })
      const sums = cloutSums(p.clout)
      const v6 = structuredClone(v7)
      v6.player.clout = Math.max(0, sums.earned)
      delete v6.player.flex
      const v5 = structuredClone(v6)
      delete v5.player.clubNights
      const v4 = structuredClone(v5)
      delete v4.events
      const v3 = structuredClone(v4)
      delete v3.player.inventory
      const v2 = structuredClone(v3)
      delete v2.player.clout
      delete v2.player.home
      delete v2.player.rent
      const v1 = { player: { cash: p.cash } }
      const byVersion: Record<number, unknown> = {
        1: v1,
        2: v2,
        3: v3,
        4: v4,
        5: v5,
        6: v6,
        7: v7,
        8: v8,
        9: v9,
        10: v10,
        11: j,
      }
      for (let v = 1; v <= SAVE_VERSION; v += 1) {
        let m
        try {
          m =
            v === SAVE_VERSION
              ? (() => {
                  const r = loadSave(byVersion[v], config)
                  return r.ok
                    ? { save: r.save, outcome: 'carried' }
                    : { save: null, outcome: 'fresh' }
                })()
              : migrateSave(byVersion[v], v, config)
        } catch (error) {
          problems.push(`v${v} throws ${error}`)
          continue
        }
        if (m.outcome !== 'carried') {
          problems.push(`v${v} not carried`)
          continue
        }
        const out = m.save as SaveState
        if (!schema.safeParse(JSON.parse(JSON.stringify(out))).success)
          problems.push(`v${v} invalid`)
        if (out.player.cash !== p.cash) problems.push(`v${v} cash ${out.player.cash} != ${p.cash}`)
        if (v >= 2 && out.clock.minute !== j.clock.minute) problems.push(`v${v} minute`)
        if (v >= 3 && out.player.home !== p.home) problems.push(`v${v} home`)
        if (
          v >= 8 &&
          JSON.stringify(out.player.apartment) !== JSON.stringify(p.apartment) &&
          v >= 9
        )
          problems.push(`v${v} apartment`)
        // The migrated save must be acceptable as a first upload (a player upgrading then signing
        // in). Only from v8: the older copies here are built by hand from a current save (a v7 copy
        // keeps grant clout v7 never had; a v1 copy keeps cash on a fresh clock), not real saves.
        if (v < 8) continue
        const verdict = checkUpload(
          null,
          JSON.parse(JSON.stringify(out)),
          {
            realMinutesSinceAccept: 0,
            burstCreditMinutes: 0,
            accountAgeMinutes: 1,
            serverGrantKeys: [],
            entitledItemIds: [],
            firstUpload: true,
          },
          ceilings,
          config,
        )
        if (verdict.outcome === 'reject')
          problems.push(
            `v${v} first upload rejected: ${verdict.findings.join(',')} run ${out.goals.run} prestige ${out.prestige.count}`,
          )
      }
    }
    const uniq = [...new Set(problems)]
    expect(uniq).toEqual([])
  })
})
