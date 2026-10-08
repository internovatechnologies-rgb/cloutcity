/**
 * The first-run tour (S06, GR-9): which step a player is on, persisted to localStorage under
 * `cloutcity:tour`, separate from the game save so a save repair or a fresh game never brings the
 * tour back by itself (and the tour never touches the save).
 *
 * Six coach-mark steps over the live map lead to one purchase: the HUD, the Places button, the
 * place in the Places panel, its action in the place sheet, the cash it cost, and where to find
 * the tour again. Steps move on what the player does, never on a timer. A tap on the place's pin
 * on the map skips straight to the purchase step.
 *
 * Records:
 *  - none: this device has never decided. A fresh game starts the tour; anyone else (a player
 *    from before the tour existed) is a veteran and is marked done without seeing it.
 *  - `active`: on a step; the cash step keeps what the purchase cost.
 *  - `skipped`: the player skipped on a step; More, Help resumes it there.
 *  - `done`: finished (or a veteran); More, Help replays it from the start.
 *
 * Stored data is untrusted: it is validated on load, and anything that does not fit counts as no
 * record. Like the other stores it hydrates synchronously when this module loads in a browser.
 */
import { persist, type PersistStorage } from 'zustand/middleware'
import { createStore } from 'zustand/vanilla'
import * as z from 'zod/mini'
import type { EngineConfig } from '@/engine/config'
import type { SaveState } from '@/engine/save'
import { log, type Logger } from '@/lib/log'
import type { PlaceActionDone } from './placeSheet'
import { browserLocalStorage, createSafeJsonStorage, guardNewerVersion } from './storage'

export const TOUR_KEY = 'cloutcity:tour'
export const TOUR_VERSION = 1

export const TOUR_STEPS = ['hud', 'find', 'pick', 'buy', 'cash', 'done'] as const
export type TourStep = (typeof TOUR_STEPS)[number]

const cash = z.int().check(z.gte(0))

const ActiveRecordSchema = z.strictObject({
  status: z.literal('active'),
  step: z.enum(TOUR_STEPS),
  /** What the guided purchase did to the player's cash; set on the cash step only. */
  receipt: z.nullable(z.strictObject({ before: cash, after: cash })),
})
const SkippedRecordSchema = z.strictObject({
  status: z.literal('skipped'),
  step: z.enum(TOUR_STEPS),
})
const DoneRecordSchema = z.strictObject({ status: z.literal('done') })

export const TourRecordSchema = z.discriminatedUnion('status', [
  ActiveRecordSchema,
  SkippedRecordSchema,
  DoneRecordSchema,
])
export type TourRecord = z.infer<typeof TourRecordSchema>
export type ActiveTour = z.infer<typeof ActiveRecordSchema>

export const PersistedTourSchema = z.strictObject({ record: z.nullable(TourRecordSchema) })
export type PersistedTour = z.infer<typeof PersistedTourSchema>

/** The place and action the tour leads to (data/config/tour.json). */
export interface TourTarget {
  readonly placeId: string
  readonly actionId: string
}

/** What the tour reads from the screen: whether the Places panel shows, and the open place. */
export interface TourUi {
  readonly panelShown: boolean
  readonly openPlaceId: string | null
}

export type TourEvent =
  /** The step's Next (or, on the last step, Done) button. */
  | { readonly type: 'next'; readonly ui: TourUi }
  /** The Places panel or the open place changed. */
  | { readonly type: 'ui'; readonly ui: TourUi }
  /** A place sheet action succeeded. */
  | { readonly type: 'purchased'; readonly done: PlaceActionDone }
  | { readonly type: 'skip' }
  /** More, Help. */
  | { readonly type: 'resume'; readonly ui: TourUi }

const active = (step: TourStep): ActiveTour => ({ status: 'active', step, receipt: null })
const DONE: TourRecord = { status: 'done' }

/**
 * The step that matches the screen while the player is on the way to the place: its sheet open
 * means the purchase step, the Places panel on screen means picking from it, anything else means
 * finding the Places button again (the player closed the panel, or went into another place).
 */
function wayStep(ui: TourUi, target: TourTarget): 'find' | 'pick' | 'buy' {
  if (ui.openPlaceId === target.placeId) return 'buy'
  return ui.panelShown ? 'pick' : 'find'
}

function settle(step: TourStep, ui: TourUi, target: TourTarget): TourStep {
  switch (step) {
    case 'hud':
      // A tap on the place's pin before the player got to the Places button.
      return ui.openPlaceId === target.placeId ? 'buy' : 'hud'
    case 'find':
    case 'pick':
    case 'buy':
      return wayStep(ui, target)
    case 'cash':
    case 'done':
      return step
  }
}

const NEXT: Readonly<Partial<Record<TourStep, TourStep>>> = { hud: 'find', cash: 'done' }

