/**
 * The shell of `/` carries only the boot path (S05c, DEC-11). Starting at the route's server
 * modules, it collects the client shell: everything statically reachable from a `'use client'`
 * module they import (an `import()` is the lazy boundary, so islands do not count). Every
 * module in it must be on the allowlist below, and none may be a feature module, a feature copy
 * namespace or zod. scripts/shell-guard.ts checks the same rule on the built chunks.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BOOT_NAMESPACES } from '@/lib/copy'
import {
  ROOT,
  SRC,
  clientClosure,
  isClientModule,
  rel,
  staticClosure,
  staticSpecifiers,
} from './testing/importGraph'

const ENTRIES = [join(SRC, 'app/page.tsx'), join(SRC, 'app/layout.tsx')]

const BOOT = BOOT_NAMESPACES.join('|')

/** Modules the shell may contain. */
const ALLOWED_FILES: readonly RegExp[] = [
  /^src\/components\/overlay\//,
  /^src\/components\/nav\//,
  /^src\/components\/[\w/]+Mount\.tsx$/,
  /^src\/lib\/copy\/(index|registry)\.ts$/,
  new RegExp(`^src/lib/copy/ns/(${BOOT})\\.ts$`),
  new RegExp(`^data/copy/(${BOOT})/[\\w-]+\\.json$`),
  /^data\/copy\/superlatives\.json$/,
  /^data\/config\/copy\.json$/,
  /^src\/lib\/(log|format|placeholders|perfMarks)\.ts$/,
  // Tiny session-only signals whose features load lazily (S18b: the safety toast, notices).
  /^src\/state\/(placeSheet|placesPanel|mapPlayable|hudPanel|iconMoment|safetyToast|accountNotices)\.ts$/,
  // The trip on screen (S08): the place slot shows its progress card. Types only from the engine.
  /^src\/state\/trip\.ts$/,
  // The HUD's Places button (S04c): the way into the Places panel must not wait for a chunk.
  /^src\/components\/places\/PlacesButton\.tsx$/,
  /^src\/components\/audio\/soundSheet\.ts$/,
  // The HUD skeleton (S05): the live cells' boxes, drawn before their island loads.
  /^src\/components\/hud\/(HudSkeleton\.tsx|hudLayout\.ts)$/,
  // The 3D map's thin mount: WebGL probe, geo download, status and error boundary. The canvas
  // and everything three-based load through its next/dynamic import (the 3D chunk).
  /^src\/scene\/(CitySceneClient|SceneErrorBoundary)\.tsx$/,
  /^src\/scene\/(webgl|schedule|geo\/load)\.ts$/,
  // The apartment's thin mount (S16): its next/dynamic import must be reachable from the page
  // for the build to list the room's chunk; it reads the room's view and hands the screen over.
  /^src\/scene\/apartment\/ApartmentMount\.tsx$/,
  /^src\/state\/(apartmentView|sceneFocus)\.ts$/,
  // The tier picker runs in the shell (S04b); the quality store it reports to is lazy.
  /^src\/lib\/quality\/(probe|tier)\.ts$/,
]

/** Packages the shell may import (zod is not one of them). */
const ALLOWED_PACKAGES = /^(react|react-dom|next|zustand)(\/|$)/

