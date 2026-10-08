/**
 * The player's local-first game state, persisted to localStorage (zustand `persist`).
 *
 * The store holds an engine snapshot and calls the engine (src/engine) for every change; game
 * rules live there, not here. The save format and its migrations are src/engine/save.ts.
 * Saved data is untrusted: it is validated on every load and replaced by a fresh state if it
 * does not fit the schema.
 *
 * Client code: it validates with `zod/mini` (tree-shakable) and reads balance.json directly
 * (validated in src/lib/data/data.test.ts) to keep zod's classic build out of the shell JS.
 *
 * In a browser the store hydrates synchronously when this module loads. Components that render
 * persisted values must read them after mount to avoid a server/client hydration mismatch.
 */
import { useStore } from 'zustand'
import { persist, type PersistStorage, type StorageValue } from 'zustand/middleware'
import { createStore } from 'zustand/vanilla'
import { performAction, type ActionResult } from '@/engine/actions'
import { isSpeed, type ClockState } from '@/engine/clock'
import type { LevelUp } from '@/engine/clout'
import { engineConfig } from '@/engine/config'
import {
  chooseEventOption,
  openEvent,
  rollEvent,
  type ChooseResult,
  type EventContext,
  type EventOutcome,
  type OpenResult,
} from '@/engine/events'
import { advanceMinutes, tick, type GameSnapshot } from '@/engine/game'
import { findGoal, syncGoals, victoryGoal, type GoalsState } from '@/engine/goals'
import { grant, markGrantsSynced, type GrantResult } from '@/engine/grants'
import { moveHome, placeDecor, removeDecor, setDecorVariant, type HomeResult } from '@/engine/home'
import {
  buyItem,
  equipItem,
  sellItem,
  unequipSlot,
  consumeGift,
  type GiftTarget,
  type ItemResult,
} from '@/engine/items'
import { workShift, type ShiftResult } from '@/engine/jobs'
import {
  buyAtShop,
  performHomeAction,
  performPlaceAction,
  type PlaceActionResult,
  type ShopBuyResult,
} from '@/engine/placeActions'
import type { Place } from '@/engine/places'
import { prestige as startNextRun, type PrestigeResult } from '@/engine/prestige'
import type { RentEvent } from '@/engine/rent'
import { applyRepairs, type Repair } from '@/engine/repairs'
import {
  NewerSaveError,
  SAVE_VERSION,
  countAction,
  createSaveSchema,
  initialSave,
  loadSave,
  migrateSave,
  type SaveState,
} from '@/engine/save'
import { log, type Logger } from '@/lib/log'
import { browserLocalStorage, createSafeJsonStorage } from './storage'

export const STORE_KEY = 'cloutcity:game'
export const STORE_VERSION = SAVE_VERSION

export const PersistedStateSchema = createSaveSchema(engineConfig)
export type PersistedState = SaveState

/**
 * What a trip computed (S08): the snapshot after it, and the rent charged on the way. The travel
 * chunk computes it with the transit engine (src/engine/transit/trip.ts `takeTrip`); the store
 * only applies it, so the transit engine and its data never load with the store (DEC-11).
 */
export type TripCommit =
  | {
      readonly ok: true
      readonly snapshot: GameSnapshot
      readonly rent: readonly RentEvent[]
    }
  | { readonly ok: false }

