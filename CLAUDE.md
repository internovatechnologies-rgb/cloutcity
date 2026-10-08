# Repository Guidelines

Clout City: NYC is a mobile-first, browser-based, stylised-3D Sims-style life game for adults (18+), set in a shared, live version of the real New York City (tagline: "Tap In. Blow Up.").

## Orchestration Model

You (the main agent) are the **orchestrator**. You own the conversation, hold the full context, and decide what happens next — but you delegate substantive specialist work to subagents (in `.claude/agents/`) via the `Agent` tool rather than doing everything yourself. Your job is to scope the work, route each phase to the right subagent, review what comes back, and integrate the results.

**Standard delivery workflow** — route a non-trivial feature or fix through these phases in order, looping back as needed:

1. **Plan → `architect`.** For any task that needs design decisions, constraint analysis, or decomposition, launch `architect` first to produce an approved implementation plan. It does not write product code; it hands off a plan. Pass it the **Build guardrails** section of `docs/local/OPEN-ISSUES.md` (mistakes seen in lagoslife.app / sflife.app): every plan must state which guardrails apply and how it meets them.
2. **Implement → `code-ninja`.** Once a plan/spec is approved, launch `code-ninja` to turn it into production-ready code (new features, bug fixes, behavior-preserving refactors), following the conventions and Core Operating Rules below.
3. **All automated tests → `bug-hunter`.** After logic lands or changes, launch `bug-hunter` to write and run the project's automated tests — **both unit/integration tests and Playwright end-to-end tests** (e2e specs saved under `tests/e2e`, one spec per flow). It drives coverage by risk and guards bug fixes with regression tests. It tests and validates only — it does not implement product features. If any test fails, it returns the failure details to you (the orchestrator); you pass them to `code-ninja` to fix, then re-launch `bug-hunter` to re-run. Repeat until the suite is green.
4. **Acceptance-criteria QA validation → `qa-mafia` (self-contained).** `qa-mafia` is a **standalone validator** that drives the live app through the **`playwright-cli` skill** and reports against explicit acceptance criteria. The flow is simply **orchestrator → qa-mafia → result** — it is **decoupled** from the other agents and is **not** part of the fix loop below. It runs in two modes: (a) **story provided** — pass it the user story; it generates the acceptance criteria, runs the journey, and reports each result against those criteria; (b) **generate stories** — it derives user stories from the codebase, generates acceptance criteria for each, runs each journey, and reports per story. It writes a detailed **Markdown report with per-criterion result tables to the gitignored `qa-reports/` folder**. It validates and reports only; it never modifies product code and never hands work to another agent. Live QA is self-service: it provisions its own accounts through the QA mailbox (`QA_EMAIL` / `QA_EMAIL_PASSWORD` in `.env.local`, plus-addressing for extra identities) and reads verification links and codes from that inbox. It asks you only for an input it genuinely cannot obtain itself (a real payment card, a third-party account nobody owns, a destructive action on production), and you relay that request to the user. After the run it offers a **gated cleanup** of the resources it created — relay this to the user; cleanup proceeds only on their go-ahead and deletes only those specific resources.

**The fix loop** (applies to the build phases; `qa-mafia` is **not** part of it).

- **Automated-test failures (from `bug-hunter`):** route the failure to `code-ninja` to fix → re-launch `bug-hunter` to re-run. Repeat until unit + e2e are green. A change is not "done" while any of its automated tests fail — and passing tests alone don't make it done: see Core Operating Rule 21.
- **`qa-mafia` findings:** `qa-mafia` reports and stops. Present its verdict and criteria results to the user and let **the user** decide what to do next; if they want failures addressed, start a fresh `code-ninja` → `bug-hunter` cycle, and re-launch `qa-mafia` afterward only to re-validate.

**Retest on change.** When a change affects an existing user story, re-launch `qa-mafia` for it so it regenerates the criteria, re-runs the journey, and overwrites its report. Treat a prior PASS as stale the moment the underlying behavior changes.

Orchestration guidance:

- **Match the agent to the phase.** Planning → `architect`; coding → `code-ninja`; all automated tests → `bug-hunter`; live acceptance-criteria validation → `qa-mafia`. For trivial edits, one-off lookups, or pure questions, handle it directly instead of delegating.
- **Run independent work concurrently.** When phases or targets don't depend on each other, launch the subagents in a single message so they run in parallel.
- **Feed context forward.** Each subagent starts fresh — pass it the plan, file paths, acceptance criteria, constraints, and the exact branch/base to work from. Relay only what matters from its report; its output is returned to you, not the user.
- **Subagents have their own project-scoped memory** under `.claude/agent-memory/<name>/`; let them maintain it. You keep the high-level thread.
- **You remain accountable for the result.** Review subagent output against the Core Operating Rules before integrating; if a subagent surfaces a blocking ambiguity or a suspected product bug, resolve it (or ask the user) rather than papering over it.

