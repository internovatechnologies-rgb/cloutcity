'use client'

import { useEffect, useRef, useState } from 'react'
import { engineConfig } from '@/engine/config'
import { giftCount, isDecor, isWearable, shopItems, type ShopItemDef } from '@/engine/items'
import { shopBlock } from '@/engine/placeActions'
import type { Place } from '@/engine/places'
import { ignoreKeyRepeat } from '@/components/overlay/useActionGuard'
import { copy } from '@/lib/copy'
import { log } from '@/lib/log'
import {
  alreadyOwnedLabel,
  boughtNotice,
  buyLabel,
  cannotAffordLabel,
  itemErrorText,
  itemName,
  shopItemDetails,
  stackFullLabel,
} from '@/lib/shopCopy'
import { placeBlockReason } from '@/lib/world/placeActionCopy'
import { gameStore, useGameStore, type GameState } from '@/state/store'

const BUTTON =
  'min-h-11 min-w-11 shrink-0 rounded-xl bg-raised px-3 py-2 text-center text-sm font-semibold text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus enabled:hover:bg-pressed disabled:opacity-70'

/**
 * Why the player cannot buy `item` here right now, as player-facing text, or null when they
 * can. Mirrors the engine's checks in `buyAtShop` (shop open, owned once, gift stack, funds),
 * which re-runs them on every buy.
 */
function buyBlockReason(
  item: ShopItemDef,
  place: Place,
  state: Pick<GameState, 'clock' | 'player'>,
): string | null {
  const block = shopBlock(place, state, engineConfig)
  if (block !== null) return placeBlockReason(block, place)
  const { inventory, cash } = state.player
  if (isWearable(item) || isDecor(item)) {
    const owned = isWearable(item) ? inventory.wearables : inventory.decor
    if (owned.some((entry) => entry.itemId === item.id)) return alreadyOwnedLabel(item.id)
  } else {
    const max = engineConfig.items.maxGiftStack
    if (giftCount(inventory, item.id) >= max) return stackFullLabel(item.id, max)
  }
  if (cash < item.price) return cannotAffordLabel(item.id, cash)
  return null
}

/**
 * The shop at a boutique or thrift store (S10a), inside the place sheet: every item for sale
 * with its name, slot, rarity and price, and a Buy button. A disabled Buy button says why in
 * its accessible name (closed, owned, hands full, or the cash shortfall). Buying goes through
 * the store to the engine; the result or refusal shows in the status line.
 */
export function ShopSection({
  place,
  headingId,
}: {
  readonly place: Place
  readonly headingId: string
}) {
  const clock = useGameStore((state) => state.clock)
  const player = useGameStore((state) => state.player)
  // The nonce re-runs the focus check for every buy, even when two buys read the same.
  const [result, setResult] = useState<{ readonly text: string; readonly nonce: number } | null>(
    null,
  )
  const ref = useRef<HTMLElement>(null)
  const activated = useRef<HTMLButtonElement | null>(null)

  // A buy can disable the Buy button under the tap (a wearable bought, a gift stack filled).
  // A disabled button keeps document focus in some browsers but takes no keys, and in others
  // focus drops to the body; either way, move it to the shop heading.
  useEffect(() => {
    const section = ref.current
    const button = activated.current
    activated.current = null
    if (result === null || section === null) return
    const lost = button !== null && (button.disabled || !button.isConnected)
    if (lost || !section.contains(document.activeElement)) {
      section.querySelector<HTMLElement>('h3')?.focus()
    }
  }, [result])

  const show = (text: string) => setResult((last) => ({ text, nonce: (last?.nonce ?? 0) + 1 }))

  const buy = (itemId: string, button: HTMLButtonElement) => {
    activated.current = button
    const outcome = gameStore.getState().buyAtShop(place, itemId)
    if (outcome.ok) {
      show(boughtNotice(itemId, outcome.price))
      return
    }
    // The UI only enables what the engine allows, so a refusal means the state moved under it.
    log.info('A shop purchase was refused', { placeId: place.id, itemId, code: outcome.error.code })
    const { error } = outcome
    show(
      error.code === 'BLOCKED'
        ? placeBlockReason(error.block, place)
        : error.code === 'NOT_A_SHOP'
          ? copy('shop.error.failed')
          : itemErrorText(error),
    )
  }

  return (
    <section
      ref={ref}
      aria-labelledby={headingId}
      data-shop={place.id}
      className="flex flex-col gap-1.5"
    >
      <h3
        id={headingId}
        tabIndex={-1}
        className="text-xs font-bold text-muted uppercase focus:outline-none"
      >
        {copy('shop.heading')}
      </h3>
      <ul className="flex flex-col gap-1.5">
        {shopItems(engineConfig).map((item) => {
          const reason = buyBlockReason(item, place, { clock, player })
          return (
            <li
              key={item.id}
              data-shop-item={item.id}
              className="flex items-center justify-between gap-2 rounded-xl bg-canvas/60 p-2"
            >
              <div className="min-w-0">
                <p className="font-semibold text-fg">{itemName(item.id)}</p>
                <p className="text-xs text-muted">{shopItemDetails(item.id)}</p>
                {reason === null ? null : <p className="text-xs text-taxi-ink">{reason}</p>}
              </div>
              <button
                type="button"
                disabled={reason !== null}
                aria-label={
                  reason === null
                    ? buyLabel(item.id)
                    : copy('place.action.blockedLabel', { action: buyLabel(item.id), reason })
                }
                onKeyDown={ignoreKeyRepeat}
                onClick={(event) => buy(item.id, event.currentTarget)}
                className={BUTTON}
              >
                {copy('shop.buy.button')}
              </button>
            </li>
          )
        })}
      </ul>
      {/* aria-live rather than role="status": the sheet already has a status line. */}
      <p
        aria-live="polite"
        data-shop-status=""
        className="min-h-5 text-sm font-semibold text-taxi-ink"
      >
        {result?.text}
      </p>
    </section>
  )
}
