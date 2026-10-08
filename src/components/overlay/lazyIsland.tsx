'use client'

import {
  Component,
  createContext,
  lazy,
  Suspense,
  useContext,
  useState,
  type ComponentType,
  type ErrorInfo,
  type ReactNode,
} from 'react'
import type { CopyKey } from '@/lib/copy'
import { log } from '@/lib/log'
import { useModalSettled } from './modalState'
import { useHydrated } from './useHydrated'
import { ZoneLoadFailed, ZoneLoading, type IslandZone } from './ZoneLoading'

/**
 * Islands (DEC-11): the shell JS of `/` carries only the boot path, and everything else loads in
 * its own chunk through `lazyIsland`.
 *
 * - A boot island (`eager: true`) starts loading as soon as the shell runs in the browser: the
 *   welcome card with its zod-validated store, the game store with the event-sheet host.
 * - A feature island loads the first time it renders: the event sheet UI, the place sheet, later
 *   the shop, panels and transit planner.
 *
 * Either way it renders only after hydration and shows {@link ZoneLoading} in its own zone
 * while its chunk loads. A chunk that fails to load (offline, a dropped request) is an expected
 * condition: it is logged at info and the zone offers a retry, which imports it again. A render
 * error inside a loaded island is a bug: the boundary still offers the retry, and React reports
 * the error.
 */
export interface IslandOptions {
  /** The zone the island renders in; its loading and retry states are drawn there. */
  readonly zone: IslandZone
  /** Names what is loading: the loading status's accessible name. */
  readonly labelKey: CopyKey
  /** Start loading when the shell runs, instead of on first render. */
  readonly eager?: boolean
  /**
   * Render nothing while loading. For a host that may well render nothing once loaded (the
   * event-sheet host with no event open), so boot shows no placeholder.
   */
  readonly quiet?: boolean
  /**
   * Drawn on the server, during hydration and while the chunk loads, in place of the zone's
   * loading state: a skeleton with the loaded island's exact boxes (the HUD, S05), so nothing
   * moves or flashes when it arrives. It must render the same on the server and the client.
   */
  readonly placeholder?: ReactNode
}

const RetryContext = createContext<() => void>(() => {})

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error
}

/** A lazily loaded component, with the loading, retry and hydration rules above. */
export function lazyIsland<P extends object>(
  load: () => Promise<ComponentType<P>>,
  options: IslandOptions,
): ComponentType<P> {
  const { zone, labelKey, eager = false, quiet = false, placeholder } = options
  let pending: Promise<ComponentType<P>> | undefined

  // One import in flight at a time; a failure is forgotten so the next attempt imports again.
  const start = () => {
    pending ??= load().catch((error: unknown) => {
      pending = undefined
      throw error
    })
    return pending
  }

  // The modal slot's island releases the page's boot hold (modalState.ts) once it has loaded and
  // rendered: its own modal presence, if any, is registered in the same commit (a child's
  // effects run first), so the page never leaves `inert` in between.
  const settling = (Component: ComponentType<P>): ComponentType<P> => {
    if (zone !== 'modal') return Component
    function Settled(props: P) {
      useModalSettled()
      return <Component {...props} />
    }
    return Settled
  }

  function LoadFailed() {
    return <ZoneLoadFailed zone={zone} onRetry={useContext(RetryContext)} />
  }

  // A failed import resolves to the retry view instead of throwing into React: the failure is
  // expected (offline), so it must not reach the console as an error.
  const build = () =>
    lazy(() =>
      start().then(
        (component) => ({ default: settling(component) }),
        (error: unknown) => {
          log.info('A feature failed to load; offering a retry', {
            zone,
            label: labelKey,
            error: errorName(error),
          })
          return { default: LoadFailed as ComponentType<P> }
        },
      ),
    )
  let Current = build()

  if (eager && typeof window !== 'undefined') {
    start().catch((error: unknown) => {
      log.info('A boot island failed to preload; it loads again when it renders', {
        zone,
        label: labelKey,
        error: errorName(error),
      })
    })
  }

  function Island(props: P) {
    const hydrated = useHydrated()
    const [generation, setGeneration] = useState(0)
    if (!hydrated) return placeholder ?? null

    const retry = () => {
      Current = build()
      setGeneration((value) => value + 1)
    }
    const Loaded = Current as ComponentType<P>
    return (
      <RetryContext value={retry}>
        <IslandBoundary key={generation} zone={zone} onRetry={retry}>
          <Suspense
            fallback={
              placeholder ?? (quiet ? null : <ZoneLoading zone={zone} labelKey={labelKey} />)
            }
          >
            <Loaded {...props} />
          </Suspense>
        </IslandBoundary>
      </RetryContext>
    )
  }
  Island.displayName = `Island(${labelKey})`
  return Island
}

interface IslandBoundaryProps {
  readonly zone: IslandZone
  readonly onRetry: () => void
  readonly children: ReactNode
}

/** Catches a render error inside an island and offers the same retry as a failed load. */
class IslandBoundary extends Component<IslandBoundaryProps, { readonly failed: boolean }> {
  override state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo) {
    log.error('A feature island crashed while rendering', {
      zone: this.props.zone,
      error: errorName(error),
      componentStack: info.componentStack ?? undefined,
    })
  }

  override render() {
    if (this.state.failed)
      return <ZoneLoadFailed zone={this.props.zone} onRetry={this.props.onRetry} />
    return this.props.children
  }
}