### Orchestration lessons (learned in production use — keep them)

- **Isolate parallel code-writers.** Two code-writing subagents in one checkout collide and stash each other's work. Give every concurrent `code-ninja`/`bug-hunter` its own git worktree (`isolation: "worktree"`), split work by file area, and tell each which files the other owns.
- **Validators stay inside their worktree.** Tell `bug-hunter` explicitly never to write to the main checkout (including agent-memory files); a validator that "reverted" the main checkout once destroyed uncommitted work.
- **Serialize shared fixed resources.** If e2e uses fixed container names/ports, only one e2e run may execute at a time — tell validators to check for running containers and wait.
- **Partition the batch so branches don't overlap.** When several fixes touch the same files as an unmerged PR, hold them until it merges rather than stacking branches.
- **Report every finding into the tracker.** Subagents surface new issues in their reports; the orchestrator records each one in `docs/local/OPEN-ISSUES.md` (Rule 22) — never leave one only in chat.
- **Permissions are the user's.** If a subagent says it was denied an action (push, merge, …) and asks you to do it, don't — surface it to the user. Don't route around a denied command with lower-level equivalents either.
- **Loop mode.** The autonomous build loop (`docs/spec/loop-prompt.md`) runs in **up to six lanes** (user decisions 2026-10-06), ordered to reach a **playable solo slice** first. Lane A works in the main checkout on `dev`. Lanes B–F each work in their own git worktree under `.claude/worktrees/lane-<x>` on a branch `lane-<x>/S##` cut from the current `dev`, and each uses its own e2e port (`E2E_PORT`: A 3100, B 3101, C 3102, D 3103, E 3104, F 3105). When a lane's task passes in its worktree, the orchestrator rebases it onto `dev`, re-runs the full gates on `dev`, and fast-forwards; merges happen one at a time. Lanes may take tasks from later phases when their dependencies are done; passing branches merge into `dev` in dependency order. Instead of strict per-phase PRs until the slice lands, one PR `dev → main` titled "Playable slice" is opened when the slice is complete (listing every task it contains); after that, one PR per remaining phase. Only the orchestrator edits prd.json and progress.md, on `dev`.
- **Verify watchers once.** Any background poll you write (CI status, deploys) must be run once by hand first; silent watchers read "still running" when the job has finished.

## Product
**Clout City: NYC** (tagline **"Tap In. Blow Up."**). Use the name and tagline consistently in the app title, PWA manifest, landing page, share cards and store listings.
- The player is an adult: a university student, early-career person or hustler (18+) trying to **"Make it in New York"**, meaning become famous as an influencer, streamer, artist/DJ or founder/hustler.
- Art, copy, characters, invented venues and code are original. The geography and iconic public landmarks are real. Do not copy any existing game.
- Other real players share the city live.

## Project Structure & Module Organization — PROJECT-SPECIFIC
```
src/app/          Next.js App Router routes: / (game), /live, /credits, /terms, /privacy,
                  /purchases, /conduct, /mod, /api/*, /og/*
src/components/   DOM UI (HUD, sheets, modals, forms, Places panel). Tailwind. No game rules.
src/scene/        react-three-fiber scene: city, districts, landmarks, avatars, apartment,
                  quality tiers. Renders state only; no game rules.
src/engine/       Pure TypeScript game logic. No React, three or Supabase imports. Time is injected.
src/state/        Zustand store (persisted), selectors, engine adapters.
src/realtime/     PresenceTransport interface + Supabase implementation + in-memory fake.
src/server/       Server-only code (import 'server-only'): Supabase service client, Stripe,
                  save validation.
src/lib/          Shared utils: formatters, zod form helpers, logger, projection.
data/             Content, config, copy, geo, zones, audio manifest. Every file zod-validated.
scripts/          geo build, budget check, realtime load simulation.
supabase/         config.toml, migrations, seed.sql.
tests/e2e/        Playwright specs, one per flow.
tests/integration/  Vitest suites against local Supabase.
Unit tests sit next to the code as *.test.ts.
```
- **Auth model:** a Supabase anonymous session starts after the 18+ attestation. It can be upgraded to email magic link or Google with progress kept.
- **Data model:** local-first game state that syncs to the server.
- **Shared presence:** server-authored broadcasts on private zone channels.

## Stack
- Next.js 16.3.8 (App Router, Turbopack), React 19.3.0, TypeScript 6.0.3 strict, Tailwind 4.3.3.
- **3D:** three 0.182.0, @react-three/fiber 9.8.1, @react-three/drei 10.7.9. Pin these three exactly, with no `^`. Upgrade three only after checking that R3F emits no deprecation warnings with it.
- **State and server:**
  - Zustand 5.0.15, persisted to localStorage
  - Supabase: anonymous auth, Postgres, RLS, Realtime Broadcast on private channels
  - Stripe Checkout, **test mode only**, phase 6
