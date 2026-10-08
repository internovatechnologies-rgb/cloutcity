# Clout City: NYC

**Tap In. Blow Up.** A mobile-first, browser-based, stylised-3D life game set in a shared, live
New York City. Rules for contributors and agents live in `CLAUDE.md`; the build plan is
`docs/spec/PLAN.md` and the task list is `prd.json`.

## Setup

Requirements: Node 24 (Next.js 16.3 needs >= 20.9; the scripts use Node's built-in TypeScript
support) and npm.

```bash
npm ci
npx playwright install chromium   # browser for e2e, once per Playwright version
npm run dev                       # http://localhost:3000
```

No environment variables are needed to play: without Supabase the game runs local-only. Env
files (`.env`, `.env.local`, ...) are gitignored; `.env.example` lists the names.

| Variable                                                    | Used by                                                                                                                          | Default                                                            |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `NEXT_PUBLIC_LOG_LEVEL`                                     | `src/lib/log.ts` minimum level (`debug`, `info`, `warn`, `error`)                                                                | `debug` in dev, `info` in production                               |
| `E2E_PORT`                                                  | Port Playwright serves the production build on                                                                                   | `3100`                                                             |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | The guest's anonymous Supabase session (`src/lib/supabase/env.ts`); inlined at build time                                        | unset: local-only play                                             |
| `E2E_SUPABASE_PORT`                                         | Port of the opt-in `npm run e2e:supabase` build                                                                                  | `3110`                                                             |
| `SUPABASE_SERVICE_ROLE_KEY`                                 | Server only (`src/server/supabase/service.ts`): the `/api/mod/*` routes and cloud saves (POST `/api/save`); never `NEXT_PUBLIC_` | unset: `/mod` and `/api/save` answer 503, saves stay on the device |
| `SUPABASE_URL`                                              | The project URL for the cloud-save server code, if it differs from `NEXT_PUBLIC_SUPABASE_URL`                                    | `NEXT_PUBLIC_SUPABASE_URL`                                         |
| `MODERATOR_EMAILS`                                          | Server only: comma-separated emails allowed into `/mod` (`src/server/moderation/auth.ts`)                                        | unset or empty: nobody                                             |

## Scripts

