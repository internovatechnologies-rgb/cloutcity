'use client'

/**
 * The HUD's live cells (S05), loaded as a boot island by HudLiveMount: cash, the personal game
 * clock, its speed, clout with the goal line (the Goals button, S15), and the three stats. Each
 * cell subscribes to the slice of the save it shows, so a passing game minute re-renders the
 * clock and the stats, not the clout cell. It also starts the game clock (Q12), tells the Icon
 * moment mount when the moment is due, tells the 3D map which home the player lives in and
 * where they stand, and switches the interface theme with the clock (S04g, ThemeSync.ts).
 *
 * It renders a fragment of grid cells in the HudFrame grid (hudLayout.ts), box for box the same
 * as HudSkeleton.
 */
import { useEffect, useMemo } from 'react'
import { minutesPerDay } from '@/engine/clock'
import { cloutProgress } from '@/engine/clout'
import { engineConfig } from '@/engine/config'
import { claimableCount } from '@/engine/goals'
import type { StatKey } from '@/engine/stats'
import { copy, type CopyKey } from '@/lib/copy'
import { cloutLevelName } from '@/lib/economyCopy'
import { formatCount, formatMoney } from '@/lib/format'
import { setMinuteOfDay } from '@/state/dayClock'
import { startGameClock } from '@/state/gameClock'
import { closeHudPanel, openHudPanel, useHudPanel } from '@/state/hudPanel'
import { clockView, nextSpeed, statsView } from '@/state/hudView'
import { setIconMomentPending } from '@/state/iconMoment'
import { onboardingStore } from '@/state/onboarding'
import { setPlayerHome } from '@/state/playerHome'
import { setPlayerSpot, useTripClockMinute } from '@/state/trip'
import { gameStore, useGameStore } from '@/state/store'
import type { UiThemeClock } from '@/lib/dayNight/uiSchedule'
import { CloutMeter } from './CloutMeter'
import { HUD_CELL } from './hudLayout'
import { useThemeSync } from './ThemeSync'
// Copy namespaces this module renders (DEC-11: they load with this module's chunk).
import '@/lib/copy/ns/hud'

export interface HudLiveProps {
  /** The interface theme's keyframes and colours (S04g), from the server (src/lib/theme.ts). */
  readonly themeClock: UiThemeClock
}

export function HudLive({ themeClock }: HudLiveProps) {
  useHudEffects()
  useThemeSync(themeClock)
  return (
    <>
      <MoneyCell />
      <ClockCell />
      <SpeedCell />
      <CloutCell />
      <StatsCell />
    </>
  )
}

/**
 * The live island's side effects: the game clock, the Icon moment signal, the player's home and
 * the minute of day the day/night cycle reads.
 */
function useHudEffects() {
  const icon = useGameStore((state) => state.goals.icon)
  const home = useGameStore((state) => state.player.home)
  const minuteOfDay = useGameStore((state) => state.clock.minute % minutesPerDay(engineConfig))
  const location = useGameStore((state) => state.player.location)

  // Passive time runs once the welcome card is complete; one driver however often this mounts.
  useEffect(() => startGameClock({ game: gameStore, onboarding: onboardingStore }), [])

  useEffect(() => {
    setIconMomentPending(icon.reachedAt !== null && !icon.acknowledged)
  }, [icon])

  useEffect(() => setPlayerHome(home), [home])
  useEffect(() => setPlayerSpot(location), [location])

  useEffect(() => setMinuteOfDay(minuteOfDay), [minuteOfDay])

  useEffect(() => {
    // Inlined at build time (next.config.ts): production builds drop the hook entirely.
    if (process.env.NEXT_PUBLIC_TEST_HOOKS !== '1') return
    void import('./hudLiveTestHook').then((module) => module.installHudLiveTestHook())
  }, [])
}

function MoneyCell() {
  const cash = useGameStore((state) => state.player.cash)
  const money = formatMoney(cash)
  return (
    <div data-hud-cell="money" className={HUD_CELL.money}>
      <p className="truncate text-lg leading-tight font-extrabold text-taxi-ink">
        <span className="sr-only">{copy('hud.cash')} </span>
        <span data-hud-value="money">{money}</span>
      </p>
    </div>
  )
}

function ClockCell() {
  const saved = useGameStore((state) => state.clock.minute)
  // The trip is already in the save (S08); the clock counts up through it while it animates.
  const travelling = useTripClockMinute()
  const view = clockView(travelling ?? saved, engineConfig)
  return (
    <div data-hud-cell="clock" className={HUD_CELL.clock}>
      <p className="flex flex-col leading-tight">
        <span data-hud-value="day" className="text-[11px] font-bold text-muted">
          {copy('hud.day', { day: formatCount(view.day) })}
        </span>{' '}
        <span data-hud-value="time" className="text-sm font-extrabold whitespace-nowrap text-fg">
          {view.time}
        </span>
      </p>
    </div>
  )
}

function SpeedCell() {
  const speed = useGameStore((state) => state.speed)
  const setSpeed = useGameStore((state) => state.setSpeed)
  const next = nextSpeed(speed, engineConfig.time.speeds)
  const value = formatCount(speed)
  return (
    <div data-hud-cell="speed" className={HUD_CELL.speed}>
      <button
        type="button"
        data-hud-speed={speed}
        aria-label={copy('hud.speed.label', { speed: value })}
        onClick={() => setSpeed(next)}
        className="flex h-11 w-11 items-center justify-center rounded-xl bg-raised text-sm font-extrabold text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        {copy('hud.speed.value', { speed: value })}
      </button>
    </div>
  )
}