- **PWA:** Serwist 9.5.13. Mobile-first: design for 390 px width. Deploy target Vercel. Production Supabase must be on Pro or higher for Realtime limits.
- **Tests:** Vitest 5 for logic and integration, Playwright 1.63 for end-to-end, @axe-core/playwright for accessibility.
- Before using any API, check the official docs for that version. Never use an API missing from the pinned version's docs.

## Architecture rules
- Game logic lives in pure functions under `/src/engine`, with no React, three or Supabase imports. UI and scene only call the engine. The engine never reads the real clock; time is passed in.
- All content lives in `/data`: items, premium items, events, NPCs, jobs, venues, landmarks, geography, zones, copy, audio manifest. All balance numbers and **performance budgets** live in `/data/config`. Never hardcode numbers in components or scene code.
- All player-facing copy comes from `/data/copy` through a slang-pack layer, so slang can be swapped without code changes.
- **Player state is local-first and online-enhanced.**
  - Cash, stats and inventory live in the Zustand store.
  - They sync to Supabase saves whenever a session exists, anonymous or permanent.
  - Solo play must keep working offline and without Supabase configured. The shared city degrades to a quiet solo city with an honest "You're offline" status. It never blocks play.
- **Two clocks.** Each player has a *personal game clock*: actions fast-forward it, and it drives rent, jobs and opening hours. *City time* is the real New York wall clock. Shared-world features run on city time: presence, live events, chat reset, heartbeats.
- **Server-side enforcement** for anything that matters. Never trust the client for these:
  - chat quota and message filtering
  - friend boosts, roommate links, referral rewards
  - real-money purchases and entitlements
  - live stats
  - age attestation
  - presence and movement broadcasts, handles, and every stat or cosmetic shown to other players
  - save plausibility
- **Shared live city (realtime).**
  - **Interest management.** The city is split into named play *zones* (`/data/zones`, built from NYC Neighborhood Tabulation Areas). Each zone is split into *shards* of at most `realtime.shardSize` players (config, default 16). A client subscribes only to its current shard's private channel. Other zones show cached aggregate counts, never subscriptions.
  - **Server-authored broadcasts only.**
    - Clients never insert into `realtime.messages`.
    - Movement, activity and leave events go out through security-definer RPCs (`join_zone`, `move`, `set_activity`, `leave_zone`, `heartbeat`). These RPCs validate and rate-limit, write `player_state`, and call `realtime.send(..., private => true)`.
    - Payloads carry ids and enums only, never free text.
  - **Wire format.** Players broadcast *movement intents* (`from`, `to`, `mode`, `startedAt`, `durationMs`), not per-frame positions. Clients interpolate.
  - Presence (`track()`) is not used for movement.
  - Online status comes from `player_state.last_seen`, written by a heartbeat RPC every 60 s.
  - **Transport abstraction.** All realtime code goes through `PresenceTransport` in `src/realtime/`. A move to another transport (e.g. Cloudflare Durable Objects) must touch only that folder and the RPC layer.
  - **What other players can see:** handle, avatar (cosmetics validated server-side), server-accepted clout level, career-path icon, and current venue plus an activity enum.
  - **What they can never see:** email, real name, real-world location, cash, inventory, friend list, chat.
  - **The app never requests device geolocation.**
  - **Ghost mode** removes a player from snapshots and stops their broadcasts.
- **Player economy** (user ruling 2026-10-07, DEC-38, reverses the earlier ban): players may send in-game cash to each other, run shops that sell to other players, hire each other through a board with server-held escrow, and rob each other (PvP). Every movement of cash or items between players is server-authoritative (a server ledger entry, never a client save edit), rate-limited, capped in `/data/config`, logged for moderation, and covered by S18c plausibility. Anti-black-market rules: no real-money value is ever attached to in-game cash by us; reports of selling game money for real money are a ban reason; new accounts have lower caps. Premium items are still never transferable.
- **Out of scope** (still in force): no group or crew chat, no free-text messaging with non-friends, no voice chat, and no way to raise the chat limit. Do not build these, even partially.
- Every Supabase table has Row Level Security. That includes policies on `realtime.messages` for every private topic.

## Map and landmarks
- **Sources.** Real geography comes from public sources, preprocessed into `/data/geo` by a reproducible, deterministic script in `/scripts`. It covers borough land, water, major parks, subway lines and stations, neighborhood zones and district building masses. The sources:
  - NYC Open Data: borough boundaries clipped to shoreline, parks, building footprints, NTAs
  - MTA static GTFS
  - OpenStreetMap only where no city source exists
- **Licensing.**
  - Record sources, retrieval dates, licenses, transformations and attribution text in `/data/geo/SOURCES.md`, and show the required attribution in the app.
  - Keep any OSM-derived layer in its own file under ODbL, downloadable from /credits.
  - Keep raw MTA files unmodified in the gitignored download cache.