| Script                            | What it does                                                                                                                                                                                                                 |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run dev` / `build` / `start` | Next.js dev server, production build, production server                                                                                                                                                                      |
| `npm run typecheck`               | `next typegen` then `tsc --noEmit` (strict)                                                                                                                                                                                  |
| `npm run lint`                    | ESLint CLI (flat config): Next core-web-vitals + TypeScript, full jsx-a11y recommended set, `no-console` as an error                                                                                                         |
| `npm run format:check` / `format` | Prettier check / write                                                                                                                                                                                                       |
| `npm test`                        | Vitest unit tests (`*.test.ts` next to the code)                                                                                                                                                                             |
| `npm run test:integration`        | Vitest integration suites in `tests/integration` against local Supabase (see Local Supabase)                                                                                                                                 |
| `npm run db:types`                | Regenerates `src/lib/supabase/database.types.ts` from the local database                                                                                                                                                     |
| `npm run e2e`                     | Playwright specs in `tests/e2e`, against a fresh production build on `E2E_PORT` (Supabase variables blanked: local-only)                                                                                                     |
| `npm run e2e:perf`                | Cold, warm and per-tier render budgets under the `cc-mid-4g` throttle (`tests/perf/*.perf.ts`); medians in `test-results/perf/report.json`                                                                                   |
| `npm run e2e:supabase`            | Only the `*.supabase.spec.ts` specs, against the running local Supabase stack (port 3110, `.next-e2e-supabase`)                                                                                                              |
| `npm run e2e:dpl`                 | Offline support under Vercel Skew Protection: builds with `NEXT_DEPLOYMENT_ID` (so assets carry `?dpl=`) into `.next-e2e-dpl` (port 3111, `E2E_DPL_PORT`) and runs the service worker and offline specs plus `*.dpl.spec.ts` |
| `npm run budget`                  | Gzipped shell JS, 3D chunk, apartment chunk, total JS to playable, base geo, district assets, service worker and precache against `data/config/perf.json`, then the boot-path guard (run after `npm run build`)              |
| `npm run geo:build`               | Downloads the pinned geo sources and rebuilds `data/geo` and `data/zones` (see Geo data)                                                                                                                                     |
| `npm run audio:build`             | Rebuilds `public/audio` and `data/audio/manifest.json` from the pinned CC0 originals (see Audio); `-- --check` verifies                                                                                                      |
| `npm run assets:build`            | Rebuilds `public/models` and `data/assets/` from the pinned CC0 packs (see 3D models); `-- --check --offline` verifies                                                                                                       |
| `npm run blender:build`           | Runs our Blender model scripts headless (Blender 5.2.2) into `scripts/blender/out`; `-- --check` verifies without Blender                                                                                                    |
| `npm run econ:update`             | Re-runs the economy bot and rewrites `data/sim/economy-baseline.derived.json` (see Economy simulation)                                                                                                                       |

Gate order used by the build loop:
`npm run format:check && npm run typecheck && npm run lint && npm test && npm run test:integration && npm run build && npm run e2e && npm run budget`

## End-to-end tests

- Projects: `mobile-390` (390x844, touch, mobile viewport) and `desktop-1280` (1280x720).
- Import `test` and `expect` from `tests/e2e/fixtures/test.ts`, never from `@playwright/test`.
  The fixture fails any test that logs a console warning or error or throws an uncaught page
  error (PERF-1), and provides `checkA11y()`, an axe scan that fails on serious or critical
  violations (A11Y-2).
- A test that provokes a console message on purpose (a failure path) lists it with
  `test.use({ expectedConsole: [...] })`: each entry names the exact console type and the text
  (a string matched exactly, or a RegExp; an object argument such as a `src/lib/log.ts` record is
  also matched as JSON) and optionally an exact `count`. Matching messages are let through, but
  every entry must appear, and anything else still fails. Wrap two or more entries as
  `[[a, b], { scope: 'test' }]` (Playwright reads a bare two-entry array as a fixture tuple).
- The fixture also seeds a completed welcome card before every page load, so specs start like a
  returning player. Welcome-card specs opt out with `test.use({ onboarding: 'fresh' })`; their
  helpers live in `tests/e2e/fixtures/welcome.ts`. To fake the time use `page.clock.setFixedTime`
  only: `page.clock.install()` also fakes animation frames and timers and hangs the console guard.
- Screenshot baselines live in `tests/e2e/__screenshots__/` and are per platform. After an
  intended visual change, review the diff and run `npx playwright test --update-snapshots`.

### Headless WebGL in Playwright

Headless Chromium has no GPU, so WebGL2 runs on SwiftShader, Chromium's CPU implementation
(ANGLE on SwiftShader Vulkan). Chromium has deprecated the _automatic_ SwiftShader fallback for
WebGL, so `playwright.config.ts` opts in explicitly for every project:

```
--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader
```

- `--use-gl=angle --use-angle=swiftshader` makes SwANGLE (ANGLE + SwiftShader Vulkan) the GL
  driver, so every machine and CI runner renders with the same software stack.
- `--enable-unsafe-swiftshader` is the opt-in for WebGL on SwiftShader. Without it, recent
  Chromium logs a deprecation warning (which would trip PERF-1) and will eventually refuse to
  create the context. "Unsafe" refers to running untrusted content; we only load our own app.

Source: [Using Chromium with SwiftShader](https://chromium.googlesource.com/chromium/src/+/main/docs/gpu/swiftshader.md).
`tests/e2e/webgl-smoke.spec.ts` proves the context is created and renders. Its renderer string
(`ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device ...`) is recorded as a test annotation.

SwiftShader logs one ANGLE performance note per composited WebGL frame,
`GL Driver Message (OpenGL, Performance, ...): GPU stall due to ReadPixels`. It comes from the
software compositor, never appears on a hardware GPU, and is the only message the console guard
ignores (matched exactly, with or without ANGLE's final " (this message will no longer repeat)"
suffix, and only at warning level). The guard also keeps listening for
`consoleSettleMs` (default 250 ms, a fixture option) after each test body so late async
warnings still fail the test. Headless FPS is meaningless on SwiftShader: assert bytes, timings,
draw calls and triangles instead.

If the smoke test fails: run `npx playwright install chromium`, check the flags above are still
in `playwright.config.ts`, and compare them with the Chromium doc linked above.

## Layout: the overlay layer system (UX-1)

All UI over the scene goes through `src/components/overlay/OverlayLayout.tsx`. It reserves
named zones as rows of one CSS grid (banner, HUD, free scene area, toast, sheet, tab bar), so
zones cannot overlap; content that does not fit scrolls inside its own zone. The free scene area
never shrinks below `freeSceneMinHeightPx` (room for the map attribution and its 44 px credits
link); on short viewports banner, toast and sheet shrink first. Zone sizes live in
`data/config/layout.json`. The bottom tab bar (`src/components/nav/BottomTabs.tsx`) sits in the
`tabs` zone with safe-area padding.

The HUD (`src/components/hud/HudFrame.tsx`, S05) is two rows of 44 px targets
(`hudHeightPx`), or one row (`hudCompactHeightPx`) on a short, wide screen. The breakpoints
(`hudWideMinWidthPx`, `hudCompactMaxHeightPx`) are repeated in `src/app/globals.css` as the
Tailwind variants `hud-wide` and `hud-short` (`src/app/layout-css.test.ts` keeps them equal), and
the grid lives in `src/components/hud/hudLayout.ts`. The live cells (cash, clock, speed, clout
with the goal line, stats) are a boot island over a skeleton of the same boxes; on phones
Inventory, Rent and the sound settings sit in the More panel. The S04c Places button goes in
`HudFrame`'s `places` prop.

A modal (the welcome card) goes in `OverlayLayout`'s `modal` slot: a second grid on the top
layer that places it between the HUD and the tab bar, never over the banner, HUD or tab bar.
A modal declares itself open with `useModalPresence(open)` (`src/components/overlay/modalState.ts`);
while one is open, the scene and every zone behind it stay mounted but are inert and dimmed, and
focus returns to the scene's `<main>` when it closes.

## Welcome card (18+ check, consent, sound)

On first visit `src/components/welcome/WelcomeGate.tsx` shows one card over the loading map: a
neutral year-of-birth picker (no default, no hint of the threshold), the Terms/Privacy consent
(`/terms`, `/privacy`, placeholders pending legal review) and the sound choice. The rules are pure
in `src/engine/ageGate.ts` (New York year; only a birth year at least `minimumAge + 1` back
passes, since the birthday is unknown); numbers live in `data/config/onboarding.json`.

- **18+:** `src/state/onboarding.ts` stores under `cloutcity:onboarding` the attestation (boolean
  and timestamp), the consent version and timestamp, and the sound choice. The birth year is
  never stored, logged or sent. The guest session hook (`src/state/session.ts`) runs only after
  this; S05 adds the anonymous Supabase sign-in there, then records these answers on the server
  profile with `attest_and_consent` (see Local Supabase).
- **Under 18:** an in-voice screen, and the gate locks on that device for `underAgeLockHours`
  (setting the clock back keeps it locked). No session starts.
- Returning players never see the card. A record from a newer build is respected and never
  overwritten; an invalid one is ignored and the card shows.
- The form follows the shared pattern (`src/lib/forms/`): one zod/mini schema whose messages are
  copy keys, `fieldErrors()` for every error at once, `firstInvalid()` for focus.
- Picking a sound option does nothing audible. Submitting a passing card is the deliberate tap
  that turns sound on (GR-13, see Audio); under-age and invalid submits never do.

## Audio

Four channels (music, sfx, ambience, voice) under a master, each with its own volume
(`src/lib/audio/mixer.ts`, pure; defaults, slider step, ramps and per-tier loading in
`data/config/audio.json`).

- **No sound before the choice (GR-13).** The only `AudioContext` is created in
  `src/lib/audio/unlock.ts`, synchronously inside the welcome card's submit or a tap on the HUD
  sound control or the sound settings. Returning players hear nothing until they tap "Tap for
  sound". No other gesture, and no document-level listener, ever starts audio.
- **Mixing with the player's music app.** Before the context exists, Safari's
  `navigator.audioSession.type` is set to `'ambient'` (mixes with other audio; the silent switch
  mutes it). Everything plays through AudioBuffers: no `<audio>`/`<video>` elements and no
  `navigator.mediaSession`, so Android Chrome takes no audio focus and our sounds never take
  over lock-screen controls.
- **"My own music"** is the welcome card's sound choice in the onboarding store
  (`audioChoice: 'own'`), changed only through `src/lib/audio/controls.ts` (the HUD toggle and
  the settings checkbox). It mutes our music only and skips fetching it; sfx and ambience keep
  playing. Volumes persist under `cloutcity:audio` (`src/state/audioSettings.ts`; S18c syncs
  them, newest `updatedAt` wins). `src/lib/audio/no-override.test.ts` enforces all of this.
- **Lazy.** The runtime (`src/lib/audio/runtime.ts`: graph, music rotation with crossfades,
  ambience loop, sfx) loads with a plain `import()` after the tap and once the map is playable
  (`src/state/mapPlayable.ts`). `playSfx(id)` from `src/lib/audio/sfx.ts` is safe to call any
  time (ids `ui-tap`, `purchase`, `clout-up`). The HUD sound control, with the zod-backed
  audio settings and onboarding stores, is a boot island (`SoundControlMount`, eager); the
  settings sheet is a feature island in the sheet zone, loaded on the first gear tap
  (`SoundSheetMount`). Neither is in the shell, and neither is the audio copy (`audio.*`, a
  feature namespace in `data/copy/audio/`).
- **Recovery.** Music start/stop is a generation-keyed state machine: the latest "My own music"
  choice always wins, however fast it is toggled. If no music file loads, or the runtime chunk
  does not arrive (offline), the sound control says "… · Tap to retry" and a tap retries. A
  closed AudioContext is replaced by a fresh one on the next tap.
- **Assets.** CC0 only, self-hosted, listed in `data/audio/SOURCES.md`. `npm run audio:build`
  (needs ffmpeg) downloads the originals pinned in `scripts/audio/sources.json` into
  `.cache/audio/` (sha256-checked), then excerpts, loudness-normalises, bakes loop crossfades and
  encodes Opus/WebM plus AAC/.m4a into `public/audio/`, writing `data/audio/manifest.json`. The
  build is deterministic; `npm run audio:build -- --check` (offline, no ffmpeg) verifies the
  committed files, the manifest and SOURCES.md agree. To add a sound: pin it in
  `sources.json`, add its row to SOURCES.md (and a `audio.track.*` "Title by Artist" copy key
  for music), then rebuild.
- **e2e hook.** Test builds (`NEXT_PUBLIC_TEST_HOOKS=1`, built into `.next-e2e`) load
  `src/lib/audio/testHook.ts` from the runtime and expose `window.__cloutcityTest.audio`
  (context state, live and target gains, what is playing, sfx count);
  `tests/e2e/fixtures/audio.ts` wraps it with the audio probe. Production builds drop it
  (`scripts/shell-guard.ts` checks).

## 3D models

Hand-made low-poly models (S04h, DEC-24/25/26) come only from free CC0 packs pinned by commit or
by zip sha256 (KayKit City Builder, Furniture and Restaurant Bits; Kenney Mini Characters,
Furniture Kit, City Kit Commercial and Nature Kit) and from our own Blender scripts.

- **Catalog.** `data/assets/catalog.json` lists the packs (licence, licence-file phrases, pin,
  colour grade) and the models (entries, category, real-world fit, pivot, per-tier
  simplification, palette swatches and anchors (`remap`, with an optional tight
  `remapMaxDeltaE` to pin one exact pack colour), night-glow tokens, recolour slots, rig clips,
  load phase, copy name key). The schema allows only CC0/MIT packs and project-original Blender
  sources.
- **Build.** `npm run assets:build` downloads into `.cache/assets/` (sha256-checked against
  `scripts/assets/sources.lock.json`; `-- --update` re-pins, e.g. when a Kenney zip URL moves)
  and reads zips in memory. Per model it bakes the texture atlas and material colours into
  vertex colours (no textures ship), grades and snaps them to the real-world `models` tokens in
  `data/config/theme.json`, writes `_EMISSIVE` (linear RGB night glow) and `_SLOT` (recolour
  region) attributes, merges static models into one mesh, fits real-world size, simplifies per
  tier, quantizes and compresses with meshopt (vertex codec v0, which three r182's bundled
  decoder reads). Outputs: `public/models/<id>.<tier>.<sha8>.glb`, `data/assets/manifest.json`
  (with `assetVersion`), the lock and `data/assets/SOURCES.md`. It fails when a model breaks
  its per-category cap in `data/config/perf.json` `models` and prints the pressure; it never
  edits perf.json. `-- --check --offline` rebuilds byte-identically from the cache.
- **Blender.** `npm run blender:build` runs each model script listed in
  `scripts/blender/lock.json` through `scripts/blender/run.py` with the pinned Blender
  (`--background --factory-startup --python-exit-code 1`, `PYTHONHASHSEED=0`; override the
  executable with `BLENDER_BIN`) and commits the GLBs to `scripts/blender/out/`; the asset build
  reads them as a `local` source and checks their hashes, so CI never needs Blender.
- **To add a model:** add it to the catalog (and its `models.name.*` copy key in
  `data/copy/models/base.json`), run `npm run assets:build -- --update` once, then
  `npm run assets:build`, and check the printed colour report and cap pressure.
- **Runtime** (`src/scene/models`). Models load only in lazy chunks, through three's own
  `GLTFLoader` with its bundled `MeshoptDecoder` (never drei's `useGLTF`). A page-wide cache
  holds each decoded file while any component uses it and keeps up to
  `scene.json models.cacheMaxEntries` idle ones (least recently used are disposed). Every model
  draws with one shared material per canvas (`models.shading`: lit = Standard on mid/high,
  Lambert on low; or toon) and its baked vertex colours. `ModelInstances` draws every placement
  of a static model as one InstancedMesh; `_SLOT` recolours make one colour-buffer variant.
  `AvatarModel` binds a head and a body to one skeleton and poses them with the rig's clips; it
  holds a continuous frame lease only while `animate` is true, so an idle map still draws zero
  frames. Night glow uses the S04f contract: the shared material is patched with
  `patchNightGlow(material, 'attribute', …)`, so each `_EMISSIVE` vertex glows at
  `models.emissive.nightIntensity × uNightGlow` (the day/night rig writes `uNightGlow`;
  `dayIntensity` stays 0). The showcase sets `uNightGlow` from its own time-of-day preset.
- **Player avatar** (S05). The capsule placeholder shows at once; the hand-made avatar
  (`scene.json models.player`) starts loading after the city has drawn and replaces it. The
  capsule stays while loading, on failure, below `minDeviceMemoryGB` and on `capsuleTiers`.
- **Apartment decor** (S16). Items mapped in `scene.json models.decor` (item → model and the slot
  its colour variant recolours) draw with their hand-made model once `src/scene/apartment/
decorModels.ts` (its own lazy chunk) has loaded them at the active tier; the rest, and every
  item until then or if loading fails, keep the code-built stand-ins. The room shell stays
  code-built (each home's window and door positions come from data).
- **Tiers.** Models follow the active quality tier (`useActiveTier`): the map avatar, the
  apartment decor and the shared material (Lambert on low) switch with a runtime step-down.
- **Service worker.** `public/models/**` is never precached (only on-demand); a unit test guards
  the precache inputs.
- **Showcase** (`/dev/models`, test builds only: `NEXT_PUBLIC_TEST_HOOKS=1`, otherwise 404).
  Review scenes from `data/assets/showcase.json`: `?view=avatars|street|room|catalog`,
  `&time=day|golden|night`, `&tier=low|mid|high`, `&chrome=0` for clean screenshots;
  `window.__cloutcityTest.showcase.ready` turns true once every model has drawn.
- **Budget.** `npm run budget` prints model bytes per tier and load phase from the manifest,
  fails if the playable-path models alone break `totalBytesToPlayableGzKB`, and fails if the
  glTF loader reaches the shell JS. Model credits are on /credits.

## Data, copy and config

Everything players see or the game tunes lives in `/data` as JSON, and every file is validated
by a zod schema in `src/lib/data/schemas/` (`src/lib/data/data.test.ts` fails if a `.json`/`.geojson` file has
no schema or does not match it, if any other file type appears (only `SOURCES.md` and
`README.md` are allowed next to data), or if a cross-file reference breaks).

| Folder            | Holds                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `data/config/`    | `perf.json` (every performance budget), `theme.json` (palette), `realtime.json`, `moderation.json`, `balance.json` (balance anchors), `progression.json` (goals, grant caps, prestige rules), `sync.json` (cloud save timings, size limits and plausibility margin), `layout.json`, `copy.json`, `geo.json` (geo build parameters), `scene.json` (3D scene camera, layer and line settings, the apartment's room, markers and picking) |
| `data/copy/`      | one directory per namespace: `<ns>/base.json` (plain strings) and `<ns>/<pack>.json` (slang-pack overrides); `superlatives.json`                                                                                                                                                                                                                                                                                                       |
| `data/items/` ... | `items`, `premium`, `events`, `jobs`, `venues`, `landmarks`, `boroughs`: content, with copy keys instead of text (`venues`, `landmarks` and `boroughs` are real since S07; the rest are placeholder seeds until their tasks land)                                                                                                                                                                                                      |
| `data/geo/`       | `bounds.json` (NYC extent) and the layers `npm run geo:build` writes: `land`, `water`, `parks`, `subway`, `blocks.<tier>`, `districts/<district>.<tier>` (`*.derived.json`), `manifest.derived.json`, `SOURCES.md`                                                                                                                                                                                                                     |
| `data/zones/`     | play zones (one per 2020 CDTA, grouping NTAs): `zones.derived.json` (metadata) and `zone-shapes.derived.json`                                                                                                                                                                                                                                                                                                                          |
| `data/audio/`     | `manifest.json` (CC0 tracks only)                                                                                                                                                                                                                                                                                                                                                                                                      |
| `data/sim/`       | `economy-baseline.derived.json`, written by the economy simulation (`npm run econ:update`)                                                                                                                                                                                                                                                                                                                                             |

- **Handles.** `data/config/handles.json` (handle rules, change and rate limits),
  `data/copy/handleWords.json` (guest-handle words) and `data/moderation/handle-blocklist.json`
  (the handle filter's terms, with `SOURCES.md`) are server data: the database gets them through
  the migration's generated seed, and the blocklist is never imported by browser code.
- **Loading.** Server code and scripts import validated data from `src/lib/data/config.ts` and
  `src/lib/data/content.ts`, which parse at import and fail fast with the file name. Client
  code must not pull in zod's classic build (it costs about 90 KB gz of shell JS): the copy
  layer reads its JSON directly (validated by the tests), and the stores validate with
  `zod/mini`. Import it as `import * as z from 'zod/mini'`: the named `{ z }` export defeats
  Turbopack's tree shaking and ships all of zod/mini with its locales (about 92 KB gz).
- **Adding content.** Add the entry to the JSON file, add its strings to its namespace's
  `data/copy/<ns>/base.json` (events in `events`, items in `items`, ...) under the key the entry names (`nameKey`, `titleKey`, ...), and run `npm test`. An item's
  `sellValue` must equal `floor(price * resalePct[rarity] / 100)` (`items-data.test.ts`).
- **Copy.** `copy(key, vars)` from `src/lib/copy` renders a string with the active slang pack
  (`data/config/copy.json` → `slangPack`, one of `packs`) layered over base. Swapping the pack id
  changes the text with no code change. Strings are split by namespace, the first key segment
  (`events.mtaDelay.title` → `events`), so the shell ships only the boot namespaces (`app`,
  `nav`, `tabs`, `loading`) and every other namespace ships with the feature that renders it
  (DEC-11):
  - A module that renders a namespace imports `@/lib/copy/ns/<ns>` (after its other imports).
    Rendering a key whose namespace is not loaded throws `CopyNamespaceNotLoadedError`, never the
    raw key; `src/lib/copy/key-usage.test.ts` fails if a module names a key its imports do not load.
  - **New namespace:** create `data/copy/<ns>/base.json` (`{ "strings": { "<ns>.…": "…" } }`), add
    `src/lib/copy/ns/<ns>.ts` (copy an existing one: it imports the files and calls
    `registerCopy`), add it to `src/lib/copy/keys.ts` (the `CopyKey` type) and `all.ts`.
    `src/lib/copy/files.test.ts` checks all of this against the disk.
  - **Pack overrides:** `data/copy/<ns>/<pack>.json` (`{ "id": "<pack>", "strings": {…} }`) for
    a pack listed in `copy.json`, registered in the namespace module. A **new pack** is a new id
    in `packs` plus a file in each namespace it overrides.
  - Only the core may add a boot namespace (it costs shell bytes; `npm run budget` and
    `src/lib/shell-boundary.test.ts` enforce the boot path). Tests and server code that need every
    string import `src/lib/copy/all.ts`.
    Templates
    use `{name}` placeholders (a letter, then letters or digits) whose values are strings, so
    numbers go through the formatters first. Any other brace is rejected by the schema and by
    `interpolate`.
    Packs may override only base keys and must keep the same placeholders.
- **Superlatives (GR-11).** No copy string may contain "cheapest", "biggest", "best", "most" or
  "fastest" as literal text (`src/lib/copy/copy.test.ts`). Give the string a placeholder and fill it
  with `superlative(kind, subjectId, values)`, which returns the word only when the data proves
  it (a unique minimum or maximum) and `null` otherwise.
- **Numbers (UX-2).** `formatMoney` (whole US dollars, halves rounded away from zero) and
  `formatCount` (rounded to a whole count, then `Intl.NumberFormat` compact; never `-0`) in
  `src/lib/format.ts`. Anywhere else under `src/`, ESLint rejects any reference to `Intl`,
  the `toLocale*String` / `toFixed` / `toPrecision` methods however they are reached, and
  hand-built dollar amounts (`` `$${x}` ``, `'$' + x`, `$` before a JSX expression).
- **Theme.** `data/config/theme.json` holds the palettes (DEC-26 real-world colours): `colors`
  (the DOM palette: interface colours and item swatch colours), `ui` (the interface's semantic
  colours for `day` and `night`, the cross-fade and the glass settings), `themeColor`, `world`
  (3D-only colours: land, haze, subway ribbons, room surfaces, keyframe skies), `sky` (each
  day/night keyframe's colour slots), `scene` (the city's colour roles, as `world` or `models`
  tokens) and `models` (the hand-made models' materials). `scene.buildings.walls` and `.blocks` are
  lists: each district mass and each low block picks one by a deterministic noise, so a district
  mixes brick, brownstone, limestone, concrete and glass (repeat a token to weight it).
- **Interface theme (S04g).** Light frosted cards by day, dark glass by night, taxi yellow the one
  accent. The stock Tailwind palette is removed (`--color-*: initial` in `src/app/globals.css`):
  components use only the semantic colours `canvas`, `glass` (the `glass` utility), `surface`,
  `raised`, `pressed`, `track`, `scrim`, `line`, `line-strong`, `fg`, `muted`, `taxi`, `on-taxi`,
  `taxi-ink` (accent-coloured text), `danger`, `success`, `focus` and `meter`. The root layout
  writes both themes as `--ui-day-*` / `--ui-night-*` on `<html data-theme="day">`; the HUD island
  (`src/components/hud/ThemeSync.ts`) switches `data-theme` on the scene's keyframes, cross-fades
  over `ui.crossFadeMs` (instant under reduced motion), updates `<meta name="theme-color">`, and
  sets `data-glass="blur"` only on mid/high tiers without data saver or reduced transparency
  (PERF-2). Legal pages and credits show the last theme the game stored. `src/lib/theme.test.ts`
  keeps the CSS in sync with theme.json, `theme.contrast.test.ts` checks WCAG 2.2 AA for both
  palettes, and `theme.palette-ban.test.ts` fails any raw palette class in the DOM UI.
- **Day and night (S04f).** The city's light follows the personal game clock: `scene.json`
  `dayNight` holds six keyframes (dawn, morning, day, golden, dusk, night) with their minute, hold,
  sun pose and intensities, the fog and the room scales; their colours are `theme.json` `sky`.
  `src/lib/dayNight` blends them (pure; smoothstep in linear light, quantised to
  `quantizeMinutes`, stepped under reduced motion). The HUD island writes the minute of day to
  `src/state/dayClock.ts`; in the 3D chunk `src/scene/lighting/DayNightRig.tsx` owns the
  background, fog, hemisphere, ambient and sun (all mounted from the first frame, so no shader
  recompiles with the time), redraws only when the lighting key changes, and writes the shared
  `uNightGlow` uniform that lit windows, landmark windows, pins and model emissive read
  (`src/scene/lighting/nightGlow.ts`; memorials never glow). `perf.json` `programsMax` caps the
  shader programs per tier.

## Places: boroughs, venues and landmarks

Venues (invented businesses) and landmarks (real places) share one id space. The client reads
them through `src/lib/world/places.ts` (`mapPlaces()`, `placeAccess()`,
`placeAccessibleName()`, `boroughRenderState()`); the rules are in `src/engine/boroughs.ts`
(clout gating from `balance.json` `boroughs`) and `src/engine/places.ts` (opening hours,
`placeAllows`).

- **Ids are stable.** Events and travel reference places by id, so never rename one; add a new
  entry instead. Ids are kebab-case and brand-free.
- **Fields you fill by hand:** `id`, copy keys (`venues.<camelId>.name` / `.blurb`,
  `landmarks.<camelId>.name` / `.info`), `type` or `category`, `location` (lat/lng), `borough`,
  `zoneId`, `hours` (venues), `stationId` (station venues), `approach` and `spans` (bridges and
  off-land landmarks), `interactions` (landmarks). Local x/y are computed with `project()` at
  load, never stored.
- **Fields the tests check:** `src/lib/world/places-content.test.ts` checks `borough` and
  `zoneId` against the S04 borough and zone layers at `approach ?? location` (the failure
  prints the expected value), that venues are not inside parks and are 50 m apart, that a
  station venue is within 25 m of its station, and that landmarks off land have an `approach`.
- **nameMode.** A landmark is `generic` when its real name contains a corporate or sponsor brand
  or its owner licenses the name or image as commercial IP; civic, park and place names stay
  `real`. Add the real name to `LANDMARK_REAL_NAMES` in the test. Every landmark ships with
  `legalReviewed: false`. Memorials are `lookOnly: true` with no `interactions`, plain base copy
  only, and no slang-pack override.
- **SOURCES entry.** A landmark needs a row in `data/landmarks/SOURCES.md` (Wikidata id and
  coordinates, nameMode reasoning). A venue needs a row in `data/venues/SOURCES.md` with the web
  search for its name; a name that matches a real NYC business is rejected (add the business to
  `REAL_NYC_BUSINESSES`).
- **Copy.** Place and borough copy may not use a superlative (the extended list in the test)
  unless it is computed into a `{rank}` placeholder by `superlative()`.

## Game state

`src/state/store.ts` is the Zustand store (`useGameStore(selector)`), persisted to localStorage
under `cloutcity:game` with a schema `version` and a `migrate` step. Loaded state is validated:
out-of-range fields are repaired (speed to 1x, remainder to 0, stats clamped and rounded) and
only a structurally unusable save is replaced by a fresh state. A save from a newer build is
never overwritten: the store sets `newerSavePresent` and writes nothing until
`discardNewerSaveAndStartFresh()` is called. Only meaningful changes (minute, cash, stats,
speed, event state, goals, grants, prestige) are written, not every tick. If localStorage is unavailable (private
browsing, blocked site data, full quota) the store keeps working in memory for the session.

The store holds an engine snapshot and calls the engine for every change (`tick`,
`performAction`, `setSpeed`); it holds no game rules itself.

- **Engine** (`src/engine/`): pure functions, no React, three, Supabase or store imports, and
  no real clock or `Math.random` (ESLint enforces it; `src/engine/purity.test.ts` proves it).
  Randomness comes from the seeded generator in `rng.ts` (mulberry32), whose state the save
  keeps. Every number comes from `data/config/balance.json` (`time`, `stats`, `actions`,
  `events`).
- **Two clocks.** The personal game clock (`clock.ts`) is whole game minutes since day 1, 00:00.
  Passive time runs at 10 game minutes per real minute while the tab is visible, at 1x or 2x;
  actions fast-forward it instantly by their duration. City time (`cityTime.ts`) is the real
  New York wall clock for an instant the caller passes in. `src/state/clockDriver.ts` is the
  only code that reads real time for the personal clock, and it pauses while the tab is hidden.
- **Stats** (`stats.ts`): energy, hunger (fullness) and mood, 0-100, decay at each game hour;
  a stat at 0 drains the others faster and/or slows actions (`stats.atZero`).
- **Actions** (`actions.ts`): validated definitions with a duration, cash and energy cost and
  stat effects; failures return a typed error (`INSUFFICIENT_FUNDS`, `INSUFFICIENT_ENERGY`, ...)
  and change nothing.
- **Items** (`items.ts`, catalog in `data/items/items.json`): `buyItem`, `sellItem`,
  `equipItem`, `unequipSlot` and `consumeGift`, with typed errors (`INSUFFICIENT_FUNDS`,
  `ALREADY_OWNED`, `NOT_OWNED`, `WRONG_SLOT`, ...). Wearables are owned once and worn one per
  slot (top, bottom, shoes, accessory, face); gifts stack and are consumed on yourself or an
  NPC (`{ npcId }` with an `npc-` id), never another player. Resale is `sellValue` (data,
  `floor(price * resalePct[rarity] / 100)`), less `depreciationPctPerGameDay` per game day
  owned for wearables and decor, never below `minResalePct` (`balance.json` `items`). Decor is
  owned once and sells back out of its slot; selling a wearable or decor kept through prestige
  is refused (`PRESTIGE_KEPT`).
- **Apartment** (`home.ts`, slots in `data/homes/interiors.json`, numbers in `balance.json`
  `home`): decor (`category: "decor"` with a `decor` block: `fits` wall, floor or surface,
  `homeScore`, and at least two colour `variants`, each a palette token and a `colors.*` copy
  name) is placed in a slot of its kind in the current home (`placeDecor`, `removeDecor`,
  `setDecorVariant`). Home score is the home's `baseScore` plus placed decor's `homeScore`; home
  clout is that score capped at `maxClout` and counts toward total, goal and level clout.
  `moveHome` is instant and refused, in order, for the current home, a home in a borough the
  level has not opened (`HOME_BOROUGHS` in `src/lib/data/homes.ts`) and a move the player cannot
  afford (`canAffordMove`); it pays the move-in cost, keeps decor in slots the new home shares and
  logs the move (`apartment.moveLog`). To add decor: add the item with its `decor` block to
  `items.json` (cloutValue and styleValue 0, no stat effects), its name and description to
  `data/copy/items/`, any new colour name to `data/copy/colors/`, a low-poly model to
  `src/scene/apartment/buildDecor.ts` (one merged geometry, at most two material groups), and run
  `npm test`. The Home panel (`src/components/hud/HomePanel.tsx`) places, recolours and moves
  through a slot list (the keyboard path); the 3D room (`src/scene/apartment/`) mirrors it and
  places by tapping a slot. While the room shows, the city draws nothing (`src/state/sceneFocus.ts`).
- **Events** (`events.ts`, data in `data/events/events.json`): each event lists conditions
  (personal-clock `hours`, `minDay`, `boroughs`, `locationIds`/`locationCategories`, `stats`,
  `cash`, `clout`, `items`), a `weight`, an optional `cooldownMin` or `once`, and two or three
  choices whose `effects` are `cash`, `stat`, `time`, `clout` or `item`. Cash, stats and time
  apply at once; clout and items are kept as typed pending effects (with their source) in the
  save (v5) until the clout ledger (S13) and inventory (S10) consume them. `rollForEvent(context)` in the store rolls with
  `events.rollChance`; the open event shows in `src/components/events/EventSheet.tsx`, loaded
  on first use by `EventSheetHost.tsx`, a boot island that `EventSheetMount.tsx` starts loading
  when the shell runs (DEC-11; the overlay sheet zone, modal). The engine refuses every event at a memorial and every crime
  event at a government building whatever the data says. To add an event: add it to
  `events.json` with `titleKey`, `bodyKey` and per-choice `labelKey`/`resultKey`, add the
  plain strings to `data/copy/events/base.json` and the NYC voice to `data/copy/events/nyc.json`, and
  run `npm test` (`src/lib/data/events.test.ts` checks keys, places, items and scans the copy
  for drinking, drug, sexual, gambling and strong-profanity words; a human still reads it).
  In builds with test hooks (`NEXT_PUBLIC_TEST_HOOKS=1`, the e2e build only), set
  `window.__CLOUTCITY_E2E__ = true` before load to get `window.__cloutcityTest.events`
  (`open(id, context)`, `state()`); production builds contain no hook code.
- **Housing** (`housing.ts`): `canAffordMove(player, home)` is true when cash, less the rent
  reserve (`rentReserve`: rent owed plus this week's rent for the current home), covers the
  home's move-in cost (`balance.json` `housing.moveInCost`; the lowest-rent home has none).
- **Goals, grants and prestige** (`goals.ts`, `grants.ts`, `prestige.ts`, rules in
  `data/config/progression.json`): goals are facts read from the save (first paycheck, outfit,
  landmark visit, club night, one per clout level; first friend is coming soon), recorded by
  `syncGoals` after every state-changing store action. Level goals read goal clout (earned minus
  granted, plus items and home, never premium), so granted value never counts toward a goal (ECON-1).
  Icon is earned: every clout level reads total clout except Icon (the victory goal's level),
  which also needs goal clout at its threshold, so the Icon level-up and the victory screen land
  together and grants or premium clout never reach Icon (`levelClout` in `clout.ts`).
  Every reward goes through `grant()`: the engine builds the key (`goal:<id>:r<run>`), a repeat
  replays the original record, every grant is logged (`grants.log`, local until S18c
  re-validates it with `toServerGrantRow`), and amounts are capped at a percentage of the gap to
  the next level (clout) and the next home (cash). Reaching Icon shows the victory screen
  (`src/components/goals/IconMoment.tsx`); prestige grants the run's badge and resets the parts
  listed in `prestige.resets`. To add a goal: add it to `progression.json` (a fact from
  `src/lib/data/goalFacts.ts`), add `goals.goal.<camelId>.name` and `.hint` to
  `data/copy/goals/base.json`, and run `npm test`.
- **Saves** (`save.ts`): bump `SAVE_VERSION` and add a step to `migrateSave`, with a test, on any
  breaking change to the saved shape.
- **Save plausibility** (`plausibility.ts`, S18c): `checkUpload(prev, next, context, ceilings)`
  checks an uploaded save against the last accepted one and returns accept, repair (forged goals,
  badges, peak level, un-marked kept looks, unentitled premium clout are fixed with
  `applyRepairs`) or reject (structural damage, forged or replayed grants, anything that went
  back, clout or cash beyond the ceilings), plus the public view (level capped by account age,
  career path (null until S16a), worn cosmetics and entitled premium items) and the grant
  records to insert. Ceilings come from `plausibilityCeilings`: max(economy fixture × `sync.json`
  margin, theoretical ceilings from config). Real time bounds the taps the save counts
  (`SaveState.actions`, v9) and passive clock time (each tap moves the clock at most
  `maxActionGameMinutes`, derived from config: the longest action at the worst stat penalties);
  earnings must fit the counted taps at a per-tap bound derived from config, with no margin
  (H-1R): cash per tap is the most cash any single counted action can pay (the best shift wage
  the level the save reached unlocks, or the biggest event cash; sales and decor resale go
  through the trade path, so they are not counted twice), clout per tap the most clout any
  single rated action can give (viral flex at the top multiplier, club night, event). Today that
  is $72 a tap below Local, $140 from Local on (junior dev) and 60 clout a tap. The bots' measured
  pace (`pace` in the economy baseline) and the cadence sweep are regression guards that must
  stay below this bound. Earnings also get a pace credit of one game day. The public level an account's age allows is a
  separate display pace, `sync.plausibility.publicCloutPerRealMinute` (80: a public Icon takes at
  least an hour); a public level behind the save's is a delay, never a refusal. The real-time
  slack and the pace credit are per-player token buckets the server carries between uploads, and
  each history row keeps them (DEC-19). Only an account with no save at all uploads under
  first-upload rules (never rejected for real-time reasons).
- **Cloud save sync** (S18c): once the guest session connects, `src/state/cloudSync.ts` (lazy)
  restores the account's save or uploads this device's to POST `/api/save`
  (`src/server/saves/handleUpload.ts`, Node, never cached), debounced (`sync.json`), queued
  offline, flushed with a keepalive request when the tab hides, and paused when the server
  refuses a save. The server stores accepted saves with `commit_save` (service role only: a
  compare-and-swap on the revision, the upload rate limit, grant rows, the public profile
  projection) and keeps refused ones aside with `quarantine_save`. The HUD's cloud chip (the More
  panel on phones) shows the status; a conflict asks the player which save to keep. Keeping this
  device's game is checked against the save both devices last shared (`save_at_revision` from the
  history, with the credits it was stored with), not the other device's. If the history no longer
  keeps that save, the kept game is checked from that revision's taps and clock minute, against the
  time it was accepted and its credits, which a small untrimmed revision ledger keeps
  (`private.save_revisions`, the newest `sync.revisionLedgerKeep` revisions per player, 5000 by
  default, oldest pruned), while the kept game is in that revision's run and prestige; a revision
  the ledger does not know (0: never synced), a ledger row without baselines, or a kept game in
  another run is measured as a whole run from the account's creation with the current credits,
  lenient by design (overrides are rate limited, earnings capped by the credit).
  Either way the account's prestige and run must not be newer. A kept game from before
  the account's last prestige cannot replace it (409 `branch-behind`; the panel offers the
  account's game). Grant keys on the server stop a kept game from claiming a reward again.
  Overrides are limited to `sync.plausibility.overrideMaxPerHour` an hour. After a refused save the panel offers the cloud game. Server code
  lives in `src/server/` behind `import 'server-only'`; `src/server/server-boundary.test.ts`
  proves browser code never reaches it.

## Economy simulation

`src/engine/sim/economyBot.ts` plays the solo game for 30 game days on each entry job (barista,
retail, delivery) with a fixed routine: two shifts a day, two subway rides, meals when hungry,
deli coffee before a shift when energy is short, sleep at 22:00. It uses the engine's public
functions only. `src/engine/sim/economy.sim.test.ts` checks the result against the CLAUDE.md
target feel: the job that ends with the most cash finishes between $800 and $1250, saves $115 to
$185 in each of weeks 2 to 4, and can afford the move to the Brooklyn 1BR between the game days
in `balance.json` `target.firstUpgradeGameDay`; no job goes broke, misses rent or misses a
shift, and every job saves $80 to $230 a week.

Two clout routines play alongside: a barista who flexes once a day (S13), and a max-clout routine
(S18c) that flexes up to `clout.flex.maxPerGameDay` times a day at the best-multiplier places it
can reach, buys and wears wearables for style when it can spare the cash, and takes the best club
night its clout lets it into. For the honest pace every job runs with the plain and the max-clout
routine, and with their lean versions (skip meals: a shift whenever the engine allows one, else
sleep; the fewest taps per dollar); junior dev is taken the morning the player's level unlocks it
(barista until then).

The test also writes the result to `data/sim/economy-baseline.derived.json` (per-job results
and the highest cash, clout and action counts per action, game hour and game day, plus the
honest pace: the highest cash and clout per tap of every job and routine, over the whole run or
its best week; S18c uses the per-action and per-hour figures as save-plausibility ceilings and
checks that the measured pace stays below the config-derived per-tap bound) and fails if a later change to the balance moves
it. After
tuning `balance.json` on purpose, run `npm run econ:update`, check the target tests still pass,
and log the change in the progress.md Tuning log.

## Logging

Use `src/lib/log.ts` (`log.info(msg, context)`, `log.withCorrelationId(id)`). It writes
structured records with a level, timestamp and correlation id. It redacts sensitive keys
(email, token, password, chat, message, note) and scrubs email addresses (plain or `%40`-encoded),
`Bearer` tokens, JWTs and the values of sensitive URL query/fragment parameters from every
string value and from the message itself. Dates become ISO strings, Maps
objects and Sets arrays. `console.*` is a lint error everywhere else.

## Geo data

`npm run geo:build` (`scripts/geo/build.ts`) downloads the sources pinned in
`scripts/geo/sources.lock.json` (DCP borough boundaries clipped to shoreline and 2020 NTAs, MTA
subway static GTFS, MapPLUTO density statistics per community district, and NYC OTI building
footprints for each district in `geo.json` `districts`, paged and hashed page by page) into
`.cache/geo/`, then writes simplified, integer-metre layers to `data/geo` and `data/zones`. District
building masses go to `data/geo/districts/<district>.<tier>.derived.json` and the procedural low
blocks elsewhere to `data/geo/blocks.<tier>.derived.json`; the build fails if a tier's total
exceeds `perf.json` `districtBuildingsGzKB` or `buildingTrianglesMax`. The same build derives the
landmark frames (`data/landmarks/frames.derived.json`, from DCP LION street centerlines) first,
and drops every footprint whose centroid lies in a landmark's `landmarks[].exclusion` rectangle
and every block that would touch one.
The output is deterministic: `npm run geo:build -- --check` rebuilds
in memory and fails if a committed file differs, and `npm test` rebuilds from the cache when it
is present. `--update` accepts changed upstream files and rewrites the lock; `--offline` never
touches the network. Parameters live in `data/config/geo.json`; sources, terms, transformations
and attribution text are in `data/geo/SOURCES.md` (generated). All coordinates use the one
projection in `src/lib/geo/projection.ts` (lat/lng to local metres, fixed origin), shared by the
build, the scene and the engine; `src/lib/data/geo.ts` loads the layers for server code and tests.

## Performance budget

`data/config/perf.json` holds every budget from `CLAUDE.md`, per tier where tiered, plus the
`cc-mid-4g` throttle profile, the per-tier render settings (shadow map size, antialias, outlines,
building density, LOD distance scale; no postprocessing), the tier picker thresholds, the FPS
step-down rule and the `e2e:perf` run settings (`perfRun`). `npm run budget` (after
`npm run build`, KB = 1000 bytes) checks:

- `shellJsGzKB`: the gzipped size of every script the prerendered `/` makes a modern browser run
  (Next.js chunks plus inline scripts; `nomodule` polyfills excluded);
- `sceneChunkJsGzKB`: the lazy 3D chunk, i.e. the files Turbopack's loader in the shell fetches
  for the scene's `next/dynamic` import (minus any file the shell already loads). The import is
  found by the scene's `cc-feature:city-scene` marker and must match its entry in
  `.next/server/app/page/react-loadable-manifest.json`; the build must hold exactly one copy of
  three (its `REVISION`), inside this chunk. The apartment's import is left out: it loads when the
  Home panel opens, not before the map is playable;
- `apartmentChunkJsGzKB` (S16): what only the apartment's `next/dynamic` import adds (the manifest
  entry whose code renders `cc-feature:apartment-scene`, minus the city's 3D chunk and the shell);
  the script fails if no lazy entry, or more than one, renders that marker. The import sits in the
  shell's `src/scene/apartment/ApartmentMount.tsx`: nested in a lazy island's chunk, Turbopack
  lists it under a chunk it never writes;
- `totalJsToPlayableGzKB`: the shell, the boot islands (`BOOT_ISLAND_FEATURES` in
  `scripts/budget.ts`, checked against the `eager: true` islands in `src` by its test) and the 3D
  chunk, each file once;
- `baseGeoGzKB`: the prerendered `/geo/base` body (`.next/server/app/geo/base.body`);
- `districtBuildingsGzKB`: per tier, every prerendered `/geo/districts/<tier>/<id>` body plus
  `/geo/blocks/<tier>`, once the build has those routes (S04d; until then the line says SKIP);
- `serviceWorkerGzKB` and `precacheGzKB` (S04e): the service worker script and everything it
  precaches. The precache must also hold every file of the path to playable and the versioned
  base geo, and never `/models`, `/audio`, `.glb`, source maps or `/api`, `/mod`, `/serwist`,
  `/og`; with district routes built, the worker must carry each tier's warm list.

`node scripts/budget.ts --perf=<file>` reads the limits from another file instead of
`perf.json`: a positive control on a real build (copy perf.json, lower one limit below the
measured size, and the run must print FAIL and exit 1). Never edit perf.json for that.

It also prints a PERF-3 report line (modules Turbopack copies into more than one chunk); that line
never fails the run. Every lookup fails loudly when it finds nothing, so a change in the build
format cannot turn a check into a silent pass.

Draw calls, triangles and idle frames at the default view are asserted by
`tests/e2e/city-scene.spec.ts`, and per tier by `npm run e2e:perf`; the apartment's per-tier caps
(`perf.json` `apartment`, with `avatarReserve` kept free for the S16a avatar, shadow pass
included) by `tests/e2e/home-apartment.spec.ts`. Audio has its own budgets
(`audioLazyGzKB` per tier for the first music track, the ambience and the tier's preloaded sfx,
per encoding; `audioFileMaxKB`), checked by `src/lib/data/data.test.ts`; `audioRuntimeJsGzKB` is
measured by hand until the budget script covers its lazy chunk.

**Quality tiers (S04b).** `src/lib/quality/probe.ts` reads the device signals (WebGL2, renderer,
`MAX_TEXTURE_SIZE`, `deviceMemory`, `hardwareConcurrency`, Save-Data, `prefers-reduced-data`);
`src/lib/quality/tier.ts` picks low, mid or high from them with the `tierPicker` thresholds
(unknown signals are neutral; data saver forces low); `src/lib/quality/stepDown.ts` decides
runtime step-downs (never up) and the active tier. `src/state/quality.ts` persists only the
settings override (`cloutcity:quality`); it loads in its own chunk, outside the shell.

At run time the 3D map's shell mount (`src/scene/CitySceneClient.tsx`) probes the device
(`src/scene/webgl.ts`) with the thresholds and per-tier settings `CityScene` passes as server
props, records the pick in the store, and mounts the canvas when the main thread is idle. The
canvas (`src/scene/CityCanvas.tsx`) applies the active tier: DPR cap and outlines (the subway
casing) live, PCFShadowMap shadows from one directional sun on the high tier only
(`src/scene/SunLight.tsx`), antialiasing on the next load; building density and LOD scale are
exposed to scene parts through `useTierSettings()` (`src/scene/quality/tierSettings.ts`).
`TierMonitor` runs drei's `PerformanceMonitor` only inside the continuous-rendering window that
gestures and camera flights open (`beginContinuous` / `endContinuous` in
`src/scene/quality/continuity.ts`), so an idle on-demand map never reads as a low frame rate.
Audio plays the active tier. The Settings sheet (gear, or More on phones) has a Graphics choice:
Auto (the detected tier), Low, Mid or High; a data-saver request disables Mid and High.

Start-up marks (User Timing): `cc:shell-interactive`, `cc:playable` and the `cc:3d:*` steps
(`src/lib/perfMarks.ts`). `playwright.perf.config.ts` and `tests/perf/` hold the `e2e:perf`
harness: CDP network and CPU throttling, a machine-wide lock with a load wait so only one perf
run measures at a time, and specs for cold loads (median of `perfRun.coldRuns`), warm loads
(the service worker, S04e, and the HTTP cache) and each tier's draw calls, triangles and
renderer settings. The run writes its medians to `test-results/perf/report.json`.

**Shell diet (S05c, DEC-11).** The shell of `/` carries only the boot path: the layout, overlay
system, HUD, tab bar, the copy core with its boot namespaces, and the island mounts. Everything
else loads through `lazyIsland` (`src/components/overlay/lazyIsland.tsx`):

- **Boot islands** (`eager: true`) start loading as soon as the shell runs: the welcome card with
  its zod/mini form and onboarding store (its loading card keeps the page inert, so the 18+ gate
  fails closed), the event-sheet host with the game store, engine, save and catalogs, and the
  HUD sound control with the audio settings store.
- **Feature islands** load on first render: the event sheet UI, the place sheet, the sound
  settings sheet, and later the
  shop, panels and transit planner. Each shows a loading status in its own overlay zone (the
  skeleton appears after `layout.json` `overlay.loadingRevealDelayMs`) and, if its chunk fails,
  a retry there. Each feature root renders `data-cc-feature="cc-feature:<id>"`.

`npm run budget` then runs `scripts/shell-guard.ts`: no shell chunk may contain a feature marker,
a key of a non-boot copy namespace or zod, no static chunk may contain an e2e test hook, and the
shell must stay at or under `shellJsGzKB - shellHeadroomGzKB` (20 KB kept for features still to
land). `src/lib/shell-boundary.test.ts` checks the same boot path on the source import graph.

## 3D city scene

`src/scene/` renders the base city with react-three-fiber: extruded borough land, the water
plane, parks and cemeteries, subway ribbons with a dark casing, instanced station markers and
plain line-letter chips at each line's terminals (our own colours and style, never MTA bullets).
It is about a dozen draw calls at the default view, plus the player's avatar placeholder at their
home (`src/scene/avatar/`, two draw calls; `data/homes/homes.json` places each home, and the
camera starts over it).

- **Loading.** `src/scene/CityScene.tsx` (server) resolves config, palette tokens, the projected
  homes and bounds and copy into small props. `CitySceneClient.tsx` loads the canvas with
  `next/dynamic` (`ssr: false`), so the shell is interactive first, and starts the geo request at
  hydration. The geo layers come from the prerendered route `/geo/base?v=<geoVersion>`
  (`src/app/geo/base/route.ts`) and are validated in the 3D chunk with `zod/mini`
  (`src/scene/geo/schema.ts`, kept in step with the classic schemas by its tests). Format v3
  carries the `landmarks` layer (model parameters and frames, `src/lib/world/landmarksLayer.ts`).
- **Buildings (S04d).** After the city's first frame, `src/scene/buildings/Buildings.tsx` loads
  the active tier's districts near the view from `/geo/districts/<tier>/<id>?v=<hash>` and the
  blocks from `/geo/blocks/<tier>?v=<hash>` (prerendered; URLs from
  `src/lib/data/districts.ts` `districtAssets(tier)` / `districtAssetUrls(tier)`), builds each
  district as one merged mesh in time slices, and draws only what is within the tier's distance
  (`scene.json` `buildings.viewM` times `lodDistanceScale`), at its `buildingDensity` (the most
  prominent masses first). Blocks are one instanced mesh per borough with only the in-view
  instances drawn. District walls carry a window mask that glows with the shared night-glow
  uniform (`src/scene/lighting/nightGlow.ts`).
- **Landmarks (S07a).** `src/scene/landmarks/Landmarks.tsx` builds the code-built kit models
  (`buildLandmark`) after the first frame, nearest first, each in a drei `Detailed` with the
  tier's levels and distances (`scene.json` `landmarks.lod`); teaser landmarks on "expanding
  soon" land use the dimmed material; name chips show copy names only. `landmarkSource(id)`
  (`src/scene/landmarks/source.ts`) is where Blender models (DEC-25) take over per landmark.
  Modelled landmarks' pins are badges lifted over the model (`liftM`).
- **Config.** Camera start, zoom/tilt/turn limits, layer heights, line widths, marker and chip
  sizes, the shadow and the day/night keyframes live in `data/config/scene.json`; scene colours
  are world tokens in the `scene` block of `data/config/theme.json` (resolved to hex on the
  server). Toon shading uses one
  shared gradient ramp (`toonRamp`).
- **Camera.** three's `MapControls` (`src/scene/camera/CameraRig.tsx`): one finger or left drag
  pans, pinch or wheel zooms towards the pointer, two fingers or right drag rotate and tilt; the
  target stays inside `data/geo/bounds.json`. Rendering is on demand (`frameloop="demand"`), so an
  idle map draws zero frames.
- **Attribution.** `src/scene/MapAttribution.tsx` shows the NYC Open Data and MTA lines in the free
  scene row of the overlay grid (a one-line form when the row is short, via a container query in
  `globals.css`); `/credits` has the full text.
- **Failures.** Before the canvas mounts, the shell checks for WebGL2 and downloads the geo body
  (`src/scene/geo/load.ts`, which never rejects); the 3D chunk validates it without throwing. No
  WebGL, a failed download, a non-JSON body or a schema failure each show the error status
  (`map.error.device` or `map.error.load`) over the static background and log exactly one
  structured warning; the shell keeps working. `SceneErrorBoundary` only catches unexpected
  renderer errors.
- **Test hooks.** With `NEXT_PUBLIC_TEST_HOOKS=1` at build time, `window.__cloutcityTest.scene`
  exposes `ready`, `frames()`, `pendingFrames()`, `camera()`, `renderInfo()`, `player()`,
  `buildings()` and `landmarks()` among others (`src/scene/testHooks.tsx`). The e2e
  web server sets it and builds into `.next-e2e` (`NEXT_DIST_DIR`, read by `next.config.ts`), so
  the hook never reaches `.next`; in every other build its code is removed as dead code.

## PWA

`src/app/manifest.ts` serves `/manifest.webmanifest`. Icons are rendered from
`public/icons/icon.svg` by `node scripts/generate-icons.ts` (output committed). The viewport is
locked to the device width with `viewport-fit=cover`; the shell blocks page scroll, bounce and
double-tap zoom in CSS but keeps pinch zoom (WCAG 1.4.4).

**Offline (S04e).** A Serwist worker (`src/sw/sw.ts`, rules in `src/sw/policy.ts`) is served
from `/serwist/sw.js` (no-cache, strict CSP, no source map) and registered once the map is
playable and the browser is idle, in production builds only. It precaches the build's JS, CSS,
SVG and fonts, the icons, the pages and the versioned base geo; models and audio are never
precached. Runtime caches, all cache-first, same-origin GET only, versioned by content and
deleted when a newer worker takes over: `cc-geo-*` (`/geo/...` fetches whose only query is `?v=` at
a version this build serves), `cc-audio-*` (after the audio choice), `cc-models-*`
(`/models/<id>.<tier>.<sha8>.glb`, as the scene loads them) and `cc-chunks-*` (the optional
chunks the precache leaves out). Under Vercel Skew Protection (`NEXT_DEPLOYMENT_ID`) asset URLs
carry `?dpl=`: the precache ignores it and the chunk cache stores the URL without it
(`npm run e2e:dpl` covers it).
After registration the page sends `CC_WARM_TIER` with its quality tier, and the worker fetches
that tier's district and block URLs (`districtAssetUrls(tier)`, baked in at build time) into
`cc-geo-*`; it does so again when the tier changes, and never under a data-saver request or on
a device reporting at most `tierWarm.skipAtOrBelowDeviceMemoryGB` of memory
(`data/config/offline.json`). A new build waits: the update notice (banner zone,
`data-cc-notice="update"`) offers a reload, and stays hidden while a modal or the tour is up.
"Later" puts off that build only; if another tab applies it first, Update here just reloads.
E2E blocks service workers by default; `service-worker.spec.ts`, `offline.spec.ts` and
`npm run e2e:perf` opt in. To drop a local worker: DevTools > Application > Service workers >
Unregister, or run `npm run dev` once (development builds unregister it).

## Local Supabase

The Supabase CLI is a devDependency (`npx supabase ...`); Docker must be running.

```bash
npx supabase start              # first run pulls the images; prints URLs and local keys
npx supabase migration up --local  # applies new files in supabase/migrations
npm run test:integration        # Vitest suites in tests/integration against the local stack
npm run db:types                # regenerates src/lib/supabase/database.types.ts after a migration
```

- **Shared stack.** The stack is named after `project_id` in `supabase/config.toml`, so every
  checkout and worktree of this repo talks to the same containers and database. Apply new
  migrations with `migration up`; never `db reset`, which wipes it for all of them.
  `supabase stop && supabase start` is needed after editing `config.toml`.
- **Integration tests** read the URLs and keys from `npx supabase status -o json` (no env file
  needed; `SUPABASE_API_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` and
  `SUPABASE_DB_URL` override them). They fail fast if the stack is down or the newest local
  migration is not applied. They never reset the database: each test signs in fresh guests.
  `tests/integration/types.test.ts` fails when `database.types.ts` is stale.
- **Privileges are explicit.** The first migration revokes Supabase's default grants: a new
  table or function in `public` is closed to `anon` and `authenticated` until a migration grants
  it. Clients only ever get `SELECT` on rows they own or are a party to; every write is a
  security-definer RPC or the service role. Server helpers live in the unexposed `private`
  schema. Every function sets `search_path = ''` and uses schema-qualified names.
- **Attestation gate.** A profile row is created (unattested) with each auth user. After
  `signInAnonymously()` the client calls `attest_and_consent` with
  `toAttestationArgs(record)` from `src/lib/supabase/attestation.ts` (the welcome card's
  record, never the birth year). Every client RPC must start with
  `v_uid := private.require_attestation();` or carry
  `comment on function ... is '@attestation-exempt: <reason>'`; `tests/integration/catalog.test.ts`
  enforces this and calls every gated RPC as an unattested guest.
- **Handles** (S18a). Attesting gives a player a generated `AdjectiveNoun##` handle; `set_handle`
  lets them choose one, `check_handle` answers the form's live availability check, and
  `get_my_profile`, `get_public_profile` (by handle) and `get_public_profiles` (by ids) read
  profiles. Other players only ever get `handle`, `public_level`, `career_path` and `avatar`.
  `public.handles` is service-role only. The handle rules (`data/config/handles.json`), the
  words (`data/copy/handleWords.json`) and the blocklist (`data/moderation/handle-blocklist.json`)
  reach the database through a generated block in the migration: after changing any of them, run
  `npm run handles:sql` and add a migration with the new block
  (`scripts/moderation/blocklist-sql.test.ts` fails until the newest block matches).
- **Safety** (S18b). `block_player` (ends the friendship and roommate link, returns an undo token
  valid for `blockUndoSeconds`), `unblock_player`, `mute_player`, `unmute_player`,
  `list_my_blocks`, `list_my_mutes`, `submit_report`, `list_my_reports`, `acknowledge_notice`
  and `submit_appeal`. Players read only their own `blocks`, `mutes` and `account_notices`;
  reports, content holds, sanctions, appeals and the moderation audit live in the `private`
  schema. `private.can_view(viewer, target)` hides blocked pairs (both ways) and suspended or
  banned players; `private.public_handle` shows `Player` for a handle under a content hold.
  The limits come from `data/config/moderation.json`, copied into `private.moderation_settings`
  (after changing the JSON, add a migration that updates that row; the integration suite fails
  until they match). The note filter is `private.contains_contact_info`, twinned in
  `src/lib/safety/textFilter.ts`.
- **Standing gate.** Right after the attestation gate, every client RPC calls
  `perform private.require_good_standing(v_uid, 'interact' | 'social');` or carries
  `@standing-exempt: <reason>` on a line of its comment (`catalog.test.ts` enforces it).
  `interact` is refused while suspended or banned; `social` also while restricted.
- **Moderation** (S18b). The `mod_*` RPCs are service-role only (the `/mod` server routes call
  them): each takes the moderator's user id, the case (the reported player's id; the appeal id
  for `mod_resolve_appeal`), an idempotency key and a correlation id, and writes exactly one row
  to the append-only `private.moderation_audit`. `moderator_reset_handle` is no longer callable
  through the API; `mod_reset_handle` wraps it with the audit row. `mod_queue` (open cases by
  priority with trusted-reporter and brigade flags, plus pending appeals) and `mod_case` (one
  case's reports with notes and snapshots, holds, sanctions and history) feed the console.
- **/mod console** (S18b part 2). `src/app/mod` is its own route, `noindex`, with its own
  Supabase session (`storageKey: 'cloutcity-mod-auth'`, `src/lib/supabase/modAuth.ts`), so it
  never touches the game's guest session. Sign-in is an emailed link: `POST /api/mod/sign-in`
  answers the same 202 for every address and sends the link (after the response) only to one on
  `MODERATOR_EMAILS`, landing on `<SITE_URL>/mod` (server env, never the request's Host header;
  unset turns sign-in off); it is rate limited per IP (`moderation.json` `console`, per server
  instance). `GET /api/mod/queue`, `GET /api/mod/case/<player id>` and `POST /api/mod/action` need
  `Authorization: Bearer <access token>`; `src/server/moderation/handlers.ts` checks it with
  `auth.getUser`, then the email (confirmed, non-anonymous, on the list) and that the session came
  from an emailed link (`amr` `otp`, so a password or guest account that set the address is
  refused), and answers 401/403 otherwise. Every response is `no-store` and `noindex` and carries `X-Correlation-Id`, which is
  also the audit row's correlation id. `/mod?case=<player id>` opens one case directly. Locally the
  magic link lands on `site_url` (`supabase/config.toml`); add the `/mod` URL of your dev server
  to `additional_redirect_urls` to land on the console, and set the hosted project's redirect
  URLs the same way. `src/server/**` starts with `import 'server-only'`
  (`src/lib/server-boundary.test.ts`; `npm run budget` also fails if a chunk names
  `MODERATOR_EMAILS` or `SUPABASE_SERVICE_ROLE_KEY`).
