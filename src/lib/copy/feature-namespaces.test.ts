/**
 * Every reachable copy path renders with only the namespaces its own module graph registers
 * (S05c, DEC-11). Each test starts from a fresh module graph (vi.resetModules), imports one
 * feature module the way its lazy chunk does, then drives every data-driven key and every branch
 * through the active copy function: a missing `import '@/lib/copy/ns/<ns>'` throws
 * CopyNamespaceNotLoadedError (or a "No copy key" error) here instead of in front of a player.
 *
 * key-usage.test.ts checks the literal keys statically; this covers keys named by data (events,
 * venues, landmarks, boroughs, items, jobs, clout levels, homes, club doors) and keys picked at
 * run time (form errors, effect labels, rent notices, block reasons).
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EventEffect } from '@/lib/data/schemas/content'

beforeEach(() => {
  vi.resetModules()
})

/** The namespaces registered so far in this test's fresh module graph. */
async function registered(): Promise<string[]> {
  const { registeredNamespaces } = await import('./registry')
  return registeredNamespaces().sort()
}

describe('feature copy renders with only its own namespaces loaded', () => {
  it('a fresh graph starts with the boot namespaces only (self-check)', async () => {
    const { BOOT_NAMESPACES, copy, CopyNamespaceNotLoadedError } = await import('./index')
    expect(await registered()).toEqual([...BOOT_NAMESPACES].sort())
    expect(() => copy('events.ui.continue')).toThrow(CopyNamespaceNotLoadedError)
  })

  it('boot: every loading and retry label', async () => {
    const { ZoneLoading, ZoneLoadFailed } = await import('@/components/overlay/ZoneLoading')
    const loadingKeys = [
      'loading.welcome',
      'loading.event',
      'loading.place',
      'loading.sound',
      'loading.soundSettings',
      'loading.hud',
      'loading.more',
      'loading.levelUp',
      'loading.places',
    ] as const
    for (const labelKey of loadingKeys) {
      for (const zone of ['hud', 'toast', 'sheet', 'modal'] as const) {
        expect(renderToStaticMarkup(createElement(ZoneLoading, { zone, labelKey }))).toContain(
          'role="status"',
        )
      }
    }
    const failed = renderToStaticMarkup(
      createElement(ZoneLoadFailed, { zone: 'modal', onRetry() {} }),
    )
    expect(failed).toContain('Try again')
    const hudFailed = renderToStaticMarkup(
      createElement(ZoneLoadFailed, { zone: 'hud', onRetry() {} }),
    )
    expect(hudFailed).toContain('Try again')
  })

  it('the sound chunks: the HUD control, the settings sheet and every music title', async () => {
    const { SoundControl } = await import('@/components/audio/SoundControl')
    const { SoundSettingsSheet } = await import('@/components/audio/SoundSettingsSheet')
    const { audioManifest } = await import('@/lib/audio/manifest')
    const { copy, isCopyKey } = await import('./index')

    expect(renderToStaticMarkup(createElement(SoundControl))).toContain('Tap for sound')
    expect(renderToStaticMarkup(createElement(SoundSettingsSheet))).toContain('Close settings')
    const titled = audioManifest.tracks.filter((track) => track.titleKey !== undefined)
    expect(titled.length).toBeGreaterThan(0)
    for (const track of titled) {
      const key = track.titleKey ?? ''
      expect(isCopyKey(key), key).toBe(true)
      if (isCopyKey(key)) expect(copy('audio.hud.track', { title: copy(key) })).not.toBe('')
    }
  })

  it('the event sheet chunk: every event text and every effect label', async () => {
    await import('@/components/events/EventSheet')
    const { effectLabel, effectsSummary, eventText } =
      await import('@/components/events/effectLabels')
    const { copy } = await import('./index')
    const { default: eventsJson } = await import('@data/events/events.json')
    for (const event of eventsJson.events) {
      expect(eventText(event.titleKey)).not.toBe('')
      expect(eventText(event.bodyKey)).not.toBe('')
      for (const choice of event.choices) {
        expect(eventText(choice.labelKey)).not.toBe('')
        expect(eventText(choice.resultKey)).not.toBe('')
        effectsSummary(choice.effects as readonly EventEffect[])
      }
    }
    const effects: EventEffect[] = [
      { kind: 'cash', amount: 5 },
      { kind: 'cash', amount: -5 },
      { kind: 'time', minutes: 30 },
      { kind: 'clout', amount: 3 },
      { kind: 'clout', amount: -3 },
      ...(['energy', 'hunger', 'mood'] as const).flatMap((stat) => [
        { kind: 'stat' as const, stat, amount: 4 },
        { kind: 'stat' as const, stat, amount: -4 },
      ]),
    ]
    for (const effect of effects) expect(effectLabel(effect)).not.toBe('')
    expect(copy('events.ui.cantAfford')).not.toBe('')
    expect(copy('events.ui.continue')).not.toBe('')
  })

  it('the place sheet chunk: every place renders, and every action, block and result reads', async () => {
    const { PlaceSheet } = await import('@/components/places/PlaceSheet')
    const copyFns = await import('@/lib/world/placeActionCopy')
    const { findPlace, landmarks, venues } = await import('@/lib/world/places')
    const { engineConfig } = await import('@/engine/config')
    const { initialSnapshot } = await import('@/engine/game')
    const { performPlaceAction, placeActions } = await import('@/engine/placeActions')
    const { atPlace, playerWithClout } = await import('@/engine/test-support')

    const ids = [...venues, ...landmarks].map((place) => place.id)
    // The home card (S08) renders from the same chunk.
    expect(renderToStaticMarkup(createElement(PlaceSheet, { placeId: 'home' }))).toContain(
      'data-place-sheet="home"',
    )
    for (const placeId of ids) {
      expect(renderToStaticMarkup(createElement(PlaceSheet, { placeId }))).toContain(
        `data-place-sheet="${placeId}"`,
      )
    }

    const base = initialSnapshot(engineConfig)
    const minutes = [0, 6 * 60, 8 * 60, 13 * 60, 18 * 60, 22 * 60, 23 * 60 + 30]
    const players = [
      base.player,
      {
        ...playerWithClout(base.player, 0, engineConfig),
        cash: 0,
        stats: { ...base.player.stats, energy: 0 },
      },
      { ...playerWithClout(base.player, 1_000_000, engineConfig), cash: 1_000_000 },
    ]
    let blocks = 0
    let done = 0
    for (const placeId of ids) {
      const place = findPlace(placeId)
      if (place === undefined) throw new Error(`no place ${placeId}`)
      for (const minute of minutes) {
        for (const player of players) {
          // Standing there (DEC-22), so every other rule is reached; away is checked below.
          const snapshot = atPlace({ clock: { minute, remainderMs: 0 }, player }, placeId)
          copyFns.placeBlockReason({ code: 'away' }, place)
          const view = placeActions(place, snapshot, engineConfig)
          if (view.kind === 'look-only') continue
          copyFns.placeHoursLine(view.hours)
          for (const action of view.actions) {
            copyFns.placeActionAccessibleName(action, place, snapshot)
            if (action.block !== null) {
              blocks += 1
              continue
            }
            const result = performPlaceAction(snapshot, place, action.id, engineConfig)
            if (result.ok) {
              done += 1
              copyFns.placeActionDone(result, place)
            } else if (result.error.code === 'BLOCKED') {
              copyFns.placeBlockReason(result.error.block, place)
            }
          }
        }
      }
    }
    // The sweep reached both branches (self-check).
    expect(blocks).toBeGreaterThan(0)
    expect(done).toBeGreaterThan(0)
  })

  it('the HUD Places button renders with the boot copy alone (S04c)', async () => {
    const { PlacesButton } = await import('@/components/places/PlacesButton')
    expect(await registered()).toEqual(['app', 'loading', 'nav', 'tabs'])
    expect(renderToStaticMarkup(createElement(PlacesButton))).toContain('Places')
  })

  it('the places panel chunk: every borough and place, open, locked and expanding soon', async () => {
    const { PlacesPanel } = await import('@/components/places/PlacesPanel')
    const {
      mapPlaces,
      placeAccess,
      placeAccessibleName,
      boroughs,
      boroughAccessFor,
      boroughClosedReason,
    } = await import('@/lib/world/places')
    const markup = renderToStaticMarkup(createElement(PlacesPanel))
    expect(markup).toContain('data-cc-feature="cc-feature:places-panel"')
    for (const place of mapPlaces()) expect(markup).toContain(`data-place-button="${place.id}"`)
    for (const clout of [0, 1_000_000]) {
      for (const borough of boroughs)
        boroughClosedReason(borough.id, boroughAccessFor(borough.id, clout))
      for (const place of mapPlaces()) {
        expect(placeAccessibleName(place, placeAccess(place, clout))).not.toBe('')
      }
    }
    const { copy } = await import('./index')
    for (const key of [
      'places.panel.chooserTitle',
      'places.panel.chooserHint',
      'places.panel.showAll',
      'places.announce.opened',
    ] as const) {
      expect(copy(key, { place: 'x' })).not.toBe('')
    }
  })

  it('the HUD live chunk: the meter at every level, with and without a next level', async () => {
    await import('@/components/hud/HudLive')
    const { CloutMeter } = await import('@/components/hud/CloutMeter')
    const { cloutLevelName } = await import('@/lib/economyCopy')
    const { engineConfig } = await import('@/engine/config')
    const levels = engineConfig.clout.levels
    levels.forEach((level, i) => {
      const next = levels[i + 1]
      const markup = renderToStaticMarkup(
        createElement(CloutMeter, {
          levelName: cloutLevelName(level.id),
          total: level.minClout,
          next:
            next === undefined ? null : { name: cloutLevelName(next.id), minClout: next.minClout },
          pct: 0,
          atMax: next === undefined,
        }),
      )
      expect(markup).toContain('cc-feature:clout-hud')
    })
  })

  it('the HUD live chunk: the Goals button label for any count (S15, S05)', async () => {
    await import('@/components/hud/HudLive')
    const { copy } = await import('./index')
    const goal = copy('hud.goalLine')
    expect(goal).toBe('Make it in New York')
    expect(copy('hud.goals', { goal })).toBe('Goals: Make it in New York')
    expect(copy('hud.goalsReadyOne', { goal })).toBe('Goals: Make it in New York, 1 reward ready')
    expect(copy('hud.goalsReady', { goal, count: '2' })).toBe(
      'Goals: Make it in New York, 2 rewards ready',
    )
  })

  it('the HUD live chunk renders every cell for a new player (S05)', async () => {
    const { HudLive } = await import('@/components/hud/HudLive')
    const markup = renderToStaticMarkup(createElement(HudLive))
    for (const cell of ['money', 'clock', 'speed', 'clout', 'stats']) {
      expect(markup).toContain(`data-hud-cell="${cell}"`)
    }
    for (const text of ['$150', 'Day 1', '8:00 AM', 'Make it in New York', 'Nobody']) {
      expect(markup).toContain(text)
    }
    expect(markup).toContain('aria-valuetext="80 of 100"')
    expect(markup).toContain('Game speed 1x, tap to change')
  })

  it('the More panel chunk and the HUD skeleton render their labels (S05)', async () => {
    // The skeleton is shell code: boot copy only.
    const { HudSkeleton } = await import('@/components/hud/HudSkeleton')
    expect(renderToStaticMarkup(createElement(HudSkeleton))).toContain('Loading your stats')
    expect(await registered()).not.toContain('hud')
    const { MorePanel } = await import('@/components/hud/MorePanel')
    const more = renderToStaticMarkup(createElement(MorePanel))
    for (const text of ['Inventory', 'Rent', 'Home', 'Settings']) expect(more).toContain(text)
  })

  it('the home chunk: slots, colours, storage, moves, locks and every home error (S16)', async () => {
    const { HomePanel } = await import('@/components/hud/HomePanel')
    const { engineConfig } = await import('@/engine/config')
    const { isDecor } = await import('@/engine/items')
    const homeCopy = await import('@/lib/homeCopy')
    const { HOME_IDS } = await import('@/lib/data/homes')
    const { slotsFor } = await import('@/engine/home')

    const fresh = renderToStaticMarkup(createElement(HomePanel))
    for (const text of ['Queens room', 'Home score 0', 'Storage', 'Brooklyn 1BR. ']) {
      expect(fresh).toContain(text)
    }
    // A server render reads the store's initial snapshot, so the rows for owned decor are
    // driven through the helpers they render with.
    const decor = engineConfig.items.catalog.filter(isDecor)
    const { copy } = await import('./index')
    for (const key of ['home.storage.pickUp', 'home.slot.remove', 'home.slot.placeHere'] as const) {
      expect(copy(key)).not.toBe('')
    }
    for (const item of decor) {
      expect(homeCopy.pickUpLabel(item.id)).not.toBe('')
      expect(homeCopy.fitsLine(item.id)).not.toBe('')
      expect(homeCopy.placeLabel(item.id, 'queens-room', 'wall-1')).not.toBe('')
    }
    for (const home of HOME_IDS) {
      for (const slot of slotsFor(home, engineConfig)) {
        expect(homeCopy.slotName(home, slot.id)).not.toBe('')
      }
    }
    for (const item of decor) {
      for (const variant of item.decor.variants) {
        expect(homeCopy.variantChangedNotice(item.id, variant.id)).not.toBe('')
      }
      expect(homeCopy.pickedNotice(item.id)).not.toBe('')
    }
    for (const home of HOME_IDS) expect(homeCopy.movedNotice(home)).not.toBe('')
    const errors = [
      { code: 'UNKNOWN_ITEM', itemId: 'x' },
      { code: 'NOT_DECOR', itemId: 'x' },
      { code: 'NOT_OWNED', itemId: 'x' },
      { code: 'UNKNOWN_SLOT', slotId: 'x' },
      { code: 'WRONG_SLOT_KIND', itemId: 'x', slotId: 'x', fits: 'wall', kind: 'floor' },
      { code: 'UNKNOWN_VARIANT', itemId: 'x', variantId: 'x' },
      { code: 'UNKNOWN_HOME', home: 'x' },
      { code: 'CURRENT_HOME', home: 'queens-room' },
      { code: 'FUNDS_SHORT', home: 'brooklyn-1br', required: 600, available: 1 },
      {
        code: 'BOROUGH_LOCKED',
        home: 'brooklyn-1br',
        borough: 'brooklyn',
        access: { status: 'locked', required: 'local', current: 'nobody' },
      },
      {
        code: 'BOROUGH_LOCKED',
        home: 'manhattan-loft',
        borough: 'manhattan',
        access: { status: 'expanding-soon' },
      },
    ] as const
    for (const error of errors) expect(homeCopy.homeErrorText(error)).not.toBe('')
  })

  it('the goals chunk: every goal line, status, reward and claim label (S15)', async () => {
    await import('@/components/hud/GoalsPanel')
    const goalsCopy = await import('@/lib/goalsCopy')
    const { copy } = await import('./index')
    const { engineConfig } = await import('@/engine/config')
    const { goalsView, syncGoals } = await import('@/engine/goals')
    const { grant } = await import('@/engine/grants')
    const { initialSave } = await import('@/engine/save')
    const { playerWithClout } = await import('@/engine/test-support')
    for (const clout of [0, 150, 5000]) {
      const base = initialSave(engineConfig)
      let save = syncGoals(
        { ...base, player: playerWithClout(base.player, clout, engineConfig) },
        engineConfig,
      ).save
      const claimed = grant(
        save,
        { kind: 'goal_reward', goalId: 'reach-local', reward: { cash: 50, clout: 15 } },
        1,
        engineConfig,
      )
      if (claimed.ok) save = claimed.save
      for (const busy of [null, 'probe-event']) {
        const views = goalsView({ ...save, events: { ...save.events, active: busy } }, engineConfig)
        for (const view of views) {
          expect(goalsCopy.goalName(view.id)).not.toBe('')
          expect(goalsCopy.goalHint(view.id)).not.toBe('')
          expect(goalsCopy.goalProgressLabel(view)).not.toBe('')
          expect(goalsCopy.goalStatusText(view)).not.toBe('')
          expect(goalsCopy.rewardLine(view)).not.toBe('')
          expect(goalsCopy.claimButton(view).label).not.toBe('')
        }
      }
    }
    for (const key of [
      'goals.heading',
      'goals.intro',
      'goals.note',
      'goals.capped',
      'goals.claim.refused',
      'goals.badges.heading',
    ] as const) {
      expect(copy(key)).not.toBe('')
    }
    expect(goalsCopy.claimedText('reach-local', { cash: 1, clout: 1, badge: null })).not.toBe('')
    expect(copy('goals.run', { run: '2' })).not.toBe('')
  })

  it('the Icon moment chunk: the victory screen, share text and prestige lists (S15)', async () => {
    await import('@/components/goals/IconMoment')
    const goalsCopy = await import('@/lib/goalsCopy')
    const { copy } = await import('./index')
    const { cloutLevelName } = await import('@/lib/economyCopy')
    const { engineConfig } = await import('@/engine/config')
    for (const part of [...engineConfig.prestige.resets, ...engineConfig.prestige.keeps]) {
      expect(goalsCopy.prestigePartName(part)).not.toBe('')
    }
    for (const badge of engineConfig.prestige.badgeIds) {
      expect(copy('goals.icon.confirm.badge', { badge: goalsCopy.badgeName(badge) })).not.toBe('')
    }
    const level = cloutLevelName(engineConfig.clout.levels[0]?.id ?? '')
    expect(copy('goals.icon.confirm.go', { level })).toBe('Start over at Nobody, keep your badges')
    for (const key of [
      'goals.icon.title',
      'goals.icon.body',
      'goals.icon.share',
      'goals.icon.shared',
      'goals.icon.copied',
      'goals.icon.copyThis',
      'goals.icon.prestige',
      'goals.icon.keepPlaying',
      'goals.icon.confirm.title',
      'goals.icon.confirm.body',
      'goals.icon.confirm.resets',
      'goals.icon.confirm.keeps',
      'goals.icon.confirm.back',
      'goals.icon.confirm.refused',
      'share.icon.text',
      'share.footer',
    ] as const) {
      expect(copy(key)).not.toBe('')
    }
  })

  it('the level-up chunk: every level-up title, message, unlock line and close label', async () => {
    await import('@/components/hud/LevelUpToast')
    const copyFns = await import('@/lib/levelUpCopy')
    const { recordClout } = await import('@/engine/clout')
    const { engineConfig } = await import('@/engine/config')
    const { initialSnapshot } = await import('@/engine/game')
    for (const level of engineConfig.clout.levels.slice(1)) {
      const change = {
        source: 'event',
        amount: level.minClout,
        ref: { eventId: 'e', choiceId: 'c' },
      } as const
      const { levelUp } = recordClout(initialSnapshot(engineConfig), change, engineConfig)
      if (levelUp === null) throw new Error(`expected a level-up to ${level.id}`)
      expect(copyFns.levelUpTitle(levelUp)).not.toBe('')
      expect(copyFns.levelUpMessage(levelUp)).not.toBe('')
      expect(copyFns.levelUpCloseLabel(levelUp)).not.toBe('')
      copyFns.levelUpUnlocked(levelUp)
    }
  })

  it('the welcome chunk: the card, the lock notice and every form error', async () => {
    const { WelcomeCard } = await import('@/components/welcome/WelcomeCard')
    const { AgeLockNotice } = await import('@/components/welcome/AgeLockNotice')
    const { fieldErrors } = await import('@/lib/forms/errors')
    const { createWelcomeSchema, WELCOME_FIELDS } = await import('@/lib/forms/welcome')
    const { copy } = await import('./index')

    expect(
      renderToStaticMarkup(createElement(WelcomeCard, { titleId: 't', introId: 'i' })),
    ).toContain('id="t"')
    expect(
      renderToStaticMarkup(createElement(AgeLockNotice, { titleId: 't', bodyId: 'b' })),
    ).toContain('id="t"')

    const schema = createWelcomeSchema(2026, { birthYearSpan: 100 })
    const errors = fieldErrors(schema, { birthYear: 'x', consent: false, audio: '' })
    expect(Object.keys(errors).sort()).toEqual([...WELCOME_FIELDS].sort())
    for (const key of Object.values(errors)) if (key !== undefined) copy(key)
    // A well-formed year the picker does not offer takes the refine branch.
    const outOfRange = fieldErrors(schema, { birthYear: '1000', consent: true, audio: 'own' })
    expect(Object.keys(outOfRange)).toEqual(['birthYear'])
  })

  it('the handle form: every form error (S18a)', async () => {
    const { fieldErrors } = await import('@/lib/forms/errors')
    const { createHandleSchema } = await import('@/lib/forms/handle')
    const { copy } = await import('./index')

    const schema = createHandleSchema()
    const keys = new Set<string>()
    for (const handle of ['', 'a'.repeat(40), 'ab c', '9lives', 'a__b', 'A123']) {
      const key = fieldErrors(schema, { handle }).handle
      if (key !== undefined) {
        keys.add(key)
        expect(copy(key)).not.toBe('')
      }
    }
    expect(keys.size).toBe(6)
  })

  it('the report form: every form error (S18b)', async () => {
    const { fieldErrors } = await import('@/lib/forms/errors')
    const { createReportSchema } = await import('@/lib/forms/report')
    const { copy } = await import('./index')

    const schema = createReportSchema('player')
    const keys = new Set<string>()
    for (const values of [
      { reason: '', note: '' },
      { reason: 'spam', note: 'x'.repeat(1000) },
      { reason: 'spam', note: 'www.example.com' },
    ]) {
      for (const key of Object.values(fieldErrors(schema, values))) {
        if (key === undefined) continue
        keys.add(key)
        expect(copy(key)).not.toBe('')
      }
    }
    expect(keys.size).toBe(3)
  })

  it('economy copy: every job, clout level, home and rent notice', async () => {
    const economy = await import('@/lib/economyCopy')
    const { engineConfig } = await import('@/engine/config')
    const { homeIds } = await import('@/engine/rent')
    const { default: jobsJson } = await import('@data/jobs/jobs.json')
    const levels = engineConfig.clout.levels.map((level) => level.id)
    const homes = homeIds(engineConfig)

    for (const job of jobsJson.jobs) {
      const jobId = job.id as Parameters<typeof economy.jobName>[0]
      economy.shiftLabel(jobId)
      for (const level of levels) {
        economy.jobLockedLabel({ jobId, requiredLevel: level, currentLevel: levels[0] ?? level })
      }
    }
    economy.shiftDone(56)
    for (const home of homes) {
      economy.homeRentLine(home)
      economy.nextRentDueLine(home, 7)
      for (const other of homes) economy.homeRentComparison(home, other)
    }
    const home = homes[0]
    if (home === undefined) throw new Error('no homes')
    const notices = [
      economy.rentNotice({ kind: 'paid', day: 7, home, rent: 100, arrears: 0 }),
      economy.rentNotice({ kind: 'paid', day: 7, home, rent: 100, arrears: 20 }),
      economy.rentNotice({ kind: 'arrears-paid', day: 7, amount: 20 }),
      economy.rentNotice({
        kind: 'missed',
        day: 7,
        home,
        owed: 100,
        lateFee: 0,
        missesBeforeEviction: 2,
      } as Parameters<typeof economy.rentNotice>[0]),
      economy.rentNotice({
        kind: 'missed',
        day: 7,
        home,
        owed: 100,
        lateFee: 10,
        missesBeforeEviction: 1,
      } as Parameters<typeof economy.rentNotice>[0]),
      economy.rentNotice({
        kind: 'evicted',
        day: 7,
        from: home,
        to: home,
      } as Parameters<typeof economy.rentNotice>[0]),
    ]
    for (const notice of notices) expect(notice).not.toBe('')
  })

  it('shop copy: every item, slot and rarity', async () => {
    const shop = await import('@/lib/shopCopy')
    const { engineConfig } = await import('@/engine/config')
    const { ITEM_SLOTS, isGift } = await import('@/engine/items')
    const { default: balanceJson } = await import('@data/config/balance.json')
    for (const item of engineConfig.items.catalog) {
      shop.itemName(item.id)
      shop.itemDescription(item.id)
      shop.buyLabel(item.id)
      shop.cannotAffordLabel(item.id, 0)
      shop.alreadyOwnedLabel(item.id)
      shop.boughtNotice(item.id, 10)
      shop.sellLabel(item.id, 5)
      shop.soldNotice(item.id, 5)
      if (isGift(item)) {
        shop.useGiftOnSelfLabel(item.id)
        shop.giftUsedOnSelfNotice(item.id)
        shop.giftCountLine(item.id, 2)
      }
      for (const slot of ITEM_SLOTS) {
        shop.equipLabel(item.id, slot)
        shop.unequipLabel(item.id, slot)
      }
    }
    for (const slot of ITEM_SLOTS) shop.slotName(slot)
    for (const rarity of balanceJson.rarityTiers) {
      shop.rarityName(rarity as Parameters<typeof shop.rarityName>[0])
    }
  })
})