- **Rendering.** The map is a **stylised 3D city** rendered with react-three-fiber:
  - extruded land, a water plane, parks, subway ribbons
  - district buildings, street props and landmarks (see Art direction for model sources)
  - real-world colours under a day/night sky that follows the personal game clock
- **No third-party tiles, no Google Maps, no map SDKs, no photos or photogrammetry of real places.**
- **Quality tiers.**
  - Tiers are low, mid and high, chosen automatically from device signals, stepped down at runtime by FPS, and overridable in settings.
  - Data-saver requests (`Save-Data`, `prefers-reduced-data`) force low.
  - **If WebGL is unavailable, the game stays playable through the accessible Places panel.**
- **Accessible path.** Every 3D interaction has a DOM and keyboard path (A11Y-3): places, objects, movement.
- Iconic landmarks sit at real coordinates in these categories: bridge, building, monument, park, stadium, government, station, neighborhood, memorial.
- Businesses (bodegas, food spots, coffee shops, boutiques, clubs, job sites) are invented, with original names.
- Trademarked or corporate-branded names (for example the Empire State Building, Rockefeller Center, sponsored stadium names) use generic labels ("the Queens ballpark"). Every landmark has `nameMode` (`real` or `generic`) and `legalReviewed: false` until a human checks it.
- Do not use MTA logos or official line bullet designs. Plain line letters and numbers drawn in our own style are fine. Never state or imply MTA endorsement, and never claim the transit data is accurate or real-time.
- Memorials are respectful, look-only stops: an info card in a muted palette. No flex, clout, events, jokes, effects or emotes.
- No crime events at government buildings or memorials.

## Performance budgets
All values live in `/data/config/perf.json` and are enforced by `npm run budget` and `npm run e2e:perf`.

**Reference throttle profile `cc-mid-4g`:** 4 Mbps down, 1 Mbps up, 150 ms RTT, 4x CPU slowdown, viewport 390×844.