- **Player safety UI** (S18a/S18b part 2). The Me tab opens the Me panel
  (`src/components/profile`): the public card, the handle form (live preview, debounced
  `check_handle`, `data/config/profile.json` `handleCheckDebounceMs`) and the blocked and muted
  lists, or an honest "playing solo" state without a session. Every player surface must use
  `src/components/safety/PlayerActions.tsx` (Mute, Block with confirm, Report; Add friend joins
  with S20) with the shared `safetyApi` (`src/lib/supabase/safetyApi.ts`). Moderator notices
  load once the guest session connects and show as a modal with an appeal form. The e2e suite
  drives PlayerActions through `window.__cloutcityTest.safety` with an in-memory API.
- **Retention.** `private.purge_expired_safety_data()` applies `moderation.json` `retention` and
  never touches a player with any report under legal hold. The migration enables `pg_cron` and
  schedules it daily at 08:17 UTC (`cron.job`, job `purge-expired-safety-data`); on a hosted
  project check it under Integrations > Cron. The periods await legal review (SEC-12).
- **RPC errors** raise SQLSTATE `PTxyz` (PostgREST answers HTTP `xyz`) with a machine-code message
  (`RPC_ERRORS` in `attestation.ts`; `parseRpcError()` reads it).
- **Browser bundle.** `@supabase/supabase-js` may reach browser code only through a dynamic
  `import()`; `src/lib/client-imports.test.ts` fails on a static import chain from a client entry.