/** The tour's transitions. Pure: the same record and event always give the same record. */
export function nextTourRecord(
  record: TourRecord,
  event: TourEvent,
  target: TourTarget,
): TourRecord {
  switch (event.type) {
    case 'resume': {
      if (record.status === 'active') return record
      // A skip mid-way resumes there (on whichever way step fits the screen); a finished tour,
      // or one skipped after the purchase, replays from the start.
      const from = record.status === 'skipped' && record.step !== 'cash' ? record.step : 'hud'
      if (record.status === 'done' || from === 'done') return active('hud')
      return active(settle(from, event.ui, target))
    }
    case 'skip':
      return record.status === 'active' ? { status: 'skipped', step: record.step } : record
    case 'next': {
      if (record.status !== 'active') return record
      if (record.step === 'done') return DONE
      const next = NEXT[record.step]
      return next === undefined ? record : active(settle(next, event.ui, target))
    }
    case 'ui': {
      if (record.status !== 'active') return record
      const step = settle(record.step, event.ui, target)
      return step === record.step ? record : active(step)
    }
    case 'purchased': {
      if (record.status !== 'active') return record
      const { done } = event
      const onTheWay = record.step !== 'cash' && record.step !== 'done'
      if (!onTheWay || done.placeId !== target.placeId || done.actionId !== target.actionId) {
        return record
      }
      return {
        status: 'active',
        step: 'cash',
        receipt: { before: done.cashBefore, after: done.cashAfter },
      }
    }
  }
}

/** The tour settings `isFreshStart` reads (data/config/tour.json). */
export interface FreshStartConfig {
  readonly freshStartMaxGameMinutes: number
}

/**
 * A game nobody has played yet: start cash, nothing earned, bought, visited or prestiged, and
 * little time on the clock. The tour starts by itself only then.
 */
export function isFreshStart(
  save: Pick<SaveState, 'clock' | 'player' | 'prestige'>,
  engine: Pick<EngineConfig, 'startCash' | 'time'>,
  tour: FreshStartConfig,
): boolean {
  const { player, clock, prestige } = save
  return (
    player.cash === engine.startCash &&
    player.clout.ledger.length === 0 &&
    player.clout.compacted.entries === 0 &&
    player.inventory.wearables.length === 0 &&
    player.inventory.gifts.length === 0 &&
    Object.keys(player.visited).length === 0 &&
    prestige.count === 0 &&
    // A new game's clock starts at startMinuteOfDay on day one (src/engine/clock.ts).
    clock.minute - engine.time.startMinuteOfDay <= tour.freshStartMaxGameMinutes
  )
}

export interface TourState {
  /**
   * undefined until storage has been read (only while the store is being created); null when
   * this device has never decided.
   */
  readonly record: TourRecord | null | undefined
  /** Decides a device's first tour: a fresh game starts it, anyone else never sees it unasked. */
  begin(fresh: boolean): void
  dispatch(event: TourEvent, target: TourTarget): void
}

export function createTourStore(storage: PersistStorage<PersistedTour>, logger: Logger = log) {
  return createStore<TourState>()(
    persist(
      (set, get) => ({
        record: undefined,
        begin: (fresh) => {
          if (get().record !== null) return
          set({ record: fresh ? active('hud') : DONE })
        },
        dispatch: (event, target) => {
          const { record } = get()
          // Help before the first tour was decided (the map still loading) plays it from the start.
          const current = record ?? (event.type === 'resume' ? DONE : null)
          if (current === null) return
          const next = nextTourRecord(current, event, target)
          if (next !== record) set({ record: next })
        },
      }),
      {
        name: TOUR_KEY,
        version: TOUR_VERSION,
        storage: guardNewerVersion(storage, TOUR_VERSION),
        partialize: ({ record }): PersistedTour => ({ record: record ?? null }),
        migrate: (persisted, version): PersistedTour => {
          // A newer build may have added fields or records: whatever still fits is kept, and
          // anything else counts as no record (a veteran is then marked done, never pestered).
          logger.info('Reading tour progress saved by another build', { version })
          const result = PersistedTourSchema.safeParse(persisted)
          return { record: result.success ? result.data.record : null }
        },
        merge: (persisted, current) => {
          if (persisted === undefined || persisted === null) return { ...current, record: null }
          const result = PersistedTourSchema.safeParse(persisted)
          if (!result.success) {
            logger.info('Ignoring tour progress that failed validation')
            return { ...current, record: null }
          }
          return { ...current, record: result.data.record }
        },
      },
    ),
  )
}

export type TourStore = ReturnType<typeof createTourStore>

export const tourStore: TourStore = createTourStore(
  createSafeJsonStorage<PersistedTour>(browserLocalStorage),
)