/** Never in the shell, named so a failure says why. */
const DENIED_FILES: readonly RegExp[] = [
  /^src\/state\/(store|onboarding|audioSettings|audioStatus|storage|session|gameClock|clockDriver|guestSession|playerHome|dayClock|hudView|tour|quality|tripDriver|transitWorld|geoSource|travelTestHook)\.ts$/,
  /^src\/lib\/supabase\//,
  /^src\/lib\/audio\//,
  /^src\/components\/audio\/(SoundControl|SoundSettingsSheet)\.tsx$/,
  /^src\/engine\//,
  /^src\/lib\/world\//,
  /^src\/lib\/(shopCopy|economyCopy|goalsCopy|tourCopy)\.ts$/,
  // The tour (S06): only TourMount is in the shell.
  /^src\/components\/tour\/(TourHost|tourControl)\.tsx?$/,
  /^src\/lib\/share\//,
  /^src\/lib\/forms\//,
  /^src\/components\/events\/(EventSheet|EventSheetHost|effectLabels|eventTestHook)\.tsx?$/,
  /^src\/components\/places\/(PlaceSheet|PlacesPanel|ShopSection|placeTestHook)\.tsx?$/,
  /^src\/components\/hud\/(HudLive|HudPanelButtons|InventoryPanel|RentPanel|GoalsPanel|MorePanel|PanelDialog|hudTestHook|hudLiveTestHook)\.tsx?$/,
  /^src\/components\/goals\/IconMoment\.tsx$/,
  /^src\/components\/welcome\/(WelcomeGate|WelcomeCard|AgeLockNotice)\.tsx$/,
  /^src\/lib\/copy\/all\.ts$/,
  /^src\/scene\/(CityCanvas|City|materials|testHooks)\.tsx?$/,
  /^src\/scene\/camera\//,
  /^src\/scene\/pins\//,
  /^src\/scene\/geo\/(?!load\.ts$)/,
  new RegExp(`^src/lib/copy/ns/(?!(${BOOT})\\.ts$)`),
  new RegExp(`^data/copy/(?!(${BOOT})/|superlatives\\.json$)`),
  /^data\/(events|items|venues|landmarks|boroughs|jobs|premium|geo|zones|audio)\//,
]

const DENIED_PACKAGES = /^(zod|@supabase\/[\w.-]+)(\/|$)/

export function shellViolations(files: Iterable<string>, packages: Iterable<string>): string[] {
  const found: string[] = []
  for (const file of files) {
    const path = rel(file)
    if (DENIED_FILES.some((pattern) => pattern.test(path))) found.push(`${path} (denied)`)
    else if (!ALLOWED_FILES.some((pattern) => pattern.test(path))) {
      found.push(`${path} (not on the boot-path allowlist)`)
    }
  }
  for (const spec of packages) {
    if (DENIED_PACKAGES.test(spec) || !ALLOWED_PACKAGES.test(spec)) found.push(`package ${spec}`)
  }
  return found
}