- **Guest session (S05).** After the 18+ card, `src/state/session.ts` plays local at once and, if
  `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` are set, waits for the map to be
  playable, imports `src/lib/supabase/supabaseAuth.ts` lazily, reuses or starts an anonymous
  session (default `sb-<ref>-auth-token` key) and records the attestation. A rate limit or no
  network keeps local play (info; no network retries once when back online); sign-ins switched
  off or any other refusal warn. `npm run e2e:supabase` checks it against the local stack.
- **Production** (set in the Supabase dashboard, not `config.toml`): enable anonymous sign-ins,
  set the anonymous sign-in rate limit per IP (locally raised to 1000/h for tests) and turn on
  Turnstile under Auth > Bot and Abuse Protection (CAPTCHA). The local stack has no CAPTCHA.

## Ignored paths

`.gitignore` covers env files, build output (`.next/`, `.next-e2e/` and `.next-e2e-supabase/` for the e2e builds, `out/`), test artefacts
(`test-results/`, `playwright-report/`, `coverage/`) and the geo download cache (`.cache/`:
the raw NYC Open Data and MTA files `npm run geo:build` downloads, the audio originals
`npm run audio:build` downloads and the 3D packs `npm run assets:build` downloads, kept
unmodified).

## Agent orchestration kit

A portable Claude Code workflow: one **orchestrator** (the main session) routes work to four
specialist subagents, with a shared rulebook, per-agent project memory and a single open-issues
tracker. Extracted from a production Next.js codebase where it has run for several months.

