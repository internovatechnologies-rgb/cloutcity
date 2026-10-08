'use client'

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { ActionList } from '@/components/places/ActionList'
import { engineConfig, type HomeId } from '@/engine/config'
import { homeLock, slotsFor, type HomeError } from '@/engine/home'
import { homeActions } from '@/engine/placeActions'
import { findItem, isDecor, type DecorDef, type DecorFit, type OwnedDecor } from '@/engine/items'
import { homeIds } from '@/engine/rent'
import { copy } from '@/lib/copy'
import type { QualityTier } from '@/lib/data/schemas/config'
import { homeName } from '@/lib/economyCopy'
import {
  currentHomeLine,
  decorKindHeading,
  fitsLine,
  homeErrorText,
  homeLockName,
  homeLockReason,
  homeScoreLine,
  movedNotice,
  moveButtonText,
  moveConfirmText,
  moveDetails,
  moveLabel,
  pickedNotice,
  pickUpLabel,
  placedNotice,
  placeLabel,
  putDownLabel,
  removedNotice,
  removeLabel,
  slotHoldsLine,
  slotName,
  slotSelectedNotice,
  variantChangedNotice,
  variantLegend,
  variantName,
} from '@/lib/homeCopy'
import { log } from '@/lib/log'
import { itemName } from '@/lib/shopCopy'
import type { ApartmentPlacement, SlotTap } from '@/scene/apartment/types'
import { useActionGuard } from '@/components/overlay/useActionGuard'
import { onApartmentSlotTap, setApartmentView } from '@/state/apartmentView'
import { closeHudPanel } from '@/state/hudPanel'
import { openPlace } from '@/state/placeSheet'
import { gameStore, useGameStore } from '@/state/store'
import { HOME_SPOT_ID } from '@/state/trip'
import { PANEL_BUTTON, PanelDialog, PanelStatus } from './PanelDialog'
// Copy namespaces this module renders (DEC-11: they load with this module's chunk).
import '@/lib/copy/ns/home'
import '@/lib/copy/ns/hud'

const ACTION = `${PANEL_BUTTON} bg-raised text-center text-sm text-fg enabled:hover:bg-pressed`
const ROW = 'flex flex-col gap-1.5 rounded-xl bg-canvas/60 p-2'
const SECTION_HEADING = 'text-xs font-bold text-muted uppercase'
const KINDS: readonly DecorFit[] = ['wall', 'floor', 'surface']

const performHomeAction = (actionId: string) => gameStore.getState().performHomeAction(actionId)

/**
 * Quality tiers arrive with S04b; until then every device gets the mid tier, as the map does
 * (src/scene/CityScene.tsx `dprCap`).
 */
const DEVICE_TIER: QualityTier = 'mid'

function decorDef(itemId: string): DecorDef | null {
  const item = findItem(itemId, engineConfig)
  return item !== undefined && isDecor(item) ? item : null
}

/** A decor item's colour choices as native radios named in words ("Hot pink", A11Y-1). */
function VariantRadios({
  owned,
  def,
  onChange,
}: {
  readonly owned: OwnedDecor
  readonly def: DecorDef
  readonly onChange: (variantId: string) => void
}) {
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="text-xs text-muted">{variantLegend(def.id)}</legend>
      <div className="flex flex-wrap gap-1.5">
        {def.decor.variants.map((variant) => (
          <label
            key={variant.id}
            className="inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-xl bg-raised px-2 text-sm text-fg has-[:checked]:bg-taxi has-[:checked]:text-on-taxi has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus"
          >
            <input
              type="radio"
              name={`home-variant-${def.id}`}
              value={variant.id}
              checked={owned.variant === variant.id}
              onChange={() => onChange(variant.id)}
              className="h-4 w-4 accent-on-taxi"
            />
            <span
              aria-hidden="true"
              className="h-3.5 w-3.5 rounded-full border border-line-strong"
              style={{ backgroundColor: `var(--palette-${variant.token})` }}
            />
            {variantName(def.id, variant.id)}
          </label>
        ))}
      </div>
    </fieldset>
  )
}