describe('shell boundary of / (S05c)', () => {
  const shell = clientClosure(ENTRIES)
  const shellPaths = [...shell.files].map(rel)

  it('collects the client shell from the route', () => {
    expect(shellPaths).toEqual(
      expect.arrayContaining([
        'src/components/nav/BottomTabs.tsx',
        'src/components/overlay/lazyIsland.tsx',
        'src/components/events/EventSheetMount.tsx',
        'src/components/places/PlaceSheetMount.tsx',
        'src/components/places/PlacesButton.tsx',
        'src/components/places/PlacesPanelMount.tsx',
        'src/components/welcome/WelcomeMount.tsx',
        'src/scene/CitySceneClient.tsx',
        'src/components/audio/SoundControlMount.tsx',
        'src/components/audio/SoundSheetMount.tsx',
        'src/components/goals/IconMomentMount.tsx',
        'src/components/hud/HudLiveMount.tsx',
        'src/components/hud/HudSkeleton.tsx',
        'src/state/iconMoment.ts',
        'src/lib/copy/index.ts',
        'src/lib/copy/ns/app.ts',
        'data/copy/tabs/base.json',
      ]),
    )
    // Server components render on the server only: the layout and page are not shell JS.
    expect(shellPaths).not.toContain('src/app/page.tsx')
  })

  it('reaches only boot-path modules, and no feature module, feature copy or zod', () => {
    expect(shellViolations(shell.files, shell.packages.keys())).toEqual([])
  })

  it('stops at import(): every lazy island is outside the shell', () => {
    for (const path of [
      'src/components/events/EventSheetHost.tsx',
      'src/components/events/EventSheet.tsx',
      'src/components/places/PlaceSheet.tsx',
      'src/components/places/PlacesPanel.tsx',
      'src/scene/pins/PlacePins.tsx',
      'src/components/welcome/WelcomeGate.tsx',
      'src/scene/CityCanvas.tsx',
      'src/scene/City.tsx',
      'src/state/store.ts',
      'src/state/onboarding.ts',
      'src/state/quality.ts',
      'src/scene/quality/TierMonitor.tsx',
      'src/components/audio/SoundControl.tsx',
      'src/components/audio/SoundSettingsSheet.tsx',
      'src/state/audioSettings.ts',
      'src/lib/audio/unlock.ts',
      'src/lib/audio/runtime.ts',
      'src/components/hud/GoalsPanel.tsx',
      'src/components/goals/IconMoment.tsx',
      'src/lib/goalsCopy.ts',
      'src/lib/share/shareMoment.ts',
      'src/engine/goals.ts',
      'src/components/hud/HudLive.tsx',
      'src/components/hud/MorePanel.tsx',
      'src/state/gameClock.ts',
      'src/state/dayClock.ts',
      'src/state/guestSession.ts',
      'src/lib/supabase/supabaseAuth.ts',
    ]) {
      expect(existsSync(join(ROOT, path)), path).toBe(true)
      expect(shellPaths, path).not.toContain(path)
    }
  })

  it('the deny list catches feature modules, feature copy and zod (self-check)', () => {
    const at = (path: string) => join(ROOT, path)
    expect(
      shellViolations(
        [
          at('src/state/store.ts'),
          at('src/engine/events.ts'),
          at('src/lib/world/places.ts'),
          at('src/lib/copy/ns/events.ts'),
          at('src/lib/copy/all.ts'),
          at('data/copy/events/base.json'),
          at('src/components/places/PlaceSheet.tsx'),
          at('src/scene/CityCanvas.tsx'),
          at('src/scene/geo/schema.ts'),
          at('src/state/audioSettings.ts'),
          at('src/lib/audio/runtime.ts'),
          at('src/lib/copy/ns/audio.ts'),
          at('src/components/audio/SoundControl.tsx'),
          at('src/components/overlay/lazyIsland.tsx'),
          at('src/scene/geo/load.ts'),
          at('src/lib/copy/ns/tabs.ts'),
          at('src/state/gameClock.ts'),
          at('src/lib/supabase/supabaseAuth.ts'),
        ],
        ['zod/mini', 'zod', 'react', 'three', '@supabase/supabase-js', '@supabase/auth-js'],
      ),
    ).toEqual([
      'src/state/store.ts (denied)',
      'src/engine/events.ts (denied)',
      'src/lib/world/places.ts (denied)',
      'src/lib/copy/ns/events.ts (denied)',
      'src/lib/copy/all.ts (denied)',
      'data/copy/events/base.json (denied)',
      'src/components/places/PlaceSheet.tsx (denied)',
      'src/scene/CityCanvas.tsx (denied)',
      'src/scene/geo/schema.ts (denied)',
      'src/state/audioSettings.ts (denied)',
      'src/lib/audio/runtime.ts (denied)',
      'src/lib/copy/ns/audio.ts (denied)',
      'src/components/audio/SoundControl.tsx (denied)',
      'src/state/gameClock.ts (denied)',
      'src/lib/supabase/supabaseAuth.ts (denied)',
      'package zod/mini',
      'package zod',
      'package three',
      'package @supabase/supabase-js',
      'package @supabase/auth-js',
    ])
  })

  it('the import scanner sees static imports only (self-check)', () => {
    const code = [
      "import { a } from './a'",
      "import type { B } from './b'",
      'export type C = { d: string }',
      "import * as z from 'zod/mini'",
      'import {',
      '  e,',
      '  type F,',
      "} from './multi'",
      "import './side-effect'",
      "export { g } from './reexport'",
      "const lazy = () => import('./lazy')",
    ].join('\n')
    expect(staticSpecifiers(code)).toEqual([
      './a',
      'zod/mini',
      './multi',
      './side-effect',
      './reexport',
    ])
  })

  it('a client boundary pulls in everything it imports (self-check)', () => {
    const mount = join(SRC, 'components/places/PlaceSheetMount.tsx')
    expect(isClientModule(readFileSync(mount, 'utf8'))).toBe(true)
    expect([...staticClosure([mount]).files].map(rel)).toContain('src/state/placeSheet.ts')
  })
})
