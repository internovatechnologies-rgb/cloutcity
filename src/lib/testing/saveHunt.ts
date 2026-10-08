/**
 * Save-plausibility hunt harness (slice-end bug hunt; test-only, never imported by app code):
 * drives the real game store with seeded play policies, reloads it from storage, and uploads
 * windows to `checkUpload` as the server would. Used by src/state/saveHunt.*.test.ts.
 */
import baselineJson from '@data/sim/economy-baseline.derived.json'
import { sync } from '@/lib/data/config'
import { homes, landmarks, venues } from '@/lib/data/content'
import { EconomyBaselineSchema } from '@/lib/data/schemas/sim'
import { project } from '@/lib/geo/projection'
import { createLogger } from '@/lib/log'
import { engineConfig as config } from '@/engine/config'
import { claimableCount, goalsView } from '@/engine/goals'
import { placeActions } from '@/engine/placeActions'
import type { Place } from '@/engine/places'
import {
  checkUpload,
  plausibilityCeilings,
  type CashClout,
  type Verdict,
} from '@/engine/plausibility'
import { createSaveSchema, type SaveState } from '@/engine/save'
import { takeTrip, type TripStop } from '@/engine/transit/trip'
import { transitConfig } from '@/engine/transit/config'
import { createRng } from '@/engine/rng'
import { shopItems } from '@/engine/items'
import { slotsFor } from '@/engine/home'
import { homeIds } from '@/engine/rent'
import { jobIds } from '@/engine/jobs'
import { createSafeJsonStorage } from '@/state/storage'
import { createGameStore, persistedOf, type GameStore, type PersistedState } from '@/state/store'

export class MemoryStorage implements Storage {
  readonly map = new Map<string, string>()
  get length() {
    return this.map.size
  }
  clear() {
    this.map.clear()
  }
  getItem(key: string) {
    return this.map.get(key) ?? null
  }
  key(index: number) {
    return [...this.map.keys()][index] ?? null
  }
  removeItem(key: string) {
    this.map.delete(key)
  }
  setItem(key: string, value: string) {
    this.map.set(key, value)
  }
}

export const baseline = EconomyBaselineSchema.parse(baselineJson)
export const ceilings = plausibilityCeilings(config, baseline, sync)
const schema = createSaveSchema(config)
export const places: Place[] = [...venues, ...landmarks] as unknown as Place[]

const quiet = createLogger({ level: 'error', sink: () => {} })

export type Policy = 'random' | 'grinder' | 'flexer' | 'clubber' | 'decorator' | 'shopper' | 'icon'

export interface Failure {
  readonly step: number
  readonly kind: string
  readonly detail: unknown
}

function homeStop(home: string): TripStop {
  const h = (homes as Record<string, { borough: string; location: { lat: number; lng: number } }>)[
    home
  ]!
  return {
    location: { kind: 'home' },
    point: project(h.location),
    borough: h.borough as TripStop['borough'],
  }
}
function placeStop(place: Place): TripStop {
  const p = place as unknown as { borough: string; location: { lat: number; lng: number } }
  return {
    location: { kind: 'place', placeId: place.id },
    point: project(p.location),
    borough: p.borough as TripStop['borough'],
  }
}
function hereStop(state: PersistedState): TripStop {
  const loc = state.player.location
  if (loc.kind === 'home') return homeStop(state.player.home)
  return placeStop(places.find((p) => p.id === loc.placeId)!)
}

export interface RunOptions {
  readonly seed: number
  readonly policy: Policy
  readonly steps: number
  /** Real ms per tap (min, max). */
  readonly tapMs?: readonly [number, number]
  readonly uploadEvery?: number
  readonly reloadEvery?: number
  readonly speed?: number
  /** Stop at the first rejected upload. */
  readonly stopOnReject?: boolean
}

export interface RunReport {
  readonly failures: Failure[]
  readonly taps: number
  readonly uploads: number
  readonly prestiges: number
  readonly final: SaveState
  readonly verdicts: { step: number; outcome: string; findings: readonly string[] }[]
}

