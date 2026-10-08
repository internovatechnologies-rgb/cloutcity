/**
 * User Timing marks for `npm run e2e:perf` (S04b) and for profiling on a real phone:
 * - `cc:shell-interactive`: the boot hold has released the shell (HUD and loading state usable);
 * - `cc:playable`: the 3D map has drawn with the player's avatar placed;
 * - `cc:3d:<step>`: the 3D start-up steps (PERF-4), in the order the map starts.
 * Each mark is set once per page load. Marks cost a few bytes and no frames, so they ship in
 * every build; a browser without the User Timing API simply gets none.
 */

export const SHELL_INTERACTIVE_MARK = 'cc:shell-interactive'
export const PLAYABLE_MARK = 'cc:playable'

/** The 3D start-up steps, in order. */
export const SCENE_MARKS = [
  /** The shell's scene mount starts the probe and the geo download. */
  'cc:3d:start',
  /** WebGL2 probed and the tier picked. */
  'cc:3d:probed',
  /** Geo layers downloaded. */
  'cc:3d:geo',
  /** The 3D chunk has been evaluated. */
  'cc:3d:chunk',
  /** The canvas mount began (after the idle start). */
  'cc:3d:mount',
  /** Geo layers validated. */
  'cc:3d:parsed',
  /** The WebGL renderer exists. */
  'cc:3d:gl',
  /** The city meshes are built. */
  'cc:3d:built',
  /** The shaders are compiled. */
  'cc:3d:compiled',
  /** The first frame showing the city has drawn. */
  'cc:3d:first-frame',
] as const

export type PerfMarkName =
  typeof SHELL_INTERACTIVE_MARK | typeof PLAYABLE_MARK | (typeof SCENE_MARKS)[number]

const marked = new Set<PerfMarkName>()

/** Sets the mark once per page load; later calls and missing APIs are no-ops. */
export function perfMark(name: PerfMarkName): void {
  if (marked.has(name)) return
  marked.add(name)
  if (typeof performance === 'undefined' || typeof performance.mark !== 'function') return
  performance.mark(name)
}