/** A trophy (24×24, stroked). */
const TROPHY_ICON =
  'M8 4h8v5a4 4 0 0 1-8 0V4Zm0 2H5a3 3 0 0 0 3 4m8-4h3a3 3 0 0 1-3 4m-4 3v4m-3 3h6'

/**
 * Clout with the goal line (S05): the whole cell is the Goals button (a 44 px target), its top
 * line the goal "Make it in New York"; the clout meter is drawn over its lower half but lets
 * taps through, and keeps its own accessible progress bar. The button's name counts the
 * rewards ready to claim; no toast ever announces one (GR-9).
 */
function CloutCell() {
  const open = useHudPanel()
  const player = useGameStore((state) => state.player)
  const clock = useGameStore((state) => state.clock)
  const goals = useGameStore((state) => state.goals)
  const grants = useGameStore((state) => state.grants)
  const prestige = useGameStore((state) => state.prestige)
  const events = useGameStore((state) => state.events)
  const progress = useMemo(() => cloutProgress(player, engineConfig), [player])
  const ready = useMemo(
    () => claimableCount({ clock, player, goals, grants, prestige, events }, engineConfig),
    [clock, player, goals, grants, prestige, events],
  )
  const goal = copy('hud.goalLine')
  const label =
    ready === 0
      ? copy('hud.goals', { goal })
      : ready === 1
        ? copy('hud.goalsReadyOne', { goal })
        : copy('hud.goalsReady', { goal, count: formatCount(ready) })
  const { next } = progress

  return (
    <div data-hud-cell="clout" className={HUD_CELL.clout}>
      <button
        type="button"
        data-hud-panel="goals"
        data-goals-ready={ready}
        aria-expanded={open === 'goals'}
        aria-label={label}
        onClick={() => (open === 'goals' ? closeHudPanel() : openHudPanel('goals'))}
        className={`absolute inset-0 flex items-start gap-1 rounded-xl px-2 pt-1.5 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus ${
          open === 'goals' ? 'bg-taxi/25' : 'bg-raised'
        }`}
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="h-3.5 w-3.5 shrink-0 fill-none stroke-taxi-ink stroke-2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d={TROPHY_ICON} />
        </svg>
        <span
          aria-hidden="true"
          data-hud-goal-line=""
          className="min-w-0 truncate text-xs leading-3.5 font-extrabold text-taxi-ink"
        >
          {goal}
        </span>
        {ready === 0 ? null : (
          <span
            aria-hidden="true"
            data-cc-notice="goals-ready"
            className="ml-auto min-w-4 shrink-0 rounded-full bg-taxi px-1 text-center text-[10px] leading-3.5 font-bold text-on-taxi"
          >
            {formatCount(ready)}
          </span>
        )}
      </button>
      <div className="pointer-events-none absolute inset-x-2 bottom-1.5">
        <CloutMeter
          levelName={cloutLevelName(progress.level.id)}
          total={progress.counted}
          next={next === null ? null : { name: cloutLevelName(next.id), minClout: next.minClout }}
          pct={progress.pct}
          atMax={progress.atMax}
        />
      </div>
    </div>
  )
}

const STAT_LABEL: Readonly<Record<StatKey, CopyKey>> = {
  energy: 'hud.stats.energy',
  hunger: 'hud.stats.hunger',
  mood: 'hud.stats.mood',
}

const STAT_ICON: Readonly<Record<StatKey, string>> = {
  energy: '⚡',
  hunger: '🍔',
  mood: '🙂',
}

const STAT_BAR: Readonly<Record<StatKey, string>> = {
  energy: 'bg-meter',
  hunger: 'bg-meter',
  mood: 'bg-meter',
}

/**
 * Energy, Fullness and Mood as meters ("80 of 100"). Phones show an icon, wide screens the name
 * (a landscape phone has room for neither, so it keeps the icon).
 */
function StatsCell() {
  const stats = useGameStore((state) => state.player.stats)
  const view = statsView(stats, engineConfig)
  return (
    <div data-hud-cell="stats" className={HUD_CELL.stats}>
      {view.map(({ id, value, max }) => {
        const name = copy(STAT_LABEL[id])
        const text = copy('hud.stats.value', { value: formatCount(value), max: formatCount(max) })
        return (
          <div
            key={id}
            role="meter"
            aria-label={name}
            aria-valuemin={0}
            aria-valuemax={max}
            aria-valuenow={value}
            aria-valuetext={text}
            data-hud-stat={id}
            className="flex min-w-0 flex-1 flex-col justify-center gap-1"
          >
            <span aria-hidden="true" className="flex items-baseline gap-1 text-[11px] leading-none">
              <span className="hud-wide:hidden hud-short:inline">{STAT_ICON[id]}</span>
              <span className="hidden truncate font-bold text-muted hud-wide:inline hud-short:hidden">
                {name}
              </span>
              <span className="ml-auto font-bold text-fg">{formatCount(value)}</span>
            </span>
            <span aria-hidden="true" className="h-1.5 overflow-hidden rounded-full bg-raised">
              <span
                className={`block h-full rounded-full ${STAT_BAR[id]}`}
                style={{ width: `${(value / max) * 100}%` }}
              />
            </span>
          </div>
        )
      })}
    </div>
  )
}