export function run(opts: RunOptions): RunReport {
  const rng = createRng(opts.seed >>> 0)
  const r = () => rng.next()
  const pick = <T>(xs: readonly T[]): T | undefined =>
    xs.length === 0 ? undefined : xs[Math.floor(r() * xs.length)]
  const [tapMin, tapMax] = opts.tapMs ?? [2000, 5000]
  const local = new MemoryStorage()
  const storage = createSafeJsonStorage<PersistedState>(() => local, quiet)
  let store: GameStore = createGameStore(storage, quiet)
  if (opts.speed !== undefined) store.getState().setSpeed(opts.speed)
  const failures: Failure[] = []
  const verdicts: RunReport['verdicts'] = []
  let taps = 0
  let uploads = 0
  let prestiges = 0

  // Server state.
  let prev: SaveState | null = null
  const serverKeys = new Set<string>()
  let sinceAcceptMs = 0
  let credit = 0
  let pace: CashClout | null = null
  let ageMs = 0
  let first = true

  const upload = (step: number) => {
    const save = persistedOf(store.getState())
    const verdict: Verdict = checkUpload(
      prev,
      JSON.parse(JSON.stringify(save)),
      {
        realMinutesSinceAccept: sinceAcceptMs / 60_000,
        burstCreditMinutes: credit,
        paceCredit: pace,
        accountAgeMinutes: ageMs / 60_000,
        serverGrantKeys: [...serverKeys],
        entitledItemIds: [],
        firstUpload: first,
      },
      ceilings,
      config,
    )
    uploads += 1
    verdicts.push({ step, outcome: verdict.outcome, findings: verdict.findings })
    if (verdict.outcome === 'reject') {
      failures.push({
        step,
        kind: 'upload-rejected',
        detail: {
          findings: verdict.findings,
          actions: save.actions,
          prevActions: prev?.actions,
          cash: save.player.cash,
          prevCash: prev?.player.cash,
          minute: save.clock.minute,
          prevMinute: prev?.clock.minute,
          sinceAcceptMin: sinceAcceptMs / 60_000,
          pace,
          run: save.goals.run,
          repairs: verdict.repairs,
          newGoals: Object.keys(save.goals.achieved).filter(
            (g) => !(prev !== null && Object.hasOwn(prev.goals.achieved, g)),
          ),
          newGrants: save.grants.log
            .filter((g) => !(prev?.grants.log ?? []).some((x) => x.key === g.key))
            .map((g) => g.key),
          firstPaycheckPaid: save.player.clout.firstPaycheckPaid,
          wearables: save.player.inventory.wearables,
          itemLedger: save.player.clout.ledger.filter((e) => e.source === 'item'),
          compacted: save.player.clout.compacted,
          visited: save.player.visited,
          clubNights: save.player.clubNights,
          peak: save.player.clout.peakLevel,
          prevRun: prev?.goals.run,
        },
      })
      return
    }
    first = false
    prev = verdict.save
    sinceAcceptMs = 0
    credit = verdict.burstCreditMinutes ?? credit
    pace = verdict.paceCredit ?? pace
    for (const record of verdict.grantsToInsert) serverKeys.add(record.key)
    store.getState().applyRepairs(verdict.repairs)
    store.getState().markGrantsSynced([...serverKeys])
    if (verdict.repairs.length > 0) {
      failures.push({ step, kind: 'honest-repair', detail: verdict.repairs })
    }
  }

  const invariants = (step: number, what: string) => {
    const s = persistedOf(store.getState())
    const p = s.player
    const bad: string[] = []
    if (!Number.isSafeInteger(p.cash) || p.cash < 0) bad.push(`cash ${p.cash}`)
    for (const [k, v] of Object.entries(p.stats)) {
      if (!Number.isInteger(v) || v < 0 || v > config.stats.max) bad.push(`stat ${k}=${v}`)
    }
    if (!Number.isSafeInteger(s.clock.minute)) bad.push(`minute ${s.clock.minute}`)
    if (!Number.isFinite(s.clock.remainderMs)) bad.push(`remainder ${s.clock.remainderMs}`)
    if (!Number.isSafeInteger(p.rent.owed) || p.rent.owed < 0) bad.push(`owed ${p.rent.owed}`)
    const json = JSON.stringify(s)
    if (json.includes('NaN') || json.includes('null,null')) {
      // JSON turns NaN into null; look for NaN explicitly in numbers.
    }
    const walk = (v: unknown, path: string) => {
      if (typeof v === 'number' && !Number.isFinite(v)) bad.push(`non-finite at ${path}`)
      else if (v !== null && typeof v === 'object')
        for (const [k, c] of Object.entries(v)) walk(c, `${path}.${k}`)
    }
    walk(s, '')
    const parsed = schema.safeParse(JSON.parse(json))
    if (!parsed.success) {
      bad.push(
        `schema: ${parsed.error.issues.map((i) => `${i.path.join('.')}:${i.message}`).join('; ')}`,
      )
    }
    if (bad.length > 0) failures.push({ step, kind: `invariant after ${what}`, detail: bad })
  }

  const reload = (step: number) => {
    // Force the latest state to storage (persist writes on set; the guard skips if unchanged).
    const before = persistedOf(store.getState())
    store = createGameStore(storage, quiet)
    const after = persistedOf(store.getState())
    const strip = (s: SaveState) => ({ ...s, clock: { ...s.clock, remainderMs: 0 } })
    const canon = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(canon)
        : v !== null && typeof v === 'object'
          ? Object.fromEntries(
              Object.keys(v)
                .sort()
                .map((k) => [k, canon((v as never)[k])]),
            )
          : v
    const a = JSON.stringify(canon(strip(before)))
    const b = JSON.stringify(canon(strip(after)))
    if (a !== b) {
      // Find first differing top-level key.
      const diff = Object.keys(before).filter(
        (k) =>
          JSON.stringify((strip(before) as never)[k]) !==
          JSON.stringify((strip(after) as never)[k]),
      )
      const deep: string[] = []
      const cmp = (x: unknown, y: unknown, path: string) => {
        if (JSON.stringify(x) === JSON.stringify(y)) return
        if (
          x !== null &&
          y !== null &&
          typeof x === 'object' &&
          typeof y === 'object' &&
          !Array.isArray(x)
        ) {
          for (const k of new Set([...Object.keys(x), ...Object.keys(y as object)]))
            cmp((x as never)[k], (y as never)[k], `${path}.${k}`)
          return
        }
        deep.push(`${path}: ${JSON.stringify(x)} -> ${JSON.stringify(y)}`)
      }
      cmp(strip(before), strip(after), '')
      failures.push({
        step,
        kind: 'reload-mismatch',
        detail: { keys: diff, deep: deep.slice(0, 5) },
      })
    }
  }

  const s = () => store.getState()

  /** Travel by taxi (direct, no transit world) to `to`; then roll an arrival event. */
  const trip = (to: TripStop, place: Place | null) => {
    const from = hereStop(s())
    const result = s().commitTrip((snapshot) =>
      takeTrip(
        snapshot,
        { from: from.point, to, mode: 'taxi' },
        { world: null },
        config,
        transitConfig,
      ),
    )
    if (result.ok && place !== null) {
      const id = s().rollForEvent({
        borough: to.borough,
        locationId: place.id,
        locationCategory: null,
        itemIds: [
          ...s().player.inventory.wearables.map((o) => o.itemId),
          ...s().player.inventory.gifts.map((g) => g.itemId),
        ],
      })
      if (id !== null) resolveEvent()
    }
    return result.ok
  }

  const resolveEvent = () => {
    const ev = config.events.catalog.find((e) => e.id === s().events.active)
    if (ev === undefined) return
    const choices = [...ev.choices].sort(() => r() - 0.5)
    for (const c of choices) {
      const res = s().chooseEventOption(c.id)
      if (res.ok) {
        s().dismissEventOutcome()
        return
      }
    }
  }

  const claimAll = () => {
    for (const view of goalsView(s(), config)) {
      if (view.status !== 'done') continue
      s().claimGoalReward(view.id)
    }
  }

  const doPlaceAction = (kind?: string) => {
    const loc = s().player.location
    if (loc.kind !== 'place') return false
    const place = places.find((p) => p.id === loc.placeId)!
    const view = placeActions(place, s(), config)
    if (view.kind !== 'actions') return false
    const open = view.actions.filter(
      (a) => a.block === null && (kind === undefined || a.kind === kind),
    )
    const a = pick(open)
    if (a === undefined) return false
    return s().performPlaceAction(place, a.id).ok
  }

  const randomStep = (): boolean => {
    const st = s()
    const roll = r()
    if (st.events.active !== null) {
      resolveEvent()
      return true
    }
    if (roll < 0.15) return s().performAction(pick(Object.keys(config.actions.catalog))!).ok
    if (roll < 0.25) return s().workShift(pick(jobIds(config))!).ok
    if (roll < 0.35) {
      const item = pick(shopItems(config))!
      return s().buyItem(item.id).ok
    }
    if (roll < 0.42) {
      const owned = [
        ...st.player.inventory.wearables.map((o) => o.itemId),
        ...st.player.inventory.decor.map((o) => o.itemId),
        ...st.player.inventory.gifts.map((g) => g.itemId),
      ]
      const id = pick(owned)
      return id !== undefined && s().sellItem(id).ok
    }
    if (roll < 0.47) {
      const w = pick(st.player.inventory.wearables)
      if (w === undefined) return false
      const item = config.items.catalog.find((i) => i.id === w.itemId) as { slot?: string }
      s().equipItem(w.itemId, item.slot ?? '')
      return false
    }
    if (roll < 0.5) {
      const g = pick(st.player.inventory.gifts)
      if (g !== undefined) s().consumeGift(g.itemId, 'yourself')
      return false
    }
    if (roll < 0.58) {
      const d = pick(st.player.inventory.decor)
      if (d === undefined) return false
      const slot = pick(slotsFor(st.player.home, config))
      if (slot === undefined) return false
      return s().placeDecor(d.itemId, slot.id).ok
    }
    if (roll < 0.6) {
      const slot = pick(Object.keys(st.player.apartment.placed))
      return slot !== undefined && s().removeDecor(slot).ok
    }
    if (roll < 0.62) {
      const d = pick(st.player.inventory.decor)
      if (d === undefined) return false
      const item = config.items.catalog.find((i) => i.id === d.itemId) as unknown as {
        decor: { variants: { id: string }[] }
      }
      s().setDecorVariant(d.itemId, pick(item.decor.variants)!.id)
      return false
    }
    if (roll < 0.65) return s().moveHome(pick(homeIds(config))!).ok
    if (roll < 0.8) {
      if (r() < 0.25) return trip(homeStop(st.player.home), null)
      const place = pick(places)!
      return trip(placeStop(place), place)
    }
    if (roll < 0.95) return doPlaceAction()
    if (roll < 0.97) {
      const res = s().startPrestige()
      if (res.ok) prestiges += 1
      return false
    }
    s().setSpeed(pick(config.time.speeds)!)
    return false
  }

  const grinderStep = (): boolean => {
    const st = s()
    if (st.events.active !== null) {
      resolveEvent()
      return true
    }
    const jobs = jobIds(config)
    // Best unlocked job by wage.
    for (const j of [...jobs].reverse()) {
      const res = s().workShift(j)
      if (res.ok) return true
    }
    return s().performAction('sleep').ok
  }

  const flexerStep = (): boolean => {
    if (s().events.active !== null) {
      resolveEvent()
      return true
    }
    if (doPlaceAction('flex')) return true
    if (s().workShift('barista').ok) return true
    if (r() < 0.5) {
      const place = pick(
        places.filter(
          (p) => (p as unknown as { type?: string }).type === 'boutique' || !('type' in p),
        ),
      )!
      if (trip(placeStop(place), place)) return true
    }
    return s().performAction('sleep').ok
  }

  const clubberStep = (): boolean => {
    if (s().events.active !== null) {
      resolveEvent()
      return true
    }
    if (doPlaceAction('club-night')) return true
    if (r() < 0.5 && s().workShift('junior-dev').ok) return true
    if (s().workShift('delivery').ok) return true
    if (r() < 0.6) {
      const clubs = places.filter((p) => Object.hasOwn(config.place.clubs, p.id))
      const place = pick(clubs)!
      if (trip(placeStop(place), place)) return true
    }
    return s().performAction('sleep').ok
  }

  const decoratorStep = (): boolean => {
    const st = s()
    if (st.events.active !== null) {
      resolveEvent()
      return true
    }
    const roll = r()
    if (roll < 0.35) return s().workShift(pick(jobIds(config))!).ok || s().performAction('sleep').ok
    const decor = shopItems(config).filter((i) => 'decor' in i)
    if (roll < 0.55) return s().buyItem(pick(decor)!.id).ok
    if (roll < 0.75) {
      const d = pick(st.player.inventory.decor)
      const slot = pick(slotsFor(st.player.home, config))
      return d !== undefined && slot !== undefined && s().placeDecor(d.itemId, slot.id).ok
    }
    if (roll < 0.85) {
      const d = pick(st.player.inventory.decor)
      return d !== undefined && s().sellItem(d.itemId).ok
    }
    if (roll < 0.92) return s().moveHome(pick(homeIds(config))!).ok
    return s().performAction('sleep').ok
  }

  const shopperStep = (): boolean => {
    const st = s()
    if (st.events.active !== null) {
      resolveEvent()
      return true
    }
    const roll = r()
    if (roll < 0.4) return s().workShift(pick(jobIds(config))!).ok || s().performAction('sleep').ok
    if (roll < 0.7) return s().buyItem(pick(shopItems(config))!.id).ok
    const owned = [
      ...st.player.inventory.wearables.map((o) => o.itemId),
      ...st.player.inventory.gifts.map((g) => g.itemId),
    ]
    const id = pick(owned)
    return id !== undefined && s().sellItem(id).ok
  }

  /** Plays for clout as an honest, focused player: the only aim is Icon, then prestige. */
  const iconStep = (): boolean => {
    const st = s()
    if (st.events.active !== null) {
      resolveEvent()
      return true
    }
    const { stats } = st.player
    if (stats.hunger < 30 && s().performAction('bodega-breakfast').ok) return true
    if (stats.energy < 25) {
      if (st.player.cash > 60 && s().performAction('deli-coffee').ok) return true
      return s().performAction('sleep').ok
    }
    // Things to do where the player is: club night, flex.
    if (doPlaceAction('club-night')) return true
    if (doPlaceAction('flex')) return true
    // Buy and wear a wearable when rich.
    if (st.player.cash > 400) {
      const wearables = shopItems(config).filter(
        (i) => 'slot' in i && !st.player.inventory.wearables.some((o) => o.itemId === i.id),
      )
      const w = pick(wearables)
      if (w !== undefined && s().buyItem(w.id).ok) {
        s().equipItem(w.id, (w as unknown as { slot: string }).slot)
        return true
      }
    }
    if (st.player.cash > 900 && r() < 0.05) {
      const h = pick(homeIds(config))!
      if (s().moveHome(h).ok) return true
    }
    // Go somewhere with something to do now.
    const targets = places.filter((p) => {
      const view = placeActions(
        p,
        { ...st, player: { ...st.player, location: { kind: 'place', placeId: p.id } } },
        config,
      )
      return (
        view.kind === 'actions' &&
        view.actions.some((a) => a.block === null && (a.kind === 'flex' || a.kind === 'club-night'))
      )
    })
    const here = st.player.location
    const target = pick(targets.filter((p) => !(here.kind === 'place' && here.placeId === p.id)))
    if (target !== undefined && r() < 0.7 && trip(placeStop(target), target)) return true
    // Otherwise earn.
    for (const j of [...jobIds(config)].reverse()) if (s().workShift(j).ok) return true
    return s().performAction('sleep').ok
  }

  const stepFor: Record<Policy, () => boolean> = {
    icon: iconStep,
    random: randomStep,
    grinder: grinderStep,
    flexer: flexerStep,
    clubber: clubberStep,
    decorator: decoratorStep,
    shopper: shopperStep,
  }

  upload(-1)
  for (let i = 0; i < opts.steps; i += 1) {
    const actionsBefore = s().actions
    let tapped = false
    try {
      tapped = stepFor[opts.policy]()
    } catch (error) {
      failures.push({ step: i, kind: 'throw', detail: String(error) })
      break
    }
    if (claimableCount(s(), config) > 0) claimAll()
    // Prestige whenever possible in non-random policies too (honest players do).
    if (s().goals.icon.reachedAt !== null && !s().goals.icon.acknowledged)
      s().acknowledgeIconMoment()
    if (opts.policy !== 'random' && s().goals.icon.reachedAt !== null && r() < 0.5) {
      const res = s().startPrestige()
      if (res.ok) prestiges += 1
    }
    if (s().actions > actionsBefore) taps += s().actions - actionsBefore
    invariants(i, opts.policy)
    const ms = tapMin + Math.floor(r() * (tapMax - tapMin))
    // The passive clock ticks every second while visible.
    for (let t = 0; t < ms; t += 1000) s().tick(Math.min(1000, ms - t), true)
    sinceAcceptMs += ms
    ageMs += ms
    void tapped
    if ((opts.reloadEvery ?? 7) > 0 && i % (opts.reloadEvery ?? 7) === 0) reload(i)
    const every = opts.uploadEvery ?? 10
    if (i % every === every - 1) {
      upload(i)
      if (opts.stopOnReject === true && failures.some((f) => f.kind === 'upload-rejected')) break
    }
  }
  upload(opts.steps)
  return { failures, taps, uploads, prestiges, final: persistedOf(s()), verdicts }
}
