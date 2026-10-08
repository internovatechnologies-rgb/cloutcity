# Progress log

The loop appends here after each task. Fresh iterations read this first.

## Machine facts (2026-10-06)
- Node v24.19.0, npm 12.0.2 (Next.js 16.3.8 needs Node >= 20.9: OK)
- Docker 29.7.2 installed, Docker Desktop running
- Supabase CLI 2.119.0 installed globally (Homebrew); S01 also adds it as an npm devDependency (`npx supabase`)
- Stripe CLI 1.53.0 installed (Homebrew), **not logged in**
- gh: logged in as JesutoniAderibigbe, WRITE access to internovatechnologies-rgb/cloutcity
- Playwright Chromium: installed (WebKit and Firefox not installed; optional)
- Network: available

## Environment (a human fills this in; the loop may set webgl only, per loop step 10)
Tasks whose `requires` includes an item marked no are blocked with these instructions.
- network: yes
- webgl: yes (S01 webgl-smoke passes with --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader)
- supabase: yes (local stack started 2026-10-06 via `npx supabase start`; .env.local has
  NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY and
  MODERATOR_EMAILS. If Docker restarts: `npx supabase start`. imgproxy and pooler are stopped; not needed.)
- realtime: no
  Unblock: supabase above, then confirm `npx supabase status` lists Realtime and
  `npm run check:realtime` passes (added with S29), then set yes.
- stripe: no
  Unblock:
  1. `stripe login` (the user runs this; it opens the browser).
  2. Put test-mode STRIPE_SECRET_KEY and NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY in .env.local, and
     STRIPE_WEBHOOK_SECRET from `stripe listen --print-secret`.
  3. Set yes.
- playwright browsers installed: yes (chromium)
- github: yes
- qa mailbox: no (QA_EMAIL / QA_EMAIL_PASSWORD in .env.local; needed only for deployed-env QA.
  Local magic links use the Supabase mail catcher)