### The flow

```
               ┌──────────── fix loop ────────────┐
user ─► orchestrator ─► architect ─► code-ninja ─► bug-hunter ─► PR
               │          (plan)       (code)    (unit + e2e)
               │                          ▲            │ failure report
               │                          └────────────┘
               └─► qa-mafia ─► Markdown report ─► user decides
                  (live browser, acceptance criteria — standalone, never in the fix loop)
```

| Agent        | Role                                                                                                               | Writes product code? | Model  |
| ------------ | ------------------------------------------------------------------------------------------------------------------ | -------------------- | ------ |
| `architect`  | Turns a request into an approved, phased plan                                                                      | No (read-only tools) | sonnet |
| `code-ninja` | Implements the approved plan / bug fix / refactor                                                                  | Yes                  | opus   |
| `bug-hunter` | Owns all automated tests (unit, integration, Playwright e2e); reports product failures back instead of fixing them | Tests only           | sonnet |
| `qa-mafia`   | Drives the live app with `playwright-cli` against acceptance criteria; writes a report to `qa-reports/`            | No                   | sonnet |

The orchestrator stays accountable: it reviews every report against the Core Operating Rules,
records every finding in the tracker, and asks the user for anything that needs a ruling.

### What's in the kit

```
CLAUDE.md.template              orchestration model + Core Operating Rules 1–23 + lessons learned
.claude/agents/*.md             the four subagent definitions
.claude/agent-memory/*/MEMORY.md  empty per-agent memory indexes (agents fill them over time)
.claude/skills/playwright-cli/  the browser-automation skill qa-mafia uses (stock, unmodified)
docs/local/OPEN-ISSUES.md       issue-tracker template (Rule 22)
gitignore.snippet               lines to append to .gitignore
```