export interface GameActions {
  /** Passive time: real ms since the last tick, while the tab is (or is not) visible. */
  tick(realElapsedMs: number, visible: boolean): void
  /** Runs a catalog action; the state changes only when the result is ok. */
  performAction(actionId: string): ActionResult
  /** Works one shift of a job (rent falling due on the way is charged by the engine). */
  workShift(jobId: string): ShiftResult
  /** Buys one of a shop item for its price in cash. */
  buyItem(itemId: string): ReturnType<typeof buyItem>
  /**
   * Buys one item at a place's shop: the engine checks the place has a shop that is open to
   * the player now, then the usual buy rules.
   */
  buyAtShop(place: Place, itemId: string): ShopBuyResult
  /** Sells one owned item at its current resale value (a worn item is taken off). */
  sellItem(itemId: string): ReturnType<typeof sellItem>
  /** Wears an owned wearable in its slot. */
  equipItem(itemId: string, slot: string): ItemResult
  /** Takes off whatever is worn in a slot. */
  unequipSlot(slot: string): ItemResult
  /** Uses one gift on yourself or an NPC; it is consumed. Never another player. */
  consumeGift(itemId: string, target: GiftTarget): ReturnType<typeof consumeGift>
  /**
   * Places owned decor in a slot of the current home (whatever sat there goes to storage). A
   * level reached through the home score shows the level-up toast.
   */
  placeDecor(itemId: string, slotId: string): ReturnType<typeof placeDecor>
  /** Takes the decor in a slot of the current home back to storage. */
  removeDecor(slotId: string): ReturnType<typeof removeDecor>
  /** Shows owned decor in another of its colour variants. */
  setDecorVariant(itemId: string, variantId: string): HomeResult
  /**
   * Moves home at once, paying the move-in cost. The engine refuses the current home, a home in a
   * locked borough and a move the player cannot afford, in that order.
   */
  moveHome(home: string): ReturnType<typeof moveHome>
  /**
   * Does one action from a place's action sheet. The engine re-checks the borough, opening
   * hours, club door, job lock, funds and energy; the state changes only when the result is ok.
   */
  performPlaceAction(place: Place, actionId: string): PlaceActionResult
  /**
   * Does one home action (sleep, nap, a home-cooked meal): the engine re-checks that the player
   * is at home, then funds and energy; the clock fast-forwards like any action.
   */
  performHomeAction(actionId: string): PlaceActionResult
  /**
   * Takes a trip in one step (DEC-22): `compute` gets the current snapshot and returns the
   * engine's result; an ok result replaces the clock and player at once (fare paid, clock
   * fast-forwarded, rent charged, location moved) before any animation starts. Returns what
   * `compute` returned.
   */
  commitTrip<R extends TripCommit>(compute: (snapshot: GameSnapshot) => R): R
  /**
   * Fast-forwards the personal clock by whole game minutes (decay and rent apply). Used by the
   * e2e hook; no player-facing control waits without an action yet.
   */
  advanceMinutes(minutes: number): void
  /** Sets the passive clock speed (one of balance `time.speeds`, i.e. 1x or 2x). */
  setSpeed(speed: number): void
  /**
   * Rolls for a random event where the player is now (src/engine/events.ts); an event that
   * fires opens in the event sheet. Returns its id, or null. Callers (travel, place visits)
   * roll after the player arrives somewhere.
   */
  rollForEvent(context: EventContext): string | null
  /** Opens one event, if it is eligible in this context (scripted triggers, the e2e hook). */
  openEvent(eventId: string, context: EventContext): OpenResult
  /** Resolves the open event; on success its outcome is shown until dismissed. */
  chooseEventOption(choiceId: string): ChooseResult
  /** Closes the outcome screen of the last event. */
  dismissEventOutcome(): void
  /** Clears the last level-up (the level-up toast closed). */
  dismissLevelUp(): void
  /**
   * Claims a reached goal's reward through the grant function (src/engine/grants.ts): capped,
   * logged and idempotent. A second claim replays the first and changes nothing.
   */
  claimGoalReward(goalId: string): GrantResult<PersistedState>
  /**
   * After Icon: grants the run's badge and starts the next run (src/engine/prestige.ts). Named
   * apart from the persisted `prestige` state it changes.
   */
  startPrestige(): PrestigeResult<PersistedState>
  /** The player closed the Icon moment; it does not show again this run. */
  acknowledgeIconMoment(): void
  /**
   * The player's explicit choice to drop a save written by a newer build: starts a fresh game
   * and lets saving resume. Nothing else ever overwrites that save.
   */
  discardNewerSaveAndStartFresh(): void
  /**
   * Cloud sync (S18c): replaces the game with the account's save (restored on load, or the
   * player chose the cloud copy in a conflict). `save` (written as save format `version`) is
   * untrusted and validated like a local save, an older format upgraded; an unusable one, or one
   * from a newer build, changes nothing and returns false.
   */
  adoptCloudSave(save: unknown, version: number): boolean
  /** Cloud sync (S18c): applies the repairs the server made to an accepted upload. */
  applyRepairs(repairs: readonly Repair[]): void
  /** Cloud sync (S18c): marks the grant records the server holds as synced. */
  markGrantsSynced(keys: readonly string[]): void
}