- moderators: MODERATOR_EMAILS in .env.local (comma-separated; default: the user's account)

## Open rulings (user approved defaults on 2026-10-06 unless marked)
- Age (user ruling, from the user's manager): adults only (18+). The welcome card on first open asks a
  neutral year of birth before play; under 18 sees an in-voice "come back when you're 18" screen,
  the gate locks on that device for 24 h, and no Supabase user is created. Only an attestation
  boolean and timestamp are stored, never the birth year.
- Content (user ruling): nightlife and alcohol as flavour only, never rewarded, required or tied
  to a stat; no drugs, sexual content or gambling; mild profanity only.
- Clocks: a personal game clock per player, plus shared real NYC city time for shared features.
- Strangers: preset emotes only.
- Realtime vendor: Supabase Realtime behind PresenceTransport, migrating at the cost trigger.
- Visibility: guests visible under generated handles; ghost mode for everyone; the user moderates
  via MODERATOR_EMAILS.
- Music: CC0 only, no radio.
- CAPTCHA: Turnstile on anonymous sign-in in production only.
- Legal: generic labels for branded landmark names and derived subway artwork; everything stays
  `legalReviewed:false` until legal review.
- Out-of-scope list in CLAUDE.md stands.
- Payments: Stripe test mode only. Real payouts need a Stripe account in a supported country
  (Stripe does not directly support Nigeria-registered businesses; e.g. a US entity via Stripe
  Atlas). Human step, not a loop task.

## Pinned versions and why (Rule 2)
- three 0.182.0: R3F 9.8.1 uses THREE.Clock (deprecated r183) and PCFSoftShadowMap
  (deprecated r186). Newer three versions warn in the console (PERF-1).
- typescript 6.0.3: typescript-eslint 8.71.1 requires < 6.1.0 (TypeScript 7.0.2 is latest).
- eslint 9.39.5: eslint-plugin-jsx-a11y 6.10.2 supports only up to ESLint ^9.
- Next 16 removed `next lint`: use the ESLint CLI.
(Versions verified against the npm registry by the orchestrator on 2026-10-06.)

## Learnings and gotchas
- Six lanes running builds/e2e at once overloaded this 10-core Mac (load avg up to ~85): tests hit
  5 s timeouts and API calls stalled. Heavy steps (npm test, build, e2e) now go through a shared
  2-slot queue script (orchestrator scratchpad `heavy.sh`); never raise timeouts to compensate.
- NYC Open Data (Socrata) and nyc.gov return 403 from this machine; geo:build uses NYC DCP's ArcGIS
  FeatureServer + MTA S3. The download cache lives in .cache/geo (gitignored); copy it between
  worktrees or run `npm run geo:build` with network. `geo:build -- --check --offline` verifies outputs.
- MTA GTFS quirks: Q/N/R shapes end ~103 m short of 96 St (terminal extension); Q03/Q04 sit 4–4.5 m
  off their shapes. NTA QN0151 (Rikers) has BoroName Bronx but CDTA QN01; Marble Hill station 106 is
  borough manhattan but zone bx08.
- src/lib/geo uses relative `.ts` imports so Node scripts can load it; src/lib/data/geo.ts (classic
  zod + all layers) is never imported by client code.
- zod/mini must be imported as a namespace: `import * as z from 'zod/mini'`. `import { z }` makes
  Turbopack bundle all of zod/mini incl. locales (~92 KB gz). client-imports.test.ts enforces it.
- Playwright: use page.clock.setFixedTime only; clock.install() fakes rAF and hangs the console
  guard's settle. Playwright's getByRole does not skip inert content; check for an [inert] ancestor.
- Onboarding lives in its own store (cloutcity:onboarding v1), separate from the game save, so it
  survives game-save repair/migration. E2E fixture option `onboarding: 'complete' | 'fresh'`.
- Client code validates with `zod/mini`; classic zod in the shell costs ~90 KB gz (blew the 180 KB
  budget). Never import `@/lib/data/config` or classic schemas from client-reachable modules
  (src/lib/client-imports.test.ts enforces it). Server/scripts may use classic zod.
- Expected storage conditions (private mode, quota, corrupt save) log at `info`; the e2e console
  guard fails on warnings, so reserve `warn` for real problems.
- Copy cannot contain literal `{` or `}` (placeholder rule); add an escape if ever needed.
- Any `Intl` reference, toLocale*/toFixed/toPrecision, or `$`-prefixed template/concat outside
  src/lib/format.ts is a lint error: money and counts go through formatMoney/formatCount.
- Superlatives in copy only via superlative(kind, subjectId, values) (needs ≥2 distinct ids).
- src/engine is pure and lint-enforced: no Date/Reflect/self/globalThis/timers/fetch, no Math.random,
  no dynamic import/require, no imports of state/components/scene/realtime/server/app (any path form).
  Time is injected; city-time parts come from wallClockParts in src/lib/format.ts.
- Saves: a newer-build save is never overwritten without discardNewerSaveAndStartFresh(); invalid
  fields are repaired (speed→1x, remainder→0, stats clamped), only structurally broken saves start
  fresh; storage is written only on meaningful changes (minute, stats, cash, speed), not every tick.
- e2e serves on port 3100 (E2E_PORT) because 3000 is taken on this machine; reuseExistingServer
  is on outside CI, so make sure nothing stale is serving on 3100 before trusting a run.
- SwiftShader always logs "GPU stall due to ReadPixels" at warning level for a visible WebGL
  canvas; the console guard allowlists exactly that text, warning type only.
- The console guard waits 2 rAF + consoleSettleMs (250 ms) after each test; errors later than that
  are not caught by design. Raise consoleSettleMs per spec if a flow has late async work.
- Playwright 1.63 needed `npx playwright install chromium` (headless shell v1243).
- log.ts scrubs emails (incl. %40), Bearer/JWT tokens and sensitive URL params in every string;
  free-text like "code=404" is over-redacted on purpose.
- Supabase Realtime bills a broadcast to N subscribers as N+1 messages. Keep shards small and
  send intents, not per-frame positions. Presence track() is not for high-frequency data.
- Supabase anonymous sign-ins: 30 per hour per IP by default (shared Wi-Fi and carrier NAT can
  hit it). Raise it in the dashboard for production and add Turnstile.
- Free Supabase projects pause after a week idle. Production needs Pro.
- Headless Chromium renders WebGL in software. Never assert FPS in CI; assert bytes, timings,
  draw calls and triangles.
- docs/local/ is gitignored: put OPEN-ISSUES pointers into iteration notes.

- Shell diet (S05c): the shell of / carries only the boot path (≤ shellJsGzKB − shellHeadroomGzKB, 160 KB);
  features load via lazyIsland with their own copy namespace (data/copy/<ns>/), registered by
  importing src/lib/copy/ns/<ns>.ts. copy() throws CopyNamespaceNotLoadedError for an unloaded
  namespace. Tests/server import @/lib/copy/all. Test hooks need NEXT_PUBLIC_TEST_HOOKS=1 (e2e build).
- The page is inert from the first byte until the modal island settles (boot hold); e2e waits via
  waitForWelcomeGate().
- Auto-mode may deny `git rebase` in lanes: integrate by committing the lane and merging dev into it
  (non-destructive), then fast-forward dev.

- Supabase (S18): stock default privileges are wide open; migration 1 revokes them, so every table and
  RPC needs an explicit GRANT (catalog test catches gaps). Client RPCs start with
  `v_uid := private.require_attestation();` or carry `@attestation-exempt: <reason>` (update EXEMPT in
  catalog.test.ts). SQLSTATE PTxyz → HTTP xyz; supabase-js returns {code, message}. One local stack is
  shared by all checkouts: `db reset` affects every lane. `npm run test:integration` needs it running.

- Never `pkill -f next-server` (or any pattern-wide kill): it stops every lane's servers and the user's
  preview. Stop only your own process by PID or by its port (`lsof -tiTCP:<port> -sTCP:LISTEN`).

- Day/night (DEC-15): city lighting follows the personal game clock; task S04f added after S04d to the
  playable slice. DEC-16: the interface theme also follows day/night (S04g, after S04f).

- Only one browser (e2e/playwright) suite runs machine-wide at a time (heavy.sh takes an `e2e` lock):
  two parallel suites starved SwiftShader and failed 61 timing tests in a 31-minute run.

- The local Supabase stack is stopped by default (user request, to save CPU). Start it with
  `npx supabase start` only for test:integration / e2e:supabase, then `npx supabase stop`. Never quit
  Docker or touch non-cloutcity containers (the user has other projects there).

- Build-first mode (user request 2026-10-07): per task run ONLY typecheck, lint, the full unit suite,
  build and budget (no e2e, no per-task bug-hunter). The orchestrator merges each finished task to
  `integration/slice` on those fast gates (small, frequent merges). At the end of the playable slice:
  one full e2e run, bug-hunters fix everything found, qa-mafia, then merge to dev and open the PR.
  Tasks are marked passed only after the slice-end tests pass. Exception: security/money/server tasks
  (S18a/b/c, S19+, S25–S28) keep their own bug-hunter before merging.

- Art direction (DEC-24, user 2026-10-07): hand-made 3D models from free CC0 packs only (no custom
  or AI models); S04h asset pipeline added; landmarks use the code-built kit as styled stand-ins.

- DEC-25: NYC landmarks modelled by Claude in Blender (scripts/blender, headless, reproducible) → S07c.
  DEC-26: real-world colours; indigo/pink retired; UI light by day, dark glass by night, taxi-yellow accent
  (S04f/S04g re-scoped).

- Slice split (user decision 2026-10-07): **Playable slice v1** = everything passed so far + S06, S16, S04b,
  S04e, S18a/b/c (security reviewed), S04h (pipeline + avatar swap + apartment furniture), S04d p2,
  S07a p2 (code-built stand-ins on the map), S08 p2, S04f, S04g → end-of-slice tests → PR. **v2** right
  after: S07c Blender landmarks (Brooklyn Bridge pilot first, user gate on look/caps/bytes, then waves),
  S07b, S04i street dressing, S16a avatar creator.

## Lanes and slice plan (user decisions 2026-10-06)
Goal: a **playable solo slice** first (welcome card, 3D map, travel, jobs, rent, shop, clout,
events), then the rest. Up to six lanes, full testing on every task.
- Lane A (worktree lane-a, 3100): S05a ✓ → S05b → S05 (needs S04a) → S06 (main checkout is integration-only from now on)
- Lane B (lane-b, 3101): S04 → S04a → S04c → S04b → S04d
- Lane C (lane-c, 3102): S11 ✓ → S10 ✓ → S12 → S10a (needs S09)
- Lane D (lane-d, 3103): S14 ✓ → S05c shell diet (urgent: shell 174.6/180) → S13
- Lane E (lane-e, 3104): S07 → S09 → S07a
- Lane F (lane-f, 3105): S08 (needs S04 merged)
Slice = S01–S06 minus S04e, plus S07, S07a, S08–S14. After the slice: S04e, S07b, S15, S16, S16a,
then phases 4–7. Slice PR "Playable slice" opens when all slice tasks pass.

## Phase user stories (qa-mafia, Mode A, at phase end)
1. New visitor on a phone: opens the link, passes the 18+ welcome card, picks audio, lands on the
   3D map in Queens, takes or skips the tour, buys a first bodega breakfast, finds any place via
   the Places panel, still plays after going offline and reloading. An under-18 answer is refused
   with the in-voice screen and stays locked on reload.
2. Player travels by walk, subway and taxi; visits a landmark; is refused then admitted at the
   club door; buys and sells an item; works a shift; pays rent; sees why Brooklyn and Manhattan
   are locked.
3. Player levels up through clout and flexing at a landmark, resolves an event, completes goals,
   decorates the apartment, builds an avatar in the creator.
4. Player saves progress via magic link and keeps it; picks a handle; adds a friend by invite;
   chats until the 10-message limit; blocks and reports; shares a card; views /live.
5. Two players in two browsers see each other move in the same neighborhood; block, mute,
   report, ghost mode and emotes work; the city degrades to solo when offline; a live event
   counts down.
6. Player browses premium items, buys one in Stripe test mode, sees it restored on another
   device, and loses it on refund.
7. Full smoke test of all of the above on mobile-390.

## Phase reviews
(none yet: phase, qa-mafia verdicts, report paths, PR link)

## Tuning log
- S12 economy sim (TUNE-3): target missed (barista $372, retail $484, delivery $586/wk; free naps =
  unlimited energy; barista dominated). Costs-only fix, wages fixed: hunger decay 5→6/h; home-meal
  $4→$8; bodega-breakfast $6→$10; sleep +80→+55 energy; nap +15→+4 energy; new deli-coffee 10 min $12
  +20 energy; shift energy retail 15→25, delivery 25→40 (barista 15); housing.moveInCost brooklyn-1br
  $400, manhattan-loft $1000 (placeholder). Bot: 2 shifts/day, 2 rides/day at $3, deli coffee before
  shifts, never sleeps at 0 energy, skips work that would not end by 22:00. Result (30 days): retail
  (best) weeks 2–4 $140/$140/$140, affordable day 13, final $884; barista $112×3, day 14, $752;
  delivery $106/$114/$106, day 14, $748; min cash $147, no misses or evictions. Baseline:
  data/sim/economy-baseline.derived.json (npm run econ:update).
- S03 placeholders (TUNE-1): decay per game hour energy 3, hunger 5, mood 2; start stats 100/80/70;
  at-zero penalties (hunger 0: +3 energy/+4 mood drain per h; energy 0: +3 mood drain, 1.5x duration;
  mood 0: 1.25x duration); catalog sleep 480 min +80 energy +5 mood, nap 60 min +15 energy,
  bodega-breakfast 20 min $6 +40 hunger +5 mood, home-meal 45 min $4 5 energy +50 hunger,
  walk-in-the-park 60 min 10 energy +15 mood.

- S13 clout (TUNE-4 placeholders): first paycheck +10 clout; flex 30 min, 10 energy, $0, base 4 clout,
  once per place per game day, max 3/day, at flex landmarks (their multiplier) and boutiques, never at
  clubs; viral chance min(0.4, (0.05 + 0.005×style)×place), viral ×5; style +2%/point, cap +50%, applies
  to flex/event/paycheck only (club clout is exactly the configured value: nightlife is flavour only,
  DEC-12); item styleValue common 1–2, medium 3–5, rare 8–10, gifts 0; ledger 100 entries; premium cap
  200 (< Icon 5000); level-up toast 6000 ms, paused on hover/focus. Result: job bots end at 10 clout,
  Nobody; barista flex bot 28 flexes, 1 viral, Local on day 16, 170 clout, min cash $147, final $596.

## Blocked tasks
(none yet)

## Needs human review
(none yet)

## Iteration notes
- S01 (attempt 1, passed): Next 16.3.8 / React 19.3.0 / TS 6.0.3 / Tailwind 4.3.3 scaffold with
  pinned three 0.182.0, R3F 9.8.1, drei 10.7.9; ESLint 9 flat config (jsx-a11y, no-console),
  Prettier, Vitest 5, Playwright 1.63 (mobile-390, desktop-1280); shared e2e fixture with console
  guard + axe; PWA manifest and icons; bottom tabs; overlay layer system (data/config/layout.json);
  structured logger with redaction; budget script (136 KB / 180 KB shell JS); supabase/config.toml.
  Two bug-hunter fix cycles: logger value scrubbing (P1, P3) and console-guard settle window (P2).
  Gates: 96 unit, 70 e2e, build, budget all green. Placeholder tab/HUD copy and palette tokens
  are hardcoded: S02 moves them into /data/copy and data/config/theme.json.
  OPEN-ISSUES: RISK-1 npm audit (dev-only), RISK-2 darwin-only screenshot baselines, RISK-3
  stats-gl nested three, NOTE-1 port 3000, NOTE-2 blocked install scripts, NOTE-3 allowlist.
- S02 (attempt 1, passed): /data folders with zod schemas (src/lib/data/schemas, loaders in
  src/lib/data), perf.json with every CLAUDE.md budget (test reads CLAUDE.md), theme.json → CSS
  vars, realtime/moderation/balance/layout/copy config, placeholder seeds; copy layer with nyc and
  plain slang packs; formatMoney/formatCount + strict lint rule; superlative scanner and computed
  superlative(); Zustand store (cloutcity:game v1, migrate, zod/mini merge) with never-throwing
  storage. One fix cycle (superlative ranks, lint bypasses, all-file-type data check, malformed
  placeholders, integer counts, info-level storage logs). Gates: 253 unit, 76 e2e, build, budget
  137.4 KB. The store is not read by any UI yet (S03/S05 wire it).
  OPEN-ISSUES: DEC-9 zod/mini on client, TUNE-1 placeholder numbers.
- S03 (attempt 1, passed): pure engine in src/engine (clock with integer-microsecond remainder,
  1x/2x, hidden pause, 5 s tick cap; calendar + midnight/rent-week rollovers; stats decay per game
  hour with stacking at-zero penalties; validated actions with typed errors; city time via
  wallClockParts; save v2 with migrate from v1 and field repair); store actions tick/performAction/
  setSpeed/discardNewerSaveAndStartFresh; clockDriver (not started by any UI yet — S05 wires it).
  One fix cycle: purity-lint bypasses, newer-save overwrite guard + meaningful-change-only writes,
  repair-instead-of-discard, float carry. Test change by ruling: store.test.ts "repairs a negative
  remainder / a remainder of a whole game minute" now expects repair (was "starts fresh").
  Gates: 446 unit, 76 e2e, build, budget 137.4 KB. Catalog actions have no copy names yet.
- S05a (attempt 1, passed): welcome card over the scene — neutral year picker (only ≤ Y−19 passes),
  consent with Terms/Privacy (placeholder routes), audio choice; under-18 → in-voice lock for 24 h,
  no Supabase; 18+ → local attestation/consent/audio record (never the year); startGuestSession hook
  (local mode only; S05 adds Supabase); shared form pattern; modal overlay layer + OverlayBackground
  inert + focus trap; e2e fixture seeds onboarding. Orchestrator fixes: zod/mini namespace imports in
  src/engine/actions.ts and save.ts. Gates: 502 unit, 210 e2e, build, budget 161.7 KB.
  OPEN-ISSUES: DEC-9 update, Q-5 re-consent, Q-6 Y−18 ruling, RISK-2 baselines; low: storage log text
  says "saved game" for onboarding data.
- S04 (attempt 1, passed on lane-b, merged): reproducible geo:build from hash-locked DCP borough/NTA
  layers + MTA GTFS → derived land, water, parks, subway (29 lines, 496 stations) and 71 CDTA zones;
  SOURCES.md; ENU projection (cc-enu-v1, origin 40.7/−73.98); base geo 137 KB gz. Bug-hunter: 0
  product failures. Merge conflicts in data.test.ts and schemas/config.ts resolved (kept both).
- S11 (attempt 1, passed on lane-c, merged): four shift jobs at the wage anchors, weekly rent with
  late fees and eviction to the lowest-rent home, clout-level gating helper src/engine/clout.ts, save
  v3. Bug-hunter: 0 product failures. Copy JSON conflicts with S05a resolved (kept both).
  OPEN-ISSUES: UX-4 eviction wording, TUNE-2 placeholders.
- S10 (attempt 1, passed on lane-c, merged): 12 wearables (3 rarities, 5 slots) + 3 gifts, cash only;
  resale floor(price × resalePct) depreciating 5%/game day to a 50% floor; own-once wearables, stacking
  gifts; effects once per owned copy on first wear; gifts to 'yourself' or a branded NpcId only; save
  v4 inventory. Bug-hunter: 0 product failures (low: tampered worn:false can re-grant an effect; v3 save
  carrying inventory starts fresh). No UI yet → S10a. Gates on dev: 1010 unit, 210 e2e, budget 163.9 KB.
- S07 (attempt 1, passed on lane-e, merged): 5 boroughs with config-driven clout gating (Brooklyn at
  local, Manhattan at scene-regular, Bronx/SI expanding soon); 27 landmarks (Wikidata P625, verified
  within 1 m by bug-hunter; generic labels for branded names; 9/11 Memorial strict look-only); 24
  invented venues (corner-halo-deli renamed late-lantern-deli); engine boroughs.ts/places.ts;
  client-safe src/lib/world/places.ts. 3D render sub-clauses moved into S04c's acceptance (orchestrator
  note). Gates on dev: 1238 unit, 210 e2e, budget 167.4 KB (copy growth → S05c).
  OPEN-ISSUES: LEGAL-1 list, STN-1, "Ninth Hour Coffee" flag.
- S08 part 1 (engine, merged; S08 not yet passed — part 2 wires the 3D animation after S04a): walk,
  subway (Dijkstra over real lines, walking legs, transfers), taxi via 23 crossings + road waypoints,
  water rules (walk refused across water, ends snapped to land within 300 m), rush-hour slowdowns,
  seeded MTA delay hook, animation timeline. Two edge-case tests updated to the rulings
  (POINT_NOT_REACHABLE, TRIP_TOO_LONG); the landmark reachability test uses S07 route points.
- S14 (attempt 1, passed on lane-d, rebased and merged): data-driven events with seeded RNG, 15
  events, safety resolved from place data by id (nothing at september-11-memorial, no crime at
  city-hall), lazy EventSheet, save v5 (v4→v5 adds event state; every version v1–v5 loads). One fix
  cycle (category bypass, newer-save info log). Gates on dev: 1530 unit, 232 e2e, shell 174.6 KB.
  OPEN-ISSUES: INT-3 two RNG modules (rng.ts vs transit random.ts) still to merge; clout/item event
  effects stay pending until S13/S10a wire them.
- S09 (passed on lane-e, fast-forwarded onto dev; lane gates on this exact tree: 1667 unit, 270
  e2e, shell 175.6 KB): place action sheet via openPlace(id), hours, club door + cover, club clout
  once per club per night (save v6), landmark Visit + flexMultiplier config, memorial info only,
  busy state until dismissed. Pending: S12 merge broke 3 tests (events decay, taxi centroid sweep) —
  rebase lane-c/S12 onto dev and fix; S05c next (plan approved, all defaults); hold S05b (177.7 KB)
  and S04a until S05c merges.
- S12 (passed on lane-c, rebased onto dev as one commit; lane gates on this tree: 1741 unit, 270 e2e,
  shell 175.7 KB): deterministic 30-day economy bot per entry job, target + exact-baseline drift
  layers, ±1 sweep robustness, plausibility fixture for S18c, src/engine/housing.ts canAffordMove,
  shared HOME_IDS tie-break. Fix cycles: bot schedule robustness (midnight wrap), re-tune; integration:
  event tests pin their stats block, zone-centroid taxi sweep gets a documented 30 s limit.
  OPEN-ISSUES: TUNE-3 placeholders (Manhattan move-in), mood sits at 0 for the bot most evenings.
- S05c (attempt 1, passed): shell of / 175.6 → 141.1 KB gz via boot islands (welcome + onboarding +
  zod/mini; store + engine + catalogs + event host ≈46 KB eager), lazy EventSheet/PlaceSheet with
  in-zone loading and retry, copy split per namespace, shell-boundary.test + scripts/shell-guard.ts
  (20 KB headroom). Integrated by merging dev into the lane (rebase denied by auto mode). Bug-hunter:
  18+ gate now fail-closed from the first byte (boot hold), whole-id marker matching, per-feature
  namespace coverage test. Dev gates: unit 1884, e2e 291 + 1 load flake (FLAKE-1, 30/30 in isolation).
- S18 (attempt 1, passed): ten tables with RLS and explicit grants, profile trigger + attest_and_consent,
  private.require_attestation gate + catalog default-deny scan, send_friend_boost one per sender per NY
  day, service-role-only money tables (livemode=false), Vitest integration harness. Bug-hunter: gate
  scanner hardened against comments/strings, exposed-schema guard, 17 security probes (124 integration
  tests). Follow-ups SEC-4..8 in OPEN-ISSUES. Dev gates: unit 1895, integration 124, e2e 292.
- S13 (attempt 1, passed): derived clout total (earned ledger + item clout + capped premium), first
  paycheck clout, flex with seeded viral roll, style multiplier, six levels, CloutMeter (presentational)
  + lazy HUD island, level-up toast, save v7. Bug-hunter: overflow-safe save repair, toast fits at
  390/844×390, anti-farming tests. Fix cycle: DEC-12 (no style on club clout, no flex at clubs),
  LevelUp.fromPeak, toast pauses on hover/focus. Dev gates: unit 2084, e2e 358.
- S05b (attempt 1, passed): audio system with "my own music" mode; integrated after S05c as an eager
  sound-control boot island + lazy settings sheet, `audio` copy namespace, hooks behind
  NEXT_PUBLIC_TEST_HOOKS. At 390 px the sound control is icon-only below `sm` (UX-7; S05 restores the
  visible text in the two-row HUD). Dev gates: unit 2084, integration 124, e2e 358, shell 141.9 KB.
- S10a (attempt 1, passed): shop sections and job shifts in place sheets, lazy Inventory and Rent HUD
  panels (eager quiet button island; 44 px icons below sm), focus after buy/sell/use, useActionGuard
  (held keys act once; during actionCooldownMs touch presses in the just-tapped rect are ignored, mouse
  only when drifting to another item; cooldown measured from when the action ran), BUG-1 rent notices
  from events. Two fix cycles + UX-6 touch fix. Dev gates: unit 2140, integration ok, e2e 418, shell
  142.3 KB. Follow-ups: UX-5 (event outcome text omits rent), FLAKE-1/2.
- S04a (attempt 1, passed): stylised 3D city scene (toon land/water/parks/subway/stations, camera
  limits, demand frameloop, PCFShadowMap object, context failure handling), lazy 3D chunk 268.3 KB gz
  via next/dynamic; integrated after S05c/S13/S05b/S10a (INT-4: CitySceneClient marks the map playable;
  ScenePlaceholder removed; one `__cloutcityTest` hook global; expectedConsole + injectedConsoleErrors).
  Specs wait for waitForMapSettled where they time other features. Dev gates: unit 2205, e2e 484 + 2
  load-timeout gesture loops (6/6 alone, FLAKE-4), shell 145.8 KB, 3D 268.3 KB.
- S15 (attempt 1, passed): data-driven goals (progression.json) with manual claims through one
  idempotent, audited, eligibility-checked grant function capped against the next goal (ECON-1:
  granted clout never counts toward goals), Icon victory modal with share fallback and two-step
  prestige, save v8. Rulings: DEC-13 Icon is earned (top level needs goal clout); DEC-14 prestige keeps
  outfits as looks only (0 clout/style/sell). Bug-hunter: HUD title at 390, double-claim/farming
  probes, prestige run 2 badge. Lane gates: unit 2376, integration 126, e2e 506 + 12 load timeouts
  (12/12 on re-run), shell 146.1 KB. Follow-ups: UX-8/11, SEC-9/10.
- S04c (attempt 1, passed): instanced pins with screen-space picking (>=44 px, chooser), DOM Places panel
  by borough, static SVG fallback and in-place context recovery, dimmed Bronx/SI with teaser pins.
  Bug-hunter: flights yield to gestures, auto panel never closes HUD panels, Places button state.
  Integrated through S05 (one-row HUD overflow at 390).
- S05 (attempt 1, passed): guest start centred on the Queens home (homes.json) with avatar placeholder,
  two-row HUD (HudFrame + HudLive boot island over a matching skeleton; More panel on narrow/short),
  per-game-minute store writes, game clock after attestation, free-row camera framing (setViewOffset),
  lazy anonymous Supabase auth + attest_and_consent with local fallback, OG/Twitter tagline meta,
  "Map data" corner chip (UX-9), e2e:supabase opt-in config. Bug-hunter: attribution no longer truncated
  at 390x480/320; ChunkLoadError counts as offline. Gates: unit 2638, e2e 602 + 24 load timeouts (green
  on re-run), shell 148.9 KB, 3D 273.7 KB.


## 2026-10-08 — Playable slice (v1) complete
- Merged into dev via integration/slice: S04b, S04d, S04e, S04f, S04g, S04h, S06, S07a, S08, S16, S18a, S18b, S18c (+ colour polish, slice-end fixes, QA fixes: home sleep/nap/meal, memorials never locked, prestige from Goals).
- Gates: unit 4750, e2e 866+146 rerun (only FLAKE-10 hud-live skeleton under load), e2e:dpl 30, integration 252, e2e:supabase 9; budgets boot 156.8/160, playable 542.1/550, precache 975.5/1000.
- Five slice-end bug-hunters (travel, SW, 3D, UI, save/economy) + qa-mafia; all blocking findings fixed; accepted LOWs: SEC-17, SEC-18.
- Learnings: build-first mode works but merges across many lanes need an integrator agent; anti-cheat pace must be derived from config (empirical bots keep missing routines); always cut lanes from the latest integration branch (lane F base mistake).