### Adopt it in another project

1. **Copy the files** into the target repo root (keep the paths):
   ```bash
   cp -r .claude docs CLAUDE.md.template gitignore.snippet /path/to/project/
   cd /path/to/project && mv CLAUDE.md.template CLAUDE.md && cat gitignore.snippet >> .gitignore && rm gitignore.snippet
   ```
   If the project already has a `CLAUDE.md`, merge: keep its project-specific sections and add the
   _Orchestration Model_ and _Core Operating Rules_ sections from the template.
2. **Fill the placeholders** — find them all with `grep -rn '{{' CLAUDE.md .claude docs`:

   | Placeholder                                                        | Where                      | Example                                            |
   | ------------------------------------------------------------------ | -------------------------- | -------------------------------------------------- |
   | `{{PROJECT_NAME}}`, `{{ONE_LINE_DESCRIPTION}}`                     | CLAUDE.md                  |                                                    |
   | `{{E2E_DIR}}`                                                      | CLAUDE.md, bug-hunter.md   | `tests/e2e`                                        |
   | `{{APP_SOURCE_PATHS}}`                                             | qa-mafia.md                | `` `src/app/`, `src/components/`, `src/server/` `` |
   | `{{QA_ENV_FILE}}`, `{{QA_EMAIL_VAR}}`, `{{QA_EMAIL_PASSWORD_VAR}}` | CLAUDE.md, qa-mafia.md     | `.env.local`, `QA_EMAIL`, `QA_EMAIL_PASSWORD`      |
   | `{{ISSUE_TRACKER_PATH}}`                                           | CLAUDE.md                  | `docs/local/OPEN-ISSUES.md`                        |
   | `{{TRUNK_BRANCH}}`                                                 | CLAUDE.md                  | `dev` or `main`                                    |
   | `{{INSTALL_CMD}}` … `{{E2E_CMD}}`                                  | CLAUDE.md commands section | `npm ci`, `npm run lint`, …                        |
   | PROJECT-SPECIFIC sections                                          | CLAUDE.md                  | structure, style, logging rules for your stack     |

   The `{{...}}` lines inside the agents' _memory frontmatter examples_ (`name: {{short-kebab-case-slug}}`)
   are intentional — they're the template the agents fill in. Leave those.