/** Session-only status, never persisted. */
export interface GameStatus {
  /**
   * True when storage holds a save from a newer build. It is left untouched: nothing is written
   * (play continues in memory) until `discardNewerSaveAndStartFresh` is called.
   */
  readonly newerSavePresent: boolean
  /** What the last event choice did, shown in the event sheet until dismissed. */
  readonly eventOutcome: EventOutcome | null
  /**
   * The last rent charge, miss or collection this session, for the rent panel. Session-only:
   * a reload starts with none (the save keeps what is owed, not the notice).
   */
  readonly lastRentEvent: RentEvent | null
  /**
   * The last level-up, shown as a toast until dismissed. Session-only: never saved and not
   * part of the save signature, so a reload never replays it.
   */
  readonly lastLevelUp: LevelUp | null
}
export type GameState = PersistedState & GameActions & GameStatus

export function initialPersistedState(): PersistedState {
  return initialSave(engineConfig)
}

/**
 * Upgrades a save written by an older STORE_VERSION (see src/engine/save.ts). A save from a
 * newer build is not loaded (the throw leaves the fresh state in place) and is never
 * overwritten unless the player calls `discardNewerSaveAndStartFresh`.
 */
export function migrateGameState(
  persisted: unknown,
  version: number,
  logger: Logger = log,
): PersistedState {
  const { save, outcome } = migrateSave(persisted, version, engineConfig)
  logger.info(
    outcome === 'carried'
      ? 'Upgraded a saved game to the current format'
      : 'Starting fresh: saved game predates the current format',
    { version, persisted: typeof persisted },
  )
  return save
}

/**
 * Validates loaded state before it replaces the in-memory state. Individually invalid fields
 * are repaired (src/engine/save.ts `loadSave`); only an unusable save is ignored.
 */
export function mergeGameState(
  persisted: unknown,
  current: GameState,
  logger: Logger = log,
): GameState {
  if (persisted === undefined) return current
  const result = loadSave(persisted, engineConfig)
  if (!result.ok) {
    // A corrupt or tampered save is expected and recoverable: info, not warn.
    logger.info('Ignoring a saved game that failed validation', { issues: result.issues })
    return current
  }
  if (result.repaired.length > 0) {
    logger.info('Repaired out-of-range fields in the saved game', { fields: result.repaired })
  }
  return { ...current, ...result.save }
}

/**
 * What makes a save worth writing: the version, clock minute, the player (cash, stats, clout
 * ledger, flex state, home, rent, inventory with decor, club nights, visits, the apartment's
 * placements and move log, location and transit state), speed, event state, goals,
 * the grant log, prestige and the action count. The sub-minute remainder alone is not, so a visible tab does not
 * write on every tick (a reload loses at most one game minute's worth of carried real time).
 */
function saveSignature(value: StorageValue<unknown> | null): string | undefined {
  if (value === null) return undefined
  const state = (value.state ?? {}) as {
    clock?: { minute?: unknown }
    player?: unknown
    speed?: unknown
    events?: unknown
    goals?: unknown
    grants?: unknown
    prestige?: unknown
    actions?: unknown
  }
  return JSON.stringify([
    value.version,
    state.clock?.minute,
    state.player,
    state.speed,
    state.events,
    state.goals,
    state.grants,
    state.prestige,
    state.actions,
  ])
}

/**
 * Wraps the persist storage so that (1) a save from a newer build is never overwritten
 * without the player's explicit choice, and (2) only meaningful changes are written.
 */
function guardStorage(inner: PersistStorage<PersistedState>) {
  let newerSavePresent = false
  let lastSignature: string | undefined

  const storage: PersistStorage<PersistedState> = {
    getItem: (name) => {
      const value = inner.getItem(name)
      if (value instanceof Promise) return value
      if (value !== null && (value.version ?? 0) > STORE_VERSION) newerSavePresent = true
      lastSignature = saveSignature(value)
      return value
    },
    setItem: (name, value) => {
      if (newerSavePresent) return
      const signature = saveSignature(value)
      if (signature === lastSignature) return
      lastSignature = signature
      return inner.setItem(name, value)
    },
    removeItem: (name) => {
      if (newerSavePresent) return
      lastSignature = undefined
      return inner.removeItem(name)
    },
  }

  return {
    storage,
    get newerSavePresent() {
      return newerSavePresent
    },
    release() {
      newerSavePresent = false
    },
  }
}