describe('S18a/S18b chunks render with only their own namespaces', () => {
  it('the Me panel: the not-connected state for every reason, and the public card', async () => {
    const { MePanel } = await import('@/components/profile/MePanel')
    const { PublicCard } = await import('@/components/profile/PublicCard')
    const { guestSessionStore } = await import('@/state/guestSession')
    const reasons = ['no-config', 'offline', 'rate-limited', 'disabled', 'error'] as const
    for (const reason of reasons) {
      guestSessionStore.setState({ status: 'local', reason, reused: false })
      expect(renderToStaticMarkup(createElement(MePanel))).toContain('cc-feature:me-panel')
    }
    for (const status of ['idle', 'connecting', 'refused'] as const) {
      guestSessionStore.setState({ status, reason: null, reused: false })
      renderToStaticMarkup(createElement(MePanel))
    }
    for (const [level, career] of [
      ['nobody', null],
      ['scene-regular', 'artist-dj'],
      ['icon', 'founder-hustler'],
    ] as const) {
      const profile = {
        handle: 'Bold_Bodega42',
        public_level: level,
        career_path: career,
        avatar: {},
        handle_generated: true,
        free_handle_change: true,
        handle_changes_left: 2,
        next_handle_change_at: null,
      }
      expect(renderToStaticMarkup(createElement(PublicCard, { profile }))).toContain(
        '@Bold_Bodega42',
      )
    }
  })

  it('the safety chunk: player actions in both layouts, the report form, the toast and notices', async () => {
    const { PlayerActions } = await import('@/components/safety/PlayerActions')
    const { ReportForm } = await import('@/components/safety/ReportForm')
    const { CrisisPanel } = await import('@/components/safety/CrisisPanel')
    const { BlockConfirm } = await import('@/components/safety/BlockConfirm')
    const { unavailableSafetyApi } = await import('@/lib/supabase/safetyApi')
    const api = unavailableSafetyApi()
    const player = { id: 'p', handle: 'Rival' }
    for (const layout of ['inline', 'menu'] as const) {
      expect(renderToStaticMarkup(createElement(PlayerActions, { player, layout, api }))).toContain(
        `data-player-actions="${layout}"`,
      )
    }
    for (const kind of ['player', 'handle'] as const) {
      renderToStaticMarkup(
        createElement(ReportForm, {
          handle: 'Rival',
          target: 'p',
          kind,
          api,
          onSubmitted() {},
          onCancel() {},
        }),
      )
    }
    expect(renderToStaticMarkup(createElement(CrisisPanel))).toContain('988')
    renderToStaticMarkup(
      createElement(BlockConfirm, { handle: 'Rival', busy: false, onConfirm() {}, onCancel() {} }),
    )
  })

  it('the notice modal and the toast', async () => {
    const { AccountNotices } = await import('@/components/safety/AccountNotices')
    const { SafetyToast } = await import('@/components/safety/SafetyToast')
    const { setAccountNotices } = await import('@/state/accountNotices')
    const { showSafetyToast } = await import('@/state/safetyToast')
    const { unavailableSafetyApi } = await import('@/lib/supabase/safetyApi')
    const { NOTICE_KINDS } = await import('@/lib/safety/reports')
    for (const kind of NOTICE_KINDS) {
      setAccountNotices(
        [
          {
            id: kind,
            kind,
            reason: 'spam',
            endsAt: '2026-10-14T00:00:00Z',
            createdAt: '2026-10-07T00:00:00Z',
            sanctionId: 's',
          },
        ],
        unavailableSafetyApi(),
      )
      renderToStaticMarkup(createElement(AccountNotices))
    }
    showSafetyToast('Blocked', { label: 'Undo', untilMs: Date.now() + 1000, run() {} })
    renderToStaticMarkup(createElement(SafetyToast))
  })

  it('the /mod console', async () => {
    const { ModConsole } = await import('@/components/mod/ModConsole')
    expect(renderToStaticMarkup(createElement(ModConsole))).toContain('Moderation')
  })
})