3. **Install the browser CLI** qa-mafia drives: `npm install -g @playwright/cli` (provides
   `playwright-cli`; the skill falls back to `npx --no-install playwright-cli`). bug-hunter's e2e
   specs need `@playwright/test` and a `playwright.config.ts` in the project as usual.
4. **Give qa-mafia a QA mailbox** so live QA is self-service: a Gmail (or any IMAP) inbox with an
   app password in your untracked env file. Plus-addressing (`qa+admin@…`) yields unlimited test
   identities. Without it, qa-mafia will have to ask for accounts and OTPs.
5. **Tune per project** (optional):
   - Model per agent: the `model:` frontmatter line (`opus` / `sonnet` / `haiku`).
   - architect's `tools:` list — it's read-only by design; add MCP tools you want it to consult (e.g. Figma).
   - Rules you don't want: delete them from CLAUDE.md, but keep 21–23 — they're what make the loop trustworthy.
6. **Commit** `CLAUDE.md`, `.claude/agents/`, `.claude/agent-memory/` and `.claude/skills/`. The
   agent memories are meant to be shared through version control; `docs/local/` and `qa-reports/`
   stay local (gitignored).

### Using it day to day

- _"Plan X"_ → architect; you approve the plan → code-ninja implements → bug-hunter tests → PR.
- _"Validate this story: …"_ or _"Generate the stories for area Y and check them"_ → qa-mafia.
- New bugs, risks and questions land in `docs/local/OPEN-ISSUES.md` with IDs; direct work by ID
  ("fix BUG-12 and SEC-3"). Items leave the open list as soon as their fix merges.
- For parallel batches, ask the orchestrator to split by file area and run each `code-ninja` in
  its own worktree; validate with `bug-hunter` per branch, one e2e run at a time.