/**
 * The Home panel (S16), opened from the HUD: the player's apartment. It shows the home score
 * (which feeds clout), every decor slot grouped Wall / Floor / Surface with what sits there and
 * its colour, the decor in storage with "Pick up to place", and the other homes with Move (a
 * two-step confirm) or, when locked, why ("{home}. {reason}", in the accessible name too).
 *
 * The 3D room (src/scene/apartment/ApartmentMount.tsx, fed through src/state/apartmentView.ts)
 * draws behind the panel in the scene area and mirrors it: tapping a slot there places the held
 * item or selects the slot here. Everything the room does, this list
 * does with a keyboard (A11Y-3), and without WebGL the list is the whole feature. Every action
 * goes through the store to the engine; the result, or the engine's refusal, shows in the status
 * line. Loaded lazily by HudPanelMount (DEC-11).
 */
export function HomePanel() {
  const player = useGameStore((state) => state.player)
  const clock = useGameStore((state) => state.clock)
  const minute = clock.minute
  const snapshot = useMemo(() => ({ clock, player }), [clock, player])
  const rest = useMemo(() => homeActions(snapshot, engineConfig), [snapshot])
  const restId = useId()
  const [heldId, setHeldId] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [chooserIds, setChooserIds] = useState<readonly string[] | null>(null)
  const [confirming, setConfirming] = useState<HomeId | null>(null)
  // The nonce re-runs the focus check for every result, even when two read the same.
  const [result, setResult] = useState<{ readonly text: string; readonly nonce: number } | null>(
    null,
  )
  const { guard: act, onKeyDown, onPointerDown, coolingDown } = useActionGuard()
  const dialogRef = useRef<HTMLElement | null>(null)
  /** A selector, inside the panel, to focus after the next render. */
  const pendingFocus = useRef<string | null>(null)

  const { home, inventory, apartment } = player
  const slots = slotsFor(home, engineConfig)
  const ownedById = new Map(inventory.decor.map((owned) => [owned.itemId, owned]))
  const placedIds = new Set(Object.values(apartment.placed))
  const stored = inventory.decor.filter((owned) => !placedIds.has(owned.itemId))
  // Derived, so a sale elsewhere or a move never leaves a stale hold, selection or chooser.
  const held = heldId !== null && stored.some((owned) => owned.itemId === heldId) ? heldId : null
  const heldDef = held === null ? null : decorDef(held)
  const selected = slots.some((slot) => slot.id === selectedId) ? selectedId : null
  const chooser = chooserIds?.filter((id) => slots.some((slot) => slot.id === id)) ?? null

  useEffect(() => {
    dialogRef.current = document.querySelector<HTMLElement>('[data-hud-panel-dialog="home"]')
  }, [])

  // Moves focus where the last action asked; if the focused control left the page (a slot emptied,
  // an item placed), focus stays in the panel on its heading instead of dropping to the body.
  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog === null) return
    const target = pendingFocus.current
    pendingFocus.current = null
    if (target !== null) {
      const found = dialog.querySelector<HTMLElement>(target)
      if (found !== null) {
        found.focus()
        found.scrollIntoView({ block: 'nearest' })
        return
      }
    }
    if (result !== null && !dialog.contains(document.activeElement)) {
      dialog.querySelector<HTMLElement>('h2')?.focus()
    }
  })

  const show = (text: string) => setResult((last) => ({ text, nonce: (last?.nonce ?? 0) + 1 }))

  const refused = (error: HomeError, context: Record<string, unknown>) => {
    // The panel offers only what the engine allows, so a refusal means the state moved under it.
    log.info('A home action was refused', { ...context, code: error.code })
    show(homeErrorText(error))
  }

  const placeHeld = (itemId: string, slotId: string) => {
    const outcome = gameStore.getState().placeDecor(itemId, slotId)
    if (!outcome.ok) {
      refused(outcome.error, { itemId, slotId })
      return
    }
    setHeldId(null)
    setSelectedId(null)
    setChooserIds(null)
    pendingFocus.current = `[data-home-slot="${slotId}"] [data-home-remove]`
    show(placedNotice(itemId, home, slotId))
  }

  const remove = (itemId: string, slotId: string) => {
    const outcome = gameStore.getState().removeDecor(slotId)
    if (!outcome.ok) {
      refused(outcome.error, { slotId })
      return
    }
    pendingFocus.current = `[data-home-stored="${itemId}"] [data-home-pick]`
    show(removedNotice(itemId))
  }

  const pickUp = (itemId: string) => {
    if (held === itemId) {
      setHeldId(null)
      show(removedNotice(itemId))
      return
    }
    setHeldId(itemId)
    setChooserIds(null)
    pendingFocus.current = '[data-home-place-here]'
    show(pickedNotice(itemId))
  }

  const setVariant = (itemId: string, variantId: string) => {
    const outcome = gameStore.getState().setDecorVariant(itemId, variantId)
    if (!outcome.ok) refused(outcome.error, { itemId, variantId })
    else show(variantChangedNotice(itemId, variantId))
  }

  const chooseSlot = (slotId: string) => {
    setChooserIds(null)
    if (held !== null) {
      placeHeld(held, slotId)
      return
    }
    setSelectedId(slotId)
    pendingFocus.current = `[data-home-slot="${slotId}"]`
    show(slotSelectedNotice(home, slotId))
  }

  const onSlotTap = (tap: SlotTap) => {
    if (tap.kind === 'one') {
      chooseSlot(tap.slotId)
      return
    }
    setChooserIds(tap.slotIds)
    pendingFocus.current = '[data-home-chooser] button'
  }

  const move = (to: HomeId) => {
    const outcome = gameStore.getState().moveHome(to)
    setConfirming(null)
    if (!outcome.ok) {
      refused(outcome.error, { to })
      return
    }
    setHeldId(null)
    setSelectedId(null)
    setChooserIds(null)
    pendingFocus.current = 'h2'
    show(movedNotice(to))
  }

  const buttonGuard = { onKeyDown, onPointerDown }

  // Only a real change of what sits where (or its colour) may reach the room: a new object on
  // every render (the clock ticks) would make the on-demand canvas draw for nothing.
  const placements = useMemo(() => {
    const owned = new Map(inventory.decor.map((entry) => [entry.itemId, entry.variant]))
    const result: Record<string, ApartmentPlacement> = {}
    for (const [slotId, itemId] of Object.entries(apartment.placed)) {
      const variant = owned.get(itemId)
      const token = decorDef(itemId)?.decor.variants.find((entry) => entry.id === variant)?.token
      if (token !== undefined) result[slotId] = { itemId, token }
    }
    return result
  }, [apartment.placed, inventory.decor])

  const heldKind = heldDef?.decor.fits ?? null
  const label = copy('home.view.label', { home: homeName(home) })
  useEffect(() => {
    setApartmentView({
      home,
      placed: placements,
      heldKind,
      selectedSlotId: selected,
      label,
      minute,
      tier: DEVICE_TIER,
    })
  }, [home, placements, heldKind, selected, label, minute])
  // Closing the panel closes the room.
  useEffect(() => () => setApartmentView(null), [])

  // Taps on the room reach the latest handler (it reads this render's hold and selection).
  const tapHandler = useRef(onSlotTap)
  useEffect(() => {
    tapHandler.current = onSlotTap
  })
  useEffect(() => onApartmentSlotTap((tap) => tapHandler.current(tap)), [])

  return (
    <PanelDialog
      title={copy('home.heading')}
      panel="home"
      feature="cc-feature:home-panel"
      onClose={closeHudPanel}
      scrollBody
    >
      <div className="flex flex-col gap-0.5">
        <p className="text-sm text-fg" data-home-current="">
          {currentHomeLine(home)}
        </p>
        <p className="text-sm font-bold text-taxi-ink" data-home-score="">
          {homeScoreLine(player)}
        </p>
      </div>

      {/* B1: rest and eat here. Away, the rows say to head home first, and one button opens
          the home card with the trip back. */}
      <div data-home-rest="" className="flex flex-col gap-1.5">
        <ActionList
          headingId={restId}
          actions={rest}
          place={null}
          snapshot={snapshot}
          perform={performHomeAction}
        />
        {player.location.kind === 'home' ? null : (
          <button
            type="button"
            data-home-head-home=""
            onClick={() => openPlace(HOME_SPOT_ID, { origin: 'panel' })}
            className={`${ACTION} bg-taxi text-on-taxi enabled:hover:bg-taxi`}
          >
            {copy('home.rest.headHome')}
          </button>
        )}
      </div>

      {chooser === null || chooser.length === 0 ? null : (
        <section
          data-home-chooser=""
          aria-label={copy('home.chooser.heading')}
          className="flex flex-col gap-1.5"
        >
          <h3 className={SECTION_HEADING}>{copy('home.chooser.heading')}</h3>
          <div className="flex flex-wrap gap-1.5">
            {chooser.map((slotId) => (
              <button
                key={slotId}
                type="button"
                {...buttonGuard}
                onClick={(event) => act(event, `choose-${slotId}`, () => chooseSlot(slotId))}
                className={ACTION}
              >
                {slotName(home, slotId)}
              </button>
            ))}
            <button type="button" onClick={() => setChooserIds(null)} className={ACTION}>
              {copy('home.chooser.cancel')}
            </button>
          </div>
        </section>
      )}

      <section aria-label={copy('home.slots.heading')} className="flex flex-col gap-1.5">
        <h3 className={SECTION_HEADING}>{copy('home.slots.heading')}</h3>
        {KINDS.map((kind) => {
          const ofKind = slots.filter((slot) => slot.kind === kind)
          if (ofKind.length === 0) return null
          return (
            <div
              key={kind}
              role="group"
              aria-label={decorKindHeading(kind)}
              data-home-kind={kind}
              className="flex flex-col gap-1.5"
            >
              <h4 className="text-sm font-bold text-fg">{decorKindHeading(kind)}</h4>
              <ul aria-busy={coolingDown} className="flex flex-col gap-1.5">
                {ofKind.map((slot) => {
                  const itemId = apartment.placed[slot.id]
                  const owned = itemId === undefined ? undefined : ownedById.get(itemId)
                  const def = itemId === undefined ? null : decorDef(itemId)
                  const fitsHeld = heldDef !== null && heldDef.decor.fits === slot.kind
                  const isSelected = selected === slot.id
                  // A selected empty slot offers what in storage fits it (the 3D tap's next step).
                  const offers =
                    isSelected && held === null && itemId === undefined
                      ? stored.filter((entry) => decorDef(entry.itemId)?.decor.fits === slot.kind)
                      : []
                  return (
                    <li
                      key={slot.id}
                      data-home-slot={slot.id}
                      data-selected={isSelected ? '' : undefined}
                      tabIndex={-1}
                      className={`${ROW} focus:outline-2 focus:outline-focus ${
                        isSelected ? 'ring-2 ring-taxi-ink' : ''
                      }`}
                    >
                      <div className="min-w-0">
                        <p className="font-semibold text-fg">{slotName(home, slot.id)}</p>
                        <p className="text-xs text-muted">
                          {itemId === undefined || owned === undefined
                            ? copy('home.slot.empty')
                            : slotHoldsLine(itemId, owned.variant)}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {fitsHeld && held !== null ? (
                          <button
                            type="button"
                            data-home-place-here=""
                            {...buttonGuard}
                            aria-label={placeLabel(held, home, slot.id)}
                            onClick={(event) =>
                              act(event, `place-${slot.id}`, () => placeHeld(held, slot.id))
                            }
                            className={`${ACTION} bg-taxi text-on-taxi enabled:hover:bg-taxi`}
                          >
                            {copy('home.slot.placeHere')}
                          </button>
                        ) : null}
                        {offers.map((entry) => (
                          <button
                            key={entry.itemId}
                            type="button"
                            data-home-offer={entry.itemId}
                            {...buttonGuard}
                            aria-label={placeLabel(entry.itemId, home, slot.id)}
                            onClick={(event) =>
                              act(event, `place-${slot.id}`, () => placeHeld(entry.itemId, slot.id))
                            }
                            className={ACTION}
                          >
                            {itemName(entry.itemId)}
                          </button>
                        ))}
                        {itemId === undefined ? null : (
                          <button
                            type="button"
                            data-home-remove=""
                            {...buttonGuard}
                            aria-label={removeLabel(itemId, home, slot.id)}
                            onClick={(event) =>
                              act(event, `remove-${slot.id}`, () => remove(itemId, slot.id))
                            }
                            className={ACTION}
                          >
                            {copy('home.slot.remove')}
                          </button>
                        )}
                      </div>
                      {def === null || owned === undefined ? null : (
                        <VariantRadios
                          owned={owned}
                          def={def}
                          onChange={(variantId) => setVariant(def.id, variantId)}
                        />
                      )}
                    </li>
                  )
                })}
              </ul>
            </div>
          )
        })}
      </section>

      <section aria-label={copy('home.storage.heading')} className="flex flex-col gap-1.5">
        <h3 className={SECTION_HEADING}>{copy('home.storage.heading')}</h3>
        {inventory.decor.length === 0 ? (
          <p className="text-sm text-muted">{copy('home.storage.none')}</p>
        ) : stored.length === 0 ? (
          <p className="text-sm text-muted">{copy('home.storage.empty')}</p>
        ) : (
          <ul aria-busy={coolingDown} className="flex flex-col gap-1.5">
            {stored.map((owned) => {
              const def = decorDef(owned.itemId)
              if (def === null) return null
              const holding = held === owned.itemId
              return (
                <li key={owned.itemId} data-home-stored={owned.itemId} className={ROW}>
                  <div className="min-w-0">
                    <p className="font-semibold text-fg">{itemName(owned.itemId)}</p>
                    <p className="text-xs text-muted">{fitsLine(owned.itemId)}</p>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      data-home-pick=""
                      {...buttonGuard}
                      aria-pressed={holding}
                      aria-label={holding ? putDownLabel(owned.itemId) : pickUpLabel(owned.itemId)}
                      onClick={(event) =>
                        act(event, `pick-${owned.itemId}`, () => pickUp(owned.itemId))
                      }
                      className={`${ACTION} ${holding ? 'bg-taxi text-on-taxi' : ''}`}
                    >
                      {copy(holding ? 'home.storage.putDown' : 'home.storage.pickUp')}
                    </button>
                  </div>
                  <VariantRadios
                    owned={owned}
                    def={def}
                    onChange={(variantId) => setVariant(def.id, variantId)}
                  />
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <section aria-label={copy('home.move.heading')} className="flex flex-col gap-1.5">
        <h3 className={SECTION_HEADING}>{copy('home.move.heading')}</h3>
        <ul className="flex flex-col gap-1.5">
          {homeIds(engineConfig)
            .filter((id) => id !== home)
            .map((id) => {
              const lock = homeLock(player, id, engineConfig)
              return (
                <li key={id} data-home-move={id} className={ROW}>
                  <div className="min-w-0">
                    <p className="font-semibold text-fg">{homeName(id)}</p>
                    <p className="text-xs text-muted">{moveDetails(id)}</p>
                    {lock === null ? null : (
                      <p className="text-xs text-taxi-ink">{homeLockReason(lock)}</p>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      data-home-move-button=""
                      {...buttonGuard}
                      aria-disabled={lock === null ? undefined : true}
                      aria-expanded={lock === null ? confirming === id : undefined}
                      aria-label={lock === null ? moveLabel(id) : homeLockName(lock)}
                      onClick={(event) => {
                        if (lock !== null) return
                        act(event, `move-${id}`, () => {
                          setConfirming(confirming === id ? null : id)
                          pendingFocus.current = `[data-home-move="${id}"] [data-home-confirm]`
                        })
                      }}
                      className={`${ACTION} ${lock === null ? '' : 'cursor-not-allowed text-muted'}`}
                    >
                      {moveButtonText(id)}
                    </button>
                  </div>
                  {lock === null && confirming === id ? (
                    <div
                      role="group"
                      aria-label={moveButtonText(id)}
                      className="flex flex-col gap-1.5"
                    >
                      <p className="text-sm text-fg" data-home-confirm-text="">
                        {moveConfirmText(id)}
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        <button
                          type="button"
                          data-home-confirm=""
                          {...buttonGuard}
                          onClick={(event) => act(event, `confirm-${id}`, () => move(id))}
                          className={`${ACTION} bg-taxi text-on-taxi enabled:hover:bg-taxi`}
                        >
                          {copy('home.move.confirmButton')}
                        </button>
                        <button
                          type="button"
                          {...buttonGuard}
                          onClick={(event) =>
                            act(event, `cancel-${id}`, () => {
                              setConfirming(null)
                              pendingFocus.current = `[data-home-move="${id}"] [data-home-move-button]`
                            })
                          }
                          className={ACTION}
                        >
                          {copy('home.move.cancel')}
                        </button>
                      </div>
                    </div>
                  ) : null}
                </li>
              )
            })}
        </ul>
      </section>
      <PanelStatus text={result?.text ?? null} />
    </PanelDialog>
  )
}