/** The last rent event of an advance, or the current one when the advance had none. */
function latestRent(events: readonly RentEvent[], current: RentEvent | null): RentEvent | null {
  return events.at(-1) ?? current
}

const ICON_LEVEL = victoryGoal(engineConfig).level

/**
 * A new level-up replaces the one showing; no level-up leaves the toast as it is. Reaching the
 * victory level while the Icon moment is about to show adds no toast: the moment is the
 * celebration.
 */
function levelUpPatch(levelUp: LevelUp | null, goals: GoalsState): Partial<GameStatus> {
  if (levelUp === null) return {}
  const iconMoment = goals.icon.reachedAt !== null && !goals.icon.acknowledged
  return levelUp.to === ICON_LEVEL && iconMoment ? {} : { lastLevelUp: levelUp }
}

/** The persisted part of the state: what a save holds. */
export function persistedOf(state: PersistedState): PersistedState {
  const { clock, player, speed, events, goals, grants, prestige: prestigeState, actions } = state
  return { clock, player, speed, events, goals, grants, prestige: prestigeState, actions }
}

export function createGameStore(storage: PersistStorage<PersistedState>, logger: Logger = log) {
  const guard = guardStorage(storage)
  const store = createStore<GameState>()(
    persist(
      (set, get) => {
        /**
         * The passive clock's sub-minute carry (S05). A visible tab ticks every second, but the
         * clock shows whole game minutes, so the carry lives here and the state changes (and
         * subscribers re-render) only when a game minute passes: six ticks a minute at 1x, not
         * one notification per tick.
         *
         * It is tied to the clock it was carried on. The store's own actions fast-forward whole
         * minutes and keep it (`keepCarry`); a clock written from outside (a loaded save, a
         * test hook) or a fresh start drops it, and the state's own remainder applies.
         */
        let carry: { readonly clock: ClockState; readonly ms: number } | null = null
        const carriedMs = (clock: ClockState) =>
          carry !== null && carry.clock === clock ? carry.ms : clock.remainderMs
        const keepCarry = () => {
          if (carry !== null) carry = { clock: get().clock, ms: carry.ms }
        }
        /**
         * Applies a state-changing action's result, counts the tap (`SaveState.actions`, which
         * the server's save plausibility reads), then records any goal it reached
         * (src/engine/goals.ts `syncGoals`). Never on the passive tick: time alone reaches no
         * goal and is no tap.
         */
        const commit = (patch: Partial<GameState>, levelUp: LevelUp | null = null) => {
          const { save } = syncGoals(countAction({ ...get(), ...patch }), engineConfig)
          set({
            ...patch,
            actions: save.actions,
            goals: save.goals,
            ...levelUpPatch(levelUp, save.goals),
          })
          keepCarry()
        }
        return {
          ...initialPersistedState(),
          newerSavePresent: false,
          eventOutcome: null,
          lastRentEvent: null,
          lastLevelUp: null,
          tick: (realElapsedMs, visible) => {
            const state = get()
            const clock = { minute: state.clock.minute, remainderMs: carriedMs(state.clock) }
            const { snapshot, minutes, rent } = tick(
              { clock, player: state.player },
              realElapsedMs,
              { visible, speed: state.speed },
              engineConfig,
            )
            if (minutes > 0) {
              set({
                clock: snapshot.clock,
                player: snapshot.player,
                lastRentEvent: latestRent(rent, state.lastRentEvent),
              })
            }
            carry = { clock: get().clock, ms: snapshot.clock.remainderMs }
          },
          performAction: (actionId) => {
            const state = get()
            const result = performAction(state, actionId, engineConfig)
            if (result.ok) {
              commit({
                clock: result.snapshot.clock,
                player: result.snapshot.player,
                lastRentEvent: latestRent(result.rent, state.lastRentEvent),
              })
            }
            return result
          },
          workShift: (jobId) => {
            const state = get()
            const result = workShift(state, jobId, engineConfig)
            if (result.ok) {
              commit(
                {
                  clock: result.snapshot.clock,
                  player: result.snapshot.player,
                  lastRentEvent: latestRent(result.rent, state.lastRentEvent),
                },
                result.levelUp,
              )
            }
            return result
          },
          buyItem: (itemId) => {
            const result = buyItem(get(), itemId, engineConfig)
            if (result.ok) commit({ player: result.snapshot.player }, result.levelUp)
            return result
          },
          buyAtShop: (place, itemId) => {
            const result = buyAtShop(get(), place, itemId, engineConfig)
            if (result.ok) commit({ player: result.snapshot.player }, result.levelUp)
            return result
          },
          sellItem: (itemId) => {
            const result = sellItem(get(), itemId, engineConfig)
            if (result.ok) commit({ player: result.snapshot.player }, result.levelUp)
            return result
          },
          equipItem: (itemId, slot) => {
            const result = equipItem(get(), itemId, slot, engineConfig)
            if (result.ok) set({ player: result.snapshot.player })
            return result
          },
          unequipSlot: (slot) => {
            const result = unequipSlot(get(), slot)
            if (result.ok) set({ player: result.snapshot.player })
            return result
          },
          consumeGift: (itemId, target) => {
            const result = consumeGift(get(), itemId, target, engineConfig)
            if (result.ok) set({ player: result.snapshot.player })
            return result
          },
          placeDecor: (itemId, slotId) => {
            const result = placeDecor(get(), itemId, slotId, engineConfig)
            if (result.ok) commit({ player: result.snapshot.player }, result.levelUp)
            return result
          },
          removeDecor: (slotId) => {
            const result = removeDecor(get(), slotId, engineConfig)
            if (result.ok) commit({ player: result.snapshot.player }, result.levelUp)
            return result
          },
          setDecorVariant: (itemId, variantId) => {
            const result = setDecorVariant(get(), itemId, variantId, engineConfig)
            if (result.ok) set({ player: result.snapshot.player })
            return result
          },
          moveHome: (home) => {
            const result = moveHome(get(), home, engineConfig)
            if (result.ok) commit({ player: result.snapshot.player }, result.levelUp)
            return result
          },
          performPlaceAction: (place, actionId) => {
            const state = get()
            const result = performPlaceAction(state, place, actionId, engineConfig)
            if (result.ok) {
              commit(
                {
                  clock: result.snapshot.clock,
                  player: result.snapshot.player,
                  lastRentEvent: latestRent(result.rent, state.lastRentEvent),
                },
                result.levelUp,
              )
            }
            return result
          },
          performHomeAction: (actionId) => {
            const state = get()
            const result = performHomeAction(state, actionId, engineConfig)
            if (result.ok) {
              commit({
                clock: result.snapshot.clock,
                player: result.snapshot.player,
                lastRentEvent: latestRent(result.rent, state.lastRentEvent),
              })
            }
            return result
          },
          commitTrip: (compute) => {
            const state = get()
            const result = compute({ clock: state.clock, player: state.player })
            if (result.ok) {
              commit({
                clock: result.snapshot.clock,
                player: result.snapshot.player,
                lastRentEvent: latestRent(result.rent, state.lastRentEvent),
              })
            }
            return result
          },
          advanceMinutes: (minutes) => {
            const state = get()
            const { snapshot, rent } = advanceMinutes(state, minutes, engineConfig)
            set({
              clock: snapshot.clock,
              player: snapshot.player,
              lastRentEvent: latestRent(rent, state.lastRentEvent),
            })
            keepCarry()
          },
          setSpeed: (speed) => {
            if (!isSpeed(speed, engineConfig))
              throw new RangeError(`Unsupported clock speed: ${speed}`)
            set({ speed })
          },
          rollForEvent: (context) => {
            const state = get()
            const { events, event } = rollEvent(state, state.events, context, engineConfig)
            set({ events })
            return event?.id ?? null
          },
          openEvent: (eventId, context) => {
            const state = get()
            const result = openEvent(state, state.events, eventId, context, engineConfig)
            if (result.ok) set({ events: result.events, eventOutcome: null })
            return result
          },
          chooseEventOption: (choiceId) => {
            const state = get()
            const result = chooseEventOption(state, state.events, choiceId, engineConfig)
            if (result.ok) {
              commit(
                {
                  clock: result.snapshot.clock,
                  player: result.snapshot.player,
                  events: result.events,
                  eventOutcome: result.outcome,
                  lastRentEvent: latestRent(result.rent, state.lastRentEvent),
                },
                result.levelUp,
              )
            }
            return result
          },
          dismissEventOutcome: () => set({ eventOutcome: null }),
          dismissLevelUp: () => set({ lastLevelUp: null }),
          claimGoalReward: (goalId) => {
            const state = persistedOf(get())
            const goal = findGoal(goalId, engineConfig)
            // Unknown ids still go through the grant function, which refuses them.
            const reward = goal?.reward ?? {}
            const result = grant(
              state,
              { kind: 'goal_reward', goalId, reward },
              Date.now(),
              engineConfig,
            )
            if (result.ok && !result.replayed) {
              const { player, grants, prestige: prestigeState } = result.save
              // Through `commit` (N-1): the claim is a tap, a level-up it causes shows its
              // toast, and goals are synced like after any other action.
              commit({ player, grants, prestige: prestigeState }, result.levelUp)
            }
            return result
          },
          startPrestige: () => {
            const result = startNextRun(persistedOf(get()), Date.now(), engineConfig)
            if (result.ok) {
              carry = null
              set({
                ...result.save,
                // A new run counts its taps from 0 (SaveState.actions).
                actions: 0,
                eventOutcome: null,
                lastLevelUp: null,
                lastRentEvent: null,
              })
            }
            return result
          },
          acknowledgeIconMoment: () => {
            const { goals } = get()
            if (goals.icon.reachedAt === null || goals.icon.acknowledged) return
            set({ goals: { ...goals, icon: { ...goals.icon, acknowledged: true } } })
          },
          discardNewerSaveAndStartFresh: () => {
            guard.release()
            logger.info("Discarding a saved game from a newer build at the player's request")
            carry = null
            set({
              ...initialPersistedState(),
              newerSavePresent: false,
              eventOutcome: null,
              lastRentEvent: null,
              lastLevelUp: null,
            })
          },
          adoptCloudSave: (save, version) => {
            if (version > STORE_VERSION) return false
            let adopted: PersistedState
            if (version === STORE_VERSION) {
              const result = loadSave(save, engineConfig)
              if (!result.ok) {
                logger.info('Ignoring a cloud save that failed validation', {
                  issues: result.issues,
                })
                return false
              }
              adopted = result.save
            } else {
              const migrated = migrateSave(save, version, engineConfig)
              if (migrated.outcome !== 'carried') return false
              adopted = migrated.save
            }
            carry = null
            set({
              ...adopted,
              eventOutcome: null,
              lastRentEvent: null,
              lastLevelUp: null,
            })
            return true
          },
          applyRepairs: (repairs) => {
            if (repairs.length === 0) return
            set(applyRepairs(persistedOf(get()), repairs))
            keepCarry()
          },
          markGrantsSynced: (keys) => {
            const grants = markGrantsSynced(get().grants, keys)
            if (grants !== get().grants) set({ grants })
          },
        }
      },
      {
        name: STORE_KEY,
        version: STORE_VERSION,
        storage: guard.storage,
        partialize: (state): PersistedState => persistedOf(state),
        migrate: (persisted, version) => migrateGameState(persisted, version, logger),
        merge: (persisted, current) => mergeGameState(persisted, current, logger),
        onRehydrateStorage: () => (_state, error) => {
          if (error instanceof NewerSaveError) {
            // Expected (another tab or a rolled-back build); the save is kept untouched.
            logger.info('Saved game is from a newer build; playing in memory without saving', {
              version: error.version,
            })
          } else if (error !== undefined) {
            logger.warn('Could not load the saved game; playing from a fresh state', {
              error: error instanceof Error ? error.message : String(error),
            })
          }
        },
      },
    ),
  )
  // Hydration is synchronous, so the guard already knows. This write is blocked by the guard.
  if (guard.newerSavePresent) store.setState({ newerSavePresent: true })
  return store
}

export type GameStore = ReturnType<typeof createGameStore>

export const gameStore: GameStore = createGameStore(
  createSafeJsonStorage<PersistedState>(browserLocalStorage),
)

/** React binding: `useGameStore((s) => s.player.cash)`. */
export function useGameStore<T>(selector: (state: GameState) => T): T {
  return useStore(gameStore, selector)
}