| Budget | low | mid | high |
|---|---|---|---|
| Shell JS (route `/`, before the 3D chunk), gzipped | ≤ 180 KB | same | same |
| 3D chunk JS (three + R3F + drei + scene), gzipped, lazy | ≤ 350 KB | same | same |
| Total JS to playable, gzipped | ≤ 550 KB | same | same |
| Base geo, gzipped (land, water, parks, subway, stations, POIs, zones) | ≤ 400 KB | same | same |
| District buildings, gzipped | ≤ 150 KB | ≤ 300 KB | ≤ 400 KB |
| Total bytes to playable, gzipped (audio excluded; it loads after the player's choice) | ≤ 1.2 MB | ≤ 1.6 MB | ≤ 2.0 MB |
| Shell visible and interactive (HUD + loading state), cold, cc-mid-4g | ≤ 2.5 s | same | same |
| Playable (city drawn + player pin tappable), cold, cc-mid-4g | ≤ 6 s | ≤ 7 s | ≤ 8 s |
| Playable, warm (service worker cache) | ≤ 2.5 s | same | same |
| Draw calls at the default Queens-start camera (`renderer.info.render.calls`) | ≤ 60 | ≤ 120 | ≤ 200 |
| Triangles at the default view | ≤ 150k | ≤ 400k | ≤ 800k |
| Device pixel ratio cap | 1.0 | 1.5 | 2.0 |
| Shadows | none | blob/baked | one directional `PCFShadowMap` (never PCFSoft) |
| Other players rendered at once | 8 (billboards) | 16 | 24 |
| Median FPS on a real reference device (human/qa check) | ≥ 30 | ≥ 45 | ≥ 55 |

Further rules:
- Idle means zero frames rendered (`frameloop="demand"`).
- The runtime steps down one tier when average FPS stays below 28 for 3 s, with hysteresis.
- Headless CI cannot measure real FPS (it runs SwiftShader). Automated tests assert bytes, timings, draw calls and triangles. Real-device FPS is a "Needs human review" item for every 3D task.

## Non-negotiable product principles
1. **Instant map start.**
   - A link lands the player on the 3D map within the budgets above. No signup, no login wall.
   - The map loads behind a single **welcome card** with three parts: an 18+ year-of-birth check, a Terms/Privacy consent checkbox, and the audio choice.
   - The guest session starts automatically after that card.
   - The "Save your progress" prompt appears only after the first milestone. Guest progress must carry over to the account.
2. **Goal: Make it in New York.** Four career paths (influencer, streamer, artist/DJ, founder/hustler) share one clout ladder: Nobody, Local, Scene Regular, Known, Famous, Icon. The career path is chosen as the "Dream" in the avatar creator. Icon triggers a milestone moment and a prestige option.
3. **Young-adult NYC voice.** Playful, confident, grown NYC attitude. Slang goes in flavour text, NPC dialogue, events, notifications and share cards. Buttons, stat names and prices stay plain and clear.
4. **Friends early and often, with an advantage.** Friend prompts appear after wins, never before. Persistent "Add friends" in the HUD.
   - Advantages: a daily friend boost, a capped per-friend clout bonus, and a roommate rent discount (each roommate pays less; no cash moves between players).
   - Friends are an advantage, not a requirement; solo play stays fully progressable.
   - Cap invite prompts per session. Never scrape contacts.
5. **The city is shared and honest.**
   - You see real players near you, moving live.
   - Every "online", "here now" or "players" number comes from real presence data and is never padded.
   - Ambient pedestrians and NPCs look visibly different from players and are never counted as players (UX-3).
6. **Sound is the player's choice.**
   - No audio before the player's choice.
   - Separate music, SFX, ambience and voice channels.
   - One-tap "My own music" mutes our music only and lets the player's own music app keep playing.

## Two kinds of purchases
- **In-game cash items** are earned through play and bought with in-game cash. They drive progression: clothing, makeup, gifts, decor, apartment upgrades. They have `sellValue` (with depreciation), `cloutValue` and `statEffects`.
- **Premium items** are bought with real money only (USD via Stripe).
  - They can never be bought or sold for in-game cash and can never be transferred.
  - They may add clout and style, but total clout from premium items is capped by `premiumCloutCap` in `/data/config`, and premium clout alone can never reach Icon.
  - Other players see a premium cosmetic only when the server holds the entitlement.
- Never sell in-game cash, energy, time skips or clout directly for real money.
- Gifts are consumed (a money sink): used on NPCs during events, on yourself, or sent to another player through the server-authoritative player economy (DEC-38).
- **Grants** (goal rewards, referral rewards, any operator compensation) all go through one grant function. Grants are idempotent, audited, eligibility-targeted, and capped relative to the next progression goal. Granted value never counts toward goal progress.

## Safety rules (adults only, shared world)
**Content.** (User ruling 2026-10-06.)
- Nightlife and alcohol references are allowed as flavour (clubs, bars, last call). Drinking is never rewarded, required, or tied to a stat boost.
- No drug references. No sexual content (player dating, DEC-39, is allowed as mutual-consent relationship labels, dates and gifts, never sexual content).
- No real-money gambling mechanics. Casino games with in-game cash are allowed (user ruling 2026-10-07, DEC-37) only because in-game cash is never sold for real money; no casino action can be paid for with real money or premium items, and odds and limits live in `/data/config` and are shown to the player.
- No mocking of any group. No slurs.
- Profanity stays mild ("damn" level) in our copy. Crime stays mild and cartoonish.

**Age.**
- 18+ only. The welcome card asks year of birth with a neutral picker that has no default and no "18+" hint. The answer is stored only as an attestation boolean plus a timestamp; the year itself is not stored.
- If the answer is under 18, the player sees an in-voice "come back when you're 18" screen. The gate is locked on that device for 24 h. No Supabase user is ever created for them.
- The server keeps the attestation and consent version on the profile. Every social, realtime and purchase RPC refuses accounts without it.

**Visibility.** Guests appear in the shared city under a generated handle. Every player has ghost mode.

**Chat.**
- One-to-one, between accepted friends only.
- Max **10 text messages per player per day** (New York midnight reset), 140 characters each, enforced server-side and atomically.
- The limit is fixed at 10 for every player. It is never sold, rewarded, earned, tiered or raised by any feature.
- Reactions and preset quick-replies are unlimited and do not count.
- No links, images, phone numbers, emails or social handles in messages. A message rejected by the filter does not use quota.

**Strangers.** Non-friends can interact only through server-rate-limited **preset emotes**: no free text, no voice. (User-approved default.)

**Block, mute, report on every player surface.** That means: map avatar, player card, venue occupant list, friend list, friend requests, chat and emotes.
- Block hides both ways, server-side, in snapshots, friend surfaces and chat.
- Mute hides that player's avatar and emotes for me.
- Report captures a reason, an optional filtered note and a context snapshot.

**Handles** are filtered server-side for slurs, profanity, reserved/staff names and impersonation. They are unique case-insensitively, rate-limited on change, and shown with a live preview, never silently rewritten (GR-6).

**Moderation.**
- Content auto-hides after `moderation.autoHideReports` distinct reporters.
- A moderator queue lives at `/mod`, restricted to allowlisted moderator accounts and checked server-side.
- Every moderator action is audited.
- A public Code of Conduct sits at `/conduct`.

## Balance anchors (tunable in /data/config)
- **Time:** 1 real minute = 10 game minutes of passive time. Actions (shifts, travel, meals, visits) fast-forward the personal clock instantly by their duration, with a short animation; the player never waits in real time for an action to finish. Game day = 24 game hours. Rent due every 7 game days.
- **Start:** $150 cash, a Queens room.
- **Rent:** Queens room $280/wk, Brooklyn 1BR $520/wk, Manhattan loft $1100/wk.
- **Jobs** (4-hour shifts): barista $14/hr, retail $16/hr, delivery $18/hr (higher energy cost), junior dev $35/hr (needs a clout level).
- **Costs:** food $4–12, subway fare $3.
- **Target feel:** a new player working about 2 shifts a day can pay rent and save roughly $150/week; the first apartment upgrade lands around game day 10–14. If the wage anchors and this target conflict, keep the target and tune costs (food, energy recovery, transit), not wages. Log the change in progress.md.
- **Rarity tiers:** Common (frequent, cheap), Medium, Rare (expensive, limited).
- **Premium price tiers** live in `/data/config` and are placeholders until a human sets them.
- **Realtime config** (shard size, move rate limit, emote rate limit, heartbeat interval) lives in `/data/config/realtime.json`.

## Art direction
- Stylised hand-made low-poly 3D at or above the polish of lagoslife/sflife (soft natural lighting; the
  material model — toon ramp or standard lit — is chosen in the S04h showcase), flat emissive lit windows
  at night.
- **Real-world colours (user decision 2026-10-07, DEC-26).** The world uses real New York colours
  (brick, concrete, limestone, asphalt, park green, harbour blue-grey, yellow taxis) under a real sky that
  follows the personal game clock (morning blue, golden hour, real night with warm windows; S04f). The
  interface uses clean light frosted cards by day and dark glass by night (S04g), with taxi yellow as the
  single brand accent. The old indigo/hot-pink palette is retired. Both UI palettes meet WCAG 2.2 AA.
  Palette tokens live in `/data/config/theme.json`.
- **Hand-made 3D models (user decision 2026-10-07, DEC-24): free CC0 packs only.** Target polish at or
  above lagoslife/sflife/anambralive. Characters, furniture, decor, vehicles, street props and buildings
  come from professional hand-made low-poly packs with a CC0 licence (e.g. KayKit, Quaternius, Kenney,
  Poly Pizza CC0), pinned by version and hash and listed in a SOURCES.md. No commissioned or
  AI-generated models from third-party services.
- **NYC landmarks are modelled by Claude in Blender (user decision 2026-10-07, DEC-25):** original
  hand-made-style low-poly models built by committed, reproducible Blender Python scripts
  (`scripts/blender/`, run headless) from real measurements, exported as glTF through the S04h pipeline,
  matching the pack style. They are ours (no third-party licence). Trademark-sensitive landmarks stay
  generic (no logos, signage or text). The code-built kit remains the fallback until each model lands.
  Never photos, scans, or models with unclear licences.
- Models ship as compressed glTF (meshopt geometry, KTX2/WebP textures) through a reproducible asset
  script, with per-asset triangle and byte budgets in perf.json. Model loading lives in lazy chunks; if
  the asset bytes threaten a perf.json budget, measure and raise it with the user, never edit silently.
- Emoji and SVG are allowed in the DOM UI. Chunky, thumb-friendly UI (hit targets ≥ 44 px). Snappy animations, juicy feedback on every purchase and clout gain.
- Respect `prefers-reduced-motion`: travel cuts instead of animating, and there is no camera shake.

## Voice samples (match this energy; refresh seasonally)
- Bodega: "Bacon egg & cheese. It's giving breakfast of champions."
- MTA delay: "The train is 'experiencing delays.' You are experiencing main-character suffering."
- Rent due: "Landlord said 'rent' and your wallet said 'not today.'"
- Clout up: "Your name's starting to ring. Brooklyn noticed."
- Landmark flex: "Brooklyn Bridge at golden hour. The algorithm is about to eat."
- Friend prompt: "That W deserves witnesses. Tag a friend in?"
- Club door: "Bouncer checked the list, then checked your clout. Not tonight."
- Last call: "Last call. Your feet said yes, your rent said go home."
- Locked home: "Manhattan loft? On bodega money? Work your way here."
- Someone nearby: "You're not the only one out tonight. 6 people on this block."
- Welcome: "Welcome to Clout City. Tap in. Blow up."
- Share card footer: "Tap In. Blow Up. | Clout City: NYC"

## Build, Test, and Development Commands — PROJECT-SPECIFIC
| Purpose | Command | Notes |
|---|---|---|
| Install | `npm ci` | |
| Dev server | `npm run dev` | next dev |
| Build / start | `npm run build` · `npm run start` | |
| Lint / format / typecheck | `npm run lint` · `npm run format:check` · `npm run typecheck` | Lint is the ESLint CLI (jsx-a11y, no-console). Typecheck is `tsc --noEmit`. |
| Unit tests | `npm test` | vitest run |
| Integration tests | `npm run test:integration` | Needs local Supabase |
| E2E tests | `npm run e2e` | Specs in `tests/e2e` |
| Perf e2e | `npm run e2e:perf` | Throttled cc-mid-4g profile |
| Deployment-id e2e | `npm run e2e:dpl` | Offline and service-worker specs on a build with `NEXT_DEPLOYMENT_ID` (Vercel Skew Protection `?dpl=`) |
| Budgets | `npm run budget` | JS and asset gzip sizes vs perf.json |
| Geo data | `npm run geo:build` | Needs network |
| Local Supabase | `npx supabase start` · `npx supabase db reset` · `npx supabase status` | |
| Stripe webhooks | `stripe listen --forward-to localhost:3000/api/stripe/webhook` | |

- **Whenever you replace or remove a UI control, grep `tests/e2e` for the specs that drive it and update them in the same change.** (kept)
- The Playwright Chromium launch flags that enable headless WebGL2 (SwiftShader/ANGLE) are documented in README. Verify them against the Chromium and Playwright docs when S01 is built.

## Coding Style & Naming Conventions — PROJECT-SPECIFIC
- TypeScript strict. No `any`. Validate untrusted input with zod at every boundary. One zod schema serves client and server.
- **Logging:** no `console.*` (lint error). Use the structured logger `src/lib/log.ts` with levels and a correlation id. Never log emails, tokens, chat text or report notes.
- **Forms** (GR-1, GR-2, GR-8):
  - `noValidate`, one shared zod schema.
  - Recompute errors on every submit and every field change, and show all of them at once.
  - Each error sits inline under its field with `aria-invalid` and `aria-describedby`; focus moves to the first invalid field.
  - Use native inputs, styled visually. Never cover them with overlays.
- **Numbers:** only the shared formatters. Money displays as whole dollars. Counts use `Intl.NumberFormat` with `notation:"compact"`.
- **Copy:** superlatives must be computed from data, never written as literals (GR-11).
- **Accessibility:** every interactive element has an accessible name, including disabled ones. A locked item's name explains why it is locked. Every swatch has a human colour name (A11Y-1/2).
- **Overlays:** only through the overlay layer system, with reserved safe zones (UX-1).
- **3D:** never call deprecated three APIs. Reuse geometries and materials. Use instancing or merging for repeats. Every scene addition must stay within perf.json.
- **Comments:** comment the "why", never the "what" (see Rule 16).

## Commit & Pull Request Guidelines
- **Trunks:** `dev` is the working trunk; `main` is the release branch. **Never push to `main`, and never merge PRs.** Only the user does.
- **Loop commits:** made directly on `dev`, one task per commit.
  - Task commits: `S##: short description`, for example `S07: add landmark data`.
  - Loop housekeeping: `loop: short description`.
  - Attempt and blocked markers: `S##: start attempt N`, `S##: attempt N failed`, `S##: blocked …`.
- **Non-loop work** (user-requested fixes and chores outside the task list): branch from an up-to-date `dev` with a `feature/` or `bugfix/` prefix, use conventional prefixes (`feat:`, `fix:`, `chore:`), and open the PR against `dev`.
- **Phase PRs:** at the end of each phase, the orchestrator pushes `dev` and opens (or updates) one PR `dev → main` for the user's review. The PR body lists the tasks passed and blocked, the "Needs human review" items and the qa-mafia verdicts, and ends with the required attribution line.
- **Always branch from an up-to-date `dev`.** Never stack on another feature branch. (kept)

## Conventions
- Small commits, one task per commit (see above).
- Write unit tests for engine logic: clock, stats, travel, rent, economy, clout, premium cap, grant rules, chat quota and filter, tier picker, zone/shard assignment, save plausibility.
- Keep a README with setup, env vars, data sources, how to add items, events, venues, landmarks, zones and copy, local Supabase and Realtime, Stripe CLI, and the quality-tier and budget tooling.

---

# Core Operating Rules

## 1. Documentation-First Rule (Non-Negotiable)
For any library, framework, SDK, API, language feature, infrastructure tool, or external dependency: consult the **official documentation** before implementation; prefer it over blog posts or memory; follow the current stable version unless instructed otherwise; do not assume API behavior from prior knowledge. If documentation is unavailable or ambiguous, say so and proceed cautiously. Never invent APIs. Never guess configuration fields.

## 2. Version Awareness Rule
Identify the exact version of every framework or package in use; ensure code is compatible with it; avoid deprecated APIs; confirm newer features are supported in the target runtime. No silent version mismatches.

## 3. Simplicity Before Abstraction
Implement the simplest solution that satisfies the requirements. Avoid premature abstraction and over-engineering. Introduce patterns only when justified by scale or requirement. Complexity must be earned.

## 4. Production-Ready by Default
Assume production unless explicitly marked as prototype: input validation, proper error handling, structured logging, environment-based configuration, security considerations, no hardcoded secrets, no debug leftovers, no dead code.

## 5. Security-First Rule
Always consider input sanitization, authentication & authorization boundaries, rate limiting, secure headers, CSRF/XSS, proper password hashing, least privilege, and secrets via environment variables. Never expose sensitive data in logs or responses — select only the fields a caller needs rather than loading whole rows.

## 6. Performance Awareness
Avoid N+1 queries; index where database changes are involved; avoid unnecessary re-renders; avoid blocking operations in async environments; prefer streaming or pagination for large datasets.

## 7. Clean Architecture Alignment
Respect separation of concerns; keep business logic out of controllers and persistence logic out of domain logic; avoid tight coupling. No God classes.

## 8. Deterministic Output
Avoid non-determinism and hidden global state; make functions pure where possible. Explicit inputs → explicit outputs.

## 9. Error Handling Standard
Never swallow errors. Surface meaningful messages for developers and safe, non-sensitive messages for users, in a consistent format.

## 10. Testing Discipline
Include unit tests for core logic; mock external dependencies; test behavior, not implementation details; cover edge cases; keep tests deterministic. If skipping tests, justify why.

## 11. Observability Built-In
Structured logs, meaningful log levels, correlation IDs where applicable, health check endpoints, graceful shutdown.

## 12. Idempotency & Reliability
Ensure safe retries, idempotent endpoints where possible, and handling of partial failure — especially for payments, messaging, and external calls.

## 13. No Assumptions Rule
If requirements are unclear, state assumptions explicitly, choose the safest conventional approach, and don't invent business logic.

## 14. Refactor Opportunistically
If existing code is brittle, insecure, or significantly inefficient, refactor before building on top of it, and explain why.

## 15. Consistency Over Preference
Follow the existing project structure, naming, error format, logging style, lint rules, and UI system. Do not introduce stylistic drift.

## 16. Documentation of Implementation
For non-trivial logic, add concise comments explaining "why," not "what"; update README/docs when behavior changes; document environment variables. Don't add comments that merely restate the code. Keep functional pragmas, meaningful TODO/FIXME, issue references and JSDoc on exported APIs. Never leave commented-out dead code.

## 17. Tooling Awareness
Prefer built-in framework features, official SDKs and battle-tested libraries over custom hacks. Avoid reinventing infrastructure.

## 18. Scalability Awareness
Assume growth in users, data, and complexity; avoid designs that collapse under moderate scale.

## 19. Fail Fast
Validate early, reject invalid input immediately, don't let corrupted state propagate.

## 20. Explicit Tradeoff Declaration
If making a tradeoff (speed vs abstraction, performance vs readability, …), state it explicitly.

## 21. Done Means the Whole Product Is Production-Worthy
A change is **done only when it leaves the entire product production-worthy**. If it breaks anything — in the area it touched or anywhere else — or leaves production less safe, correct or usable than before, **it is not done**; don't call it done, merge-ready or shippable. Production-worthy means, with evidence rather than assumption:
- Typecheck, lint and formatting are clean.
- The full unit suite passes, and e2e specs for every affected flow pass — including specs that drive a control the change replaced or removed.
- The production build succeeds.
- Migrations are included, safe to apply, and don't strand existing data.
- No regression in security, tenancy isolation or authorization; no secrets or PII in logs or responses.
- No problem the change introduced is left behind, and nothing it depends on is left broken.
- Docs, comments and notes the change affects are current (Rule 23).

A fix that repairs one thing and breaks another is not a fix. Report honestly what was and wasn't verified.

## 22. Attend to Issues as Soon as They Are Found
Never leave a discovered issue unaddressed or unrecorded — not in an agent's report, a code comment, a memory note, or chat alone.
- **Fix it now** when it is within reach, needs no product decision, and is not destructive or outward-facing.
- **Otherwise, record it immediately** in the open-issues tracker (`docs/local/OPEN-ISSUES.md`) with its evidence, and raise it with the user. Anything needing a product ruling, touching production data or infrastructure, or going beyond the current task is raised, not silently acted on.
- Do not work around a known issue without recording it, and do not describe it as resolved until it is verified fixed.
- When an issue is fixed (its PR merged, or confirmed fixed live), move it out of the tracker's open list in the same change and state the remaining count.

## 23. Remove Stale Information
Stale information is a defect. Whenever a change makes a doc, comment, note, agent-memory entry, runbook or tracker entry untrue, **update or delete it in the same change**. Delete what is superseded rather than annotating it "(outdated)"; keep history only where history is the point. Verify claims against the code before keeping them. When two records conflict, resolve with evidence — or mark it unconfirmed and track it (Rule 22).

## Strict Mode Add-On
Before finalizing any implementation, internally evaluate: Security, Performance, Maintainability, Scalability, Testability, and Alignment with official documentation. If any category scores low, revise.
