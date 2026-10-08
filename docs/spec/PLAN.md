> **Status (2026-10-06):** approved with defaults. The audience is **adults only (18+)**, checked on first open (the user's ruling, after a brief all-ages detour that was reverted). This plan's 18+ design is current. The source of truth is `CLAUDE.md`, `prd.json` and `progress.md`; this file is the architect's reasoning.

# Clout City: NYC: revised spec and build plan (architect, read-only)

This plan is ready for the user to approve. The orchestrator writes the files afterwards: CLAUDE.md, the root `prd.json`, the root `progress.md` and `docs/spec/loop-prompt.md`. The originals stay in `docs/spec/original/`. No product code was written and nothing in the repo was modified.

## 0. Objective, context and things I checked

**Objective.** Rewrite the standing rules, the task list (prd.json), the progress log and the loop prompt so the autonomous loop can build the game as DEC-1 and DEC-3 to DEC-6 now define it:
- a stylised 3D city on real NYC geography
- 18+ only
- a shared live city
- "My own music" mode
- one commit per task on `dev`, and a PR from dev to main at the end of each phase

Every guardrail from `docs/local/OPEN-ISSUES.md` (GR-1 to GR-13, ECON-1, A11Y-1 to A11Y-3, UX-1 to UX-3, PERF-1) is mapped to a task with a testable acceptance clause.

**Repo state.** Branch `dev`, one commit `a2bc1e2 chore: initial setup`. `CLAUDE.md` has uncommitted edits. There is no product code.

Two facts the plan depends on:
- **`docs/local/` is gitignored.** That means OPEN-ISSUES.md never reaches a PR. The loop must also put a one-line pointer to each new issue in `progress.md`.
- **Placeholders are still unfilled** in two agent files:
  - `.claude/agents/bug-hunter.md` line 17: `{{E2E_DIR}}`
  - `.claude/agents/qa-mafia.md` lines 25 and 45: `{{APP_SOURCE_PATHS}}`, `{{QA_ENV_FILE}}`, `{{QA_EMAIL_VAR}}`, `{{QA_EMAIL_PASSWORD_VAR}}`

**Versions checked on 2026-10-06 (Rule 1/2).** I read the npm registry and the official docs. Four things matter for the build:

| Package | Latest stable | **Pin** | Why the pin differs from latest | Docs |
|---|---|---|---|---|
| next | 16.3.8 (Node >=20.9) | 16.3.8 | — `next lint` was removed in Next 16: use the ESLint CLI. Turbopack is the default bundler. | https://nextjs.org/docs (doc version 16.3.8), https://nextjs.org/blog |
| react / react-dom | 19.3.0 | 19.3.0 | R3F's peer range is `>=19 <19.4` | https://react.dev |
| @react-three/fiber | 9.8.1 | 9.8.1 | — | https://r3f.docs.pmnd.rs/ ; https://r3f.docs.pmnd.rs/advanced/scaling-performance |
| @react-three/drei | 10.7.9 | 10.7.9 | — | https://drei.docs.pmnd.rs/ |
| **three** | 0.186.1 | **0.182.0** (with @types/three 0.182.0) | **R3F 9.8.1 still calls `new THREE.Clock()` and defaults shadows to `PCFSoftShadowMap`.** I checked the published source. three marks `Clock` deprecated since r183 and `PCFSoftShadowMap` deprecated since r186. With three ≥0.183 you get exactly the console warnings both competitors ship (PERF-1). 0.182.0 is the newest release with neither warning. Re-check when R3F updates. | https://threejs.org/docs/ , https://github.com/mrdoob/three.js/releases |
| **typescript** | 7.0.2 | **6.0.3** | typescript-eslint 8.71.1 only supports TypeScript `>=4.8.4 <6.1.0` | https://www.typescriptlang.org/docs/ |
| **eslint** | 10.12.0 | **9.39.5** (maintenance) | eslint-plugin-jsx-a11y 6.10.2 only supports ESLint up to ^9 | https://eslint.org/docs/latest/ |
| eslint-config-next / typescript-eslint / jsx-a11y | 16.3.8 / 8.71.1 / 6.10.2 | same | — | |
| tailwindcss | 4.3.3 | 4.3.3 | CSS-first config | https://tailwindcss.com/docs |
| zustand | 5.0.15 | 5.0.15 | | https://zustand.docs.pmnd.rs |
| zod | 4.6.5 | 4.6.5 | | https://zod.dev |
| vitest (+ vite 8.3.3) | 5.0.3 | 5.0.3 | | https://vitest.dev |
| @playwright/test | 1.63.0 | 1.63.0 | | https://playwright.dev/docs/intro |
| @axe-core/playwright | 4.13.0 | 4.13.0 | | |
| @supabase/supabase-js / @supabase/ssr | 2.117.2 / 0.12.7 | same | | https://supabase.com/docs |
| supabase (CLI as an npm devDependency) | 2.119.0 | 2.119.0 | This replaces the missing global Supabase CLI | https://supabase.com/docs/guides/local-development |
| @serwist/next / serwist | 9.5.13 | 9.5.13 | The Next.js PWA guide names Serwist for offline support | https://nextjs.org/docs/app/guides/progressive-web-apps |
| stripe (node) / @stripe/stripe-js | 23.0.0 / 10.0.0 | same | Current Stripe API version is `2026-09-30.endive`. stripe-node pins the API version current at its release, so match the webhook endpoint version to it. | https://docs.stripe.com/payments/checkout , https://docs.stripe.com/api/versioning |

**Supabase Realtime facts** (https://supabase.com/docs/guides/realtime/limits, https://supabase.com/pricing, https://supabase.com/docs/guides/platform/manage-your-usage/realtime-messages):

| Limit | Free | Pro (spend cap on) | Pro (no spend cap) / Team |
|---|---|---|---|
| Concurrent connections | 200 | 500 | 10,000 |
| Messages per second | 100 | 500 | 2,500 |
| Channel joins per second | 100 | 500 | 2,500 |
| Presence messages per second | 20 | 50 | 1,000 |
| Channels per connection | 100 | 100 | 100 |
| Broadcast payload | 256 KB | 3 MB | 3 MB |
| Included messages per month | 2M | 5M, then $2.50 per million | |
| Included peak connections | 200 | 500, then $10 per 1,000 | |

Other Supabase facts the design relies on:
- **Billing:** a broadcast to N subscribers counts as N+1 messages.
- **Presence docs:** do not call `track()` rapidly; use Broadcast for high-frequency updates.
- **Private channels:** gated by RLS on `realtime.messages` using `realtime.topic()` and `extension`. Policies are cached per connection.
- **Server broadcasts:** `realtime.send(payload, event, topic, is_private)` works from the database.
- **Anonymous sign-in:** limited to 30 requests per hour per IP. Supabase strongly recommends a CAPTCHA (Turnstile).
- **Free projects** pause after one week without activity.

**Alternative transport.** Cloudflare Durable Objects (https://developers.cloudflare.com/durable-objects/platform/pricing/): outgoing WebSocket messages are free and incoming ones are billed 20:1.

**Legal sources:**
- OSM (https://osmfoundation.org/wiki/Licence/Attribution_Guidelines): games must credit "OpenStreetMap" with a link to openstreetmap.org/copyright, legibly (splash, in-game or credits). A substantial extract is a Derivative Database and must be offered under ODbL.
- MTA developer terms (https://www.mta.info/developers/terms-and-conditions): host the data on your own server, do not imply endorsement, do not claim the data is accurate, and "**You will not modify or delete any of the data**". That last clause conflicts with simplifying GTFS shapes; see Risks.

---

## 1. Revised standing rules: replacement text for CLAUDE.md

Each change is tagged **[CHANGED: reason]** or **[NEW: reason]**. Anything untagged is the original text, kept as is.

Header edits:
- Delete the template comment at the top (Rule 23).
- Line 1 becomes: **Clout City: NYC is a mobile-first, browser-based, stylised-3D Sims-style life game for adults (18+), set in a shared, live version of the real New York City (tagline: "Tap In. Blow Up.").**

The Orchestration Model and Core Operating Rules 1 to 23 stay. Fill their placeholders:
- E2E_DIR = `tests/e2e`
- QA_ENV_FILE = `.env.local`
- QA_EMAIL_VAR = `QA_EMAIL`
- QA_EMAIL_PASSWORD_VAR = `QA_EMAIL_PASSWORD`
- TRUNK_BRANCH: see Commit & PR below

Add one paragraph under "Orchestration lessons":
> **Loop mode.** The autonomous build loop (`docs/spec/loop-prompt.md`) runs one task at a time, serially, directly on `dev`. It uses no worktrees and no parallel code-writers. In loop mode the orchestrator approves architect plans within the acceptance criteria and these rules. Anything needing a product ruling uses the recorded default in progress.md "Open rulings", or blocks the task. Subagents in loop mode never commit, push, or edit `prd.json`, `progress.md`, `CLAUDE.md` or any acceptance text.

### Product
**Clout City: NYC** (tagline **"Tap In. Blow Up."**). Use the name and tagline consistently in the app title, PWA manifest, landing page, share cards and store listings.
- The player is an adult: a university student, early-career person or hustler (18+) trying to **"Make it in New York"**, meaning become famous as an influencer, streamer, artist/DJ or founder/hustler. **[CHANGED: DEC-4. The audience is now 18+.]**
- Art, copy, characters, invented venues and code are original. The geography and iconic public landmarks are real. Do not copy any existing game.
- Other real players share the city live. **[NEW: DEC-5]**

### Project Structure & Module Organization — PROJECT-SPECIFIC
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

### Stack **[CHANGED: DEC-3 and DEC-5. Versions are pinned per Rule 2.]**
- Next.js 16.3.8 (App Router, Turbopack), React 19.3.0, TypeScript 6.0.3 strict, Tailwind 4.3.3.
- **3D:** three 0.182.0, @react-three/fiber 9.8.1, @react-three/drei 10.7.9. Pin these three exactly, with no `^`. Upgrade three only after checking that R3F emits no deprecation warnings with it.
- **State and server:**
  - Zustand 5.0.15, persisted to localStorage
  - Supabase: anonymous auth, Postgres, RLS, Realtime Broadcast on private channels
  - Stripe Checkout, **test mode only**, phase 6
- **PWA:** Serwist 9.5.13. Mobile-first: design for 390 px width. Deploy target Vercel. Production Supabase must be on Pro or higher for Realtime limits.
- **Tests:** Vitest 5 for logic and integration, Playwright 1.63 for end-to-end, @axe-core/playwright for accessibility.
- Before using any API, check the official docs for that version. Never use an API missing from the pinned version's docs.

### Architecture rules
- Game logic lives in pure functions under `/src/engine`, with no React, three or Supabase imports. UI and scene only call the engine. The engine never reads the real clock; time is passed in. **[CHANGED: names the 3D/realtime layers]**
- All content lives in `/data`: items, premium items, events, NPCs, jobs, venues, landmarks, geography, zones, copy, audio manifest. All balance numbers and **performance budgets** live in `/data/config`. Never hardcode numbers in components or scene code. **[CHANGED: adds budgets and zones]**
- All player-facing copy comes from `/data/copy` through a slang-pack layer, so slang can be swapped without code changes.
- **Player state is local-first and online-enhanced.** **[CHANGED: DEC-5]**
  - Cash, stats and inventory live in the Zustand store.
  - They sync to Supabase saves whenever a session exists, anonymous or permanent.
  - Solo play must keep working offline and without Supabase configured. The shared city degrades to a quiet solo city with an honest "You're offline" status. It never blocks play.
- **Two clocks.** **[NEW: DEC-5]** Each player has a *personal game clock*: actions fast-forward it, and it drives rent, jobs and opening hours. *City time* is the real New York wall clock. Shared-world features run on city time: presence, live events, chat reset, heartbeats.
- **Server-side enforcement** for anything that matters. Never trust the client for these:
  - chat quota and message filtering
  - friend boosts, roommate links, referral rewards
  - real-money purchases and entitlements
  - live stats
  - age attestation **[NEW]**
  - presence and movement broadcasts, handles, and every stat or cosmetic shown to other players **[NEW]**
  - save plausibility **[NEW]**

  **[CHANGED: list extended for DEC-4/DEC-5]**
- **Shared live city (realtime).** **[NEW: DEC-5]**
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
- **Out of scope** (still in force after DEC-4 and DEC-5): no player-to-player transfer of cash or items, no trading, no gifting between players, no group or crew chat, no free-text messaging with non-friends, no voice chat, and no way to raise the chat limit. Do not build these, even partially. **[CHANGED: adds the stranger free-text and voice items, which follow from the same rule now that strangers share the map]**
- Every Supabase table has Row Level Security. That includes policies on `realtime.messages` for every private topic. **[CHANGED]**

### Map and landmarks **[CHANGED: DEC-3, 3D rendering]**
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
  - low-poly district buildings and code-built low-poly landmarks
  - toon/sticker shading in the night palette
- **No third-party tiles, no Google Maps, no map SDKs, no photos or photogrammetry of real places.**
- **Quality tiers.**
  - Tiers are low, mid and high, chosen automatically from device signals, stepped down at runtime by FPS, and overridable in settings.
  - Data-saver requests (`Save-Data`, `prefers-reduced-data`) force low.
  - **If WebGL is unavailable, the game stays playable through the accessible Places panel.**
- **Accessible path.** Every 3D interaction has a DOM and keyboard path (A11Y-3): places, objects, movement.
- Iconic landmarks sit at real coordinates in these categories: bridge, building, monument, park, stadium, government, station, neighborhood, memorial.
- Businesses (bodegas, food spots, coffee shops, boutiques, clubs, job sites) are invented, with original names.
- Trademarked or corporate-branded names (for example the Empire State Building, Rockefeller Center, sponsored stadium names) use generic labels ("the Queens ballpark"). Every landmark has `nameMode` (`real` or `generic`) and `legalReviewed: false` until a human checks it.
- Do not use MTA logos or official line bullet designs. Plain line letters and numbers drawn in our own style are fine. Never state or imply MTA endorsement, and never claim the transit data is accurate or real-time. **[CHANGED: MTA terms]**
- Memorials are respectful, look-only stops: an info card in a muted palette. No flex, clout, events, jokes, effects or emotes. **[CHANGED: adds 3D effects and emotes]**
- No crime events at government buildings or memorials.

### Performance budgets **[NEW: DEC-3. Re-baselines the 300 KB geo budget and the "3 s on 4G" target.]**
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

### Non-negotiable product principles
1. **Instant map start.** **[CHANGED: DEC-4 and DEC-5]**
   - A link lands the player on the 3D map within the budgets above. No signup, no login wall.
   - The map loads behind a single **welcome card** with three parts: an 18+ year-of-birth check, a Terms/Privacy consent checkbox, and the audio choice.
   - The guest session starts automatically after that card.
   - The "Save your progress" prompt appears only after the first milestone. Guest progress must carry over to the account.
2. **Goal: Make it in New York.** Four career paths (influencer, streamer, artist/DJ, founder/hustler) share one clout ladder: Nobody, Local, Scene Regular, Known, Famous, Icon. The career path is chosen as the "Dream" in the avatar creator. Icon triggers a milestone moment and a prestige option.
3. **Young-adult NYC voice.** **[CHANGED: DEC-4]** Playful, confident, grown NYC attitude. Slang goes in flavour text, NPC dialogue, events, notifications and share cards. Buttons, stat names and prices stay plain and clear.
4. **Friends early and often, with an advantage.** Friend prompts appear after wins, never before. Persistent "Add friends" in the HUD.
   - Advantages: a daily friend boost, a capped per-friend clout bonus, and a roommate rent discount (each roommate pays less; no cash moves between players).
   - Friends are an advantage, not a requirement; solo play stays fully progressable.
   - Cap invite prompts per session. Never scrape contacts.
5. **The city is shared and honest.** **[NEW: DEC-5]**
   - You see real players near you, moving live.
   - Every "online", "here now" or "players" number comes from real presence data and is never padded.
   - Ambient pedestrians and NPCs look visibly different from players and are never counted as players (UX-3).
6. **Sound is the player's choice.** **[NEW: DEC-1 and GR-13]**
   - No audio before the player's choice.
   - Separate music, SFX, ambience and voice channels.
   - One-tap "My own music" mutes our music only and lets the player's own music app keep playing.

### Two kinds of purchases
- **In-game cash items** are earned through play and bought with in-game cash. They drive progression: clothing, makeup, gifts, decor, apartment upgrades. They have `sellValue` (with depreciation), `cloutValue` and `statEffects`.
- **Premium items** are bought with real money only (USD via Stripe).
  - They can never be bought or sold for in-game cash and can never be transferred.
  - They may add clout and style, but total clout from premium items is capped by `premiumCloutCap` in `/data/config`, and premium clout alone can never reach Icon.
  - Other players see a premium cosmetic only when the server holds the entitlement. **[NEW: DEC-5]**
- Never sell in-game cash, energy, time skips or clout directly for real money.
- Gifts are consumed (a money sink): used on NPCs during events or on yourself, never sent to other players.
- **Grants** (goal rewards, referral rewards, any operator compensation) all go through one grant function. **[NEW: ECON-1]** Grants are idempotent, audited, eligibility-targeted, and capped relative to the next progression goal. Granted value never counts toward goal progress.

### Safety rules (adults only, shared world) **[CHANGED: DEC-4 and DEC-5]**
**Content.** Default ruling, pending Q-B:
- Nightlife and alcohol references are allowed as flavour (clubs, bars, last call). Drinking is never rewarded, required, or tied to a stat boost.
- No drug references. No sexual content. No real-money gambling mechanics.
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

**Strangers.** Non-friends can interact only through server-rate-limited **preset emotes**: no free text, no voice. Default ruling, pending Q-D. **[NEW]**

**Block, mute, report on every player surface.** **[CHANGED: extended from "chat and friend surfaces"]** That means: map avatar, player card, venue occupant list, friend list, friend requests, chat and emotes.
- Block hides both ways, server-side, in snapshots, friend surfaces and chat.
- Mute hides that player's avatar and emotes for me.
- Report captures a reason, an optional filtered note and a context snapshot.

**Handles** are filtered server-side for slurs, profanity, reserved/staff names and impersonation. They are unique case-insensitively, rate-limited on change, and shown with a live preview, never silently rewritten (GR-6).

**Moderation.**
- Content auto-hides after `moderation.autoHideReports` distinct reporters.
- A moderator queue lives at `/mod`, restricted to allowlisted moderator accounts and checked server-side.
- Every moderator action is audited.
- A public Code of Conduct sits at `/conduct`.

### Balance anchors (tunable in /data/config) — unchanged
- **Time:** 1 real minute = 10 game minutes of passive time. Actions (shifts, travel, meals, visits) fast-forward the personal clock instantly by their duration, with a short animation; the player never waits in real time for an action to finish. Game day = 24 game hours. Rent due every 7 game days.
- **Start:** $150 cash, a Queens room.
- **Rent:** Queens room $280/wk, Brooklyn 1BR $520/wk, Manhattan loft $1100/wk.
- **Jobs** (4-hour shifts): barista $14/hr, retail $16/hr, delivery $18/hr (higher energy cost), junior dev $35/hr (needs a clout level).
- **Costs:** food $4–12, subway fare $3.
- **Target feel:** a new player working about 2 shifts a day can pay rent and save roughly $150/week; the first apartment upgrade lands around game day 10–14. If the wage anchors and this target conflict, keep the target and tune costs (food, energy recovery, transit), not wages. Log the change in progress.md.
- **Rarity tiers:** Common (frequent, cheap), Medium, Rare (expensive, limited).
- **Premium price tiers** live in `/data/config` and are placeholders until a human sets them.
- **Realtime config** (shard size, move rate limit, emote rate limit, heartbeat interval) lives in `/data/config/realtime.json`. **[NEW]**

### Art direction **[CHANGED: DEC-3]**
- Stylised low-poly 3D with a flat, bold sticker/toon look: a shared gradient ramp (MeshToonMaterial), inverted-hull outlines on mid/high tiers, and flat emissive lit windows at night.
- Warm night-city palette: deep indigo, hot pink, taxi yellow. Palette tokens live in `/data/config/theme.json`.
- Landmarks are code-built low-poly models in the same style. Never photos, scans or downloaded models with unclear licenses. Only permissively licensed (CC0/MIT) assets, each listed in a SOURCES.md.
- Emoji and SVG are allowed in the DOM UI. Chunky, thumb-friendly UI (hit targets ≥ 44 px). Snappy animations, juicy feedback on every purchase and clout gain.
- Respect `prefers-reduced-motion`: travel cuts instead of animating, and there is no camera shake.

### Voice samples (match this energy; refresh seasonally) **[CHANGED: DEC-4. Kept the energy and added adult nightlife lines.]**
- Bodega: "Bacon egg & cheese. It's giving breakfast of champions."
- MTA delay: "The train is 'experiencing delays.' You are experiencing main-character suffering."
- Rent due: "Landlord said 'rent' and your wallet said 'not today.'"
- Clout up: "Your name's starting to ring. Brooklyn noticed."
- Landmark flex: "Brooklyn Bridge at golden hour. The algorithm is about to eat."
- Friend prompt: "That W deserves witnesses. Tag a friend in?"
- Club door: "Bouncer checked the list, then checked your clout. Not tonight." **[NEW]**
- Last call: "Last call. Your feet said yes, your rent said go home." **[NEW]**
- Locked home: "Manhattan loft? On bodega money? Work your way here." **[NEW: keep-these, the "why it's locked" copy]**
- Someone nearby: "You're not the only one out tonight. 6 people on this block." **[NEW: DEC-5; the number is always real]**
- Welcome: "Welcome to Clout City. Tap in. Blow up."
- Share card footer: "Tap In. Blow Up. | Clout City: NYC"

### Build, Test, and Development Commands — PROJECT-SPECIFIC
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
| Budgets | `npm run budget` | JS and asset gzip sizes vs perf.json |
| Geo data | `npm run geo:build` | Needs network |
| Local Supabase | `npx supabase start` · `npx supabase db reset` · `npx supabase status` | |
| Stripe webhooks | `stripe listen --forward-to localhost:3000/api/stripe/webhook` | |

- **Whenever you replace or remove a UI control, grep `tests/e2e` for the specs that drive it and update them in the same change.** (kept)
- The Playwright Chromium launch flags that enable headless WebGL2 (SwiftShader/ANGLE) are documented in README. Verify them against the Chromium and Playwright docs when S01 is built.

### Coding Style & Naming Conventions — PROJECT-SPECIFIC
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

### Commit & Pull Request Guidelines **[CHANGED: DEC-6. Resolves the `S##:` vs conventional-prefix conflict.]**
- **Trunks:** `dev` is the working trunk; `main` is the release branch. **Never push to `main`, and never merge PRs.** Only the user does.
- **Loop commits:** made directly on `dev`, one task per commit.
  - Task commits: `S##: short description`, for example `S07: add landmark data`.
  - Loop housekeeping: `loop: short description`.
  - Attempt and blocked markers: `S##: start attempt N`, `S##: attempt N failed`, `S##: blocked …`.
- **Non-loop work** (user-requested fixes and chores outside the task list): branch from an up-to-date `dev` with a `feature/` or `bugfix/` prefix, use conventional prefixes (`feat:`, `fix:`, `chore:`), and open the PR against `dev`.
- **Phase PRs:** at the end of each phase, the orchestrator pushes `dev` and opens (or updates) one PR `dev → main` for the user's review. The PR body lists the tasks passed and blocked, the "Needs human review" items and the qa-mafia verdicts, and ends with the required attribution line.
- **Always branch from an up-to-date `dev`.** Never stack on another feature branch. (kept)

### Conventions
- Small commits, one task per commit (see above).
- Write unit tests for engine logic: clock, stats, travel, rent, economy, clout, premium cap, grant rules, chat quota and filter, tier picker, zone/shard assignment, save plausibility. **[CHANGED]**
- Keep a README with setup, env vars, data sources, how to add items, events, venues, landmarks, zones and copy, local Supabase and Realtime, Stripe CLI, and the quality-tier and budget tooling.

### Agent file placeholders
- `.claude/agents/bug-hunter.md`: `{{E2E_DIR}}` → `tests/e2e`.
- `.claude/agents/qa-mafia.md`:
  - `{{APP_SOURCE_PATHS}}` → `` `src/app/`, `src/components/`, `src/scene/`, `src/engine/`, `src/state/`, `src/realtime/`, `src/server/`, `supabase/migrations/`, `data/` ``
  - `{{QA_ENV_FILE}}` → `.env.local`; `{{QA_EMAIL_VAR}}` → `QA_EMAIL`; `{{QA_EMAIL_PASSWORD_VAR}}` → `QA_EMAIL_PASSWORD`
  - Local magic-link QA uses the local Supabase mail catcher. The QA mailbox is needed only for deployed environments.

---

## 2. Guardrail mapping

| ID | Task(s) | Acceptance clause added |
|---|---|---|
| GR-1 errors describe the current problem | S05a (establishes the form pattern), S18a, S18b, S19 | `noValidate`. Errors come from one shared zod schema and are recomputed on submit and on field change. An e2e test changes the fixed field and asserts the old error is gone and the new one is named. |
| GR-2 all errors at once, inline | S05a, S18a, S18b, S19 | An empty submit shows every field error at once, inline, with `aria-invalid` and `aria-describedby`; focus lands on the first invalid field (e2e). |
| GR-3 real password policy | **N/A for now** | Auth is anonymous, magic link or Google, so there are no passwords. The standing rule stays: if password auth is ever added, require length ≥ 8 plus a breached/common-password check (NIST SP 800-63B). |
| GR-4 account recovery | S19 | Email magic link or Google is the recovery path. Guests see a persistent nudge after the first milestone and again at each level-up until they save. A warning explains that clearing browser data loses guest progress. |
| GR-5 Terms/Privacy linked, consent recorded | S05a, S18, S27 | The welcome-card consent checkbox links Terms and Privacy. Consent version and timestamp are stored locally, then on the profile (S18). The pages exist (S27). |
| GR-6 never rewrite input silently | S18a | The handle field shows a live preview of the normalised handle ("Your handle will be @claude_qa") or rejects with a clear message. A test proves the server never changes a submitted handle without the client having shown that preview. |
| GR-7 collect only what is used | S18a, S19 | The only fields are handle (shown over your avatar) and email (recovery). No real-name field exists. |
| GR-8 accessible custom controls | S01 (lint), S05a, S16a | Native inputs, styled. E2e specs click the control itself. Axe passes. |
| GR-9 short skippable tour | S06 | Coach marks over the live map, at most 6 steps, no tutorial screens. Skippable, resumable from Help. A new player starts with at most 3 notifications, each meaningful. |
| GR-10 onboarding copy matches options | S16a | Neighborhood-roll and creator copy is generated from the same data that drives the options (test). |
| GR-11 copy matches numbers | S02, S07, S11, S16 | A copy test bans literal superlatives. "Cheapest" and similar are computed from data. Money displays in whole dollars. |
| GR-12 correct customisation groups | S16a | Hair, Facial hair, Accessories, Skin and Outfit are separate categories (schema test). |
| GR-13 no audio without explicit choice | S05a, S05b | No AudioContext and no audio network request before the player taps "Play our music" or "I'll bring my own" (e2e network assert). Only that tap or the sound control unlocks audio. The choice is remembered, with now-playing state and a one-tap mute. No third-party streams. |
| ECON-1 grants never break balance | S15, S21, S23, S12 | One idempotent, audited grant function with eligibility rules and a cap relative to the next goal. Goals measure earned value only. The S12 bot with all grants applied stays in bounds. No admin cash-grant tool exists in v1. |
| A11Y-1 swatch names | S16, S16a | Every swatch has a human colour name in `aria-label` (test). |
| A11Y-2 every button named | S01 (jsx-a11y + axe fixture), all UI tasks | Axe runs in the shared e2e fixture. Locked items explain why in their accessible name (S07, S11, S16). |
| A11Y-3 accessible 3D equivalent | S04c, S09, S16, S31, S32 | A DOM Places panel, keyboard reachable, offers every 3D action (travel, venue, landmark, decor slot, other players' cards). It is also the no-WebGL fallback. |
| UX-1 no overlay collisions | S01, S05, S05a, S06 | One overlay layer system with safe zones. Screenshot and bounding-box overlap tests at 390 and 1280. |
| UX-2 one number formatter | S02, S24, S31 | All counts go through the shared compact formatter (test greps for ad-hoc formatting). |
| UX-3 honest live counters | S24, S31, S34 | Counts come only from `player_state.last_seen` and snapshots. NPCs and ambient pedestrians are excluded, proven by test. |
| PERF-1 zero console warnings | S01 (fixture), S04a (three pin) | The e2e fixture fails on any console warning or error. Three is pinned to a version R3F does not trigger deprecation warnings on. |

**Keep these:**

| Item | Task | How |
|---|---|---|
| Instant low-friction start, then the character creator | S05, S05a, S16a | One welcome card, then the map. The creator is prompted after the first action and never blocks play. |
| Creator flow Look → Traits → Dream → Birth lottery → Home | S16a | Look → Traits → Dream (career path) → Neighborhood roll (dice reveal among Queens start neighborhoods) → Home. |
| Live social proof on the landing page | S22, S24 | Share landing and `/live` show real online counts and real recent activity counters. |
| "Why it's locked" copy | S07, S11, S16 | In-voice locked copy, also in accessible names. |
| Fast steps (under 5 s each) | S04b, S28 | Perf budgets and `e2e:perf`. |
| Cookie banner copy "No ad trackers, ever" | S27 | No ad trackers and only essential storage, so no consent banner is needed. A privacy note "No ad trackers, ever." goes in the footer and on /privacy. Legal review is in Needs human review. |
| Lagos-style 6-step tour | S06 | See GR-9. |

---

## 3. Candidate features (IDEA-1 to IDEA-19)

| IDEA | Verdict | Reason |
|---|---|---|
| 1 Co-op jobs | **Later** (post-launch) | Fits the rules: each player earns their own wage, nothing transfers. But strangers can only use preset emotes, so it needs matchmaking and server-authoritative shared job state. Too much for launch. |
| 2 Venue mini-games | **Later** | Real multiplayer game state needs server authority. Retheme for NYC (park dominoes, karaoke, trivia). |
| 3 Scheduled live events | **Now: S34** (phase 5) | Cheap, data-driven, runs on city time. Gives players a reason to come back to the shared city. |
| 4 Proximity voice | **Parked: conflicts** | Voice with strangers would bypass the friends-only, 10-per-day text chat rule and the no-group-chat rule. Needs the user to lift the out-of-scope list, plus a moderation budget. |
| 5 Async traces | **Parked for free text** (conflict: notes and postcards are unlimited messaging). **Later** for preset-sticker "reviews" of spots. | Free-text traces would bypass the chat rules; preset stickers would not. |
| 6 Photo & clip mode | **Now: photo inside S22**. Clips later. | S22 renders a 3D "Snap" into the share card. Other players appear only as silhouettes, with no handles. |
| 7 Invite → roommate | **Now: covered** by S20 (deep link) and S21 (roommate link) | The NYC version uses the native share sheet, not WhatsApp specifically. |
| 8 Shared homes, co-decorate | **Parked: conflicts** | Placing my items in a co-owned home is item transfer or shared ownership. Roommate discount (S21) stays. |
| 9 Player businesses / fashion | **Parked: conflicts** | Selling to other players is player-to-player trading and cash transfer, and adds UGC moderation. |
| 10 Elected governor | **Parked** | Political features in an 18+ shared world need heavy moderation, and the vote is open to manipulation. |
| 11 Scarce prestige real estate | **Later** | Allowed only if allocated by achievement, never by trading. Must pass ECON-1 bounds. |
| 12 Real businesses with deals | **Parked: conflicts** | The rules require invented businesses (Q-1 is answered for venues). Also needs legal work. |
| 13 Real calendar | **Now: inside S34** (city-time calendar). Real weather later. | Use generic names for trademarked events ("the big tennis tournament"). Weather would need an external API (e.g. NWS), not now. |
| 14 Multi-city passport | **Parked** | Keep the engine city-agnostic through `/data`. No feature work. |
| 15 AI residents with memory | **Later** | Costs ongoing inference and needs moderation of model output. Cold start is covered now by scripted ambient pedestrians (S31), clearly not players and never counted. |
| 16 Low-end Android, low-data | **Now: S04b** (tiers, budgets, Save-Data), S04e (offline) | Core to DEC-3. |
| 17 Local payments | **N/A** | It was Nigeria-specific. Stripe Checkout in USD covers NYC; Checkout offers wallets automatically. |
| 18 Push notifications | **Later** | Needs VAPID keys, an install on iOS, quiet hours and rate limits. Revisit after launch. |
| 19 Safety baseline | **Now: S05a, S18, S18a, S18b, S32, S33, S35** | A prerequisite for DEC-5. |

---

## 4. Revised prd.json (complete; write to the repo root)

What changed in the task list:
- **S17 retired.** It is folded into S05a (client age gate at first launch) and S18 (server attestation). A standalone S17 would come before the profiles table it needs.
- New tasks use letter suffixes inside phases. Phase 5 uses new numbers S29 to S35.
- **Selection order is (phase, number, suffix).** The loop prompt states this.

```json
{
  "project": "Clout City: NYC",
  "tagline": "Tap In. Blow Up.",
  "phases": {
    "1": "Foundation, 3D city, instant start",
    "2": "World, landmarks, economy",
    "3": "Clout, events, home, avatar",
    "4": "Accounts, safety, friends, growth",
    "5": "Shared live city",
    "6": "Premium store",
    "7": "Ship"
  },
  "requirementsKey": {
    "network": "Sandbox can download public data and npm packages",
    "webgl": "Headless Playwright Chromium can create a WebGL2 context (proved by tests/e2e/webgl-smoke.spec.ts, added in S01)",
    "supabase": "Docker daemon running, local Supabase running (npx supabase start), and .env.local has NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY",
    "realtime": "Local Supabase Realtime service healthy (npx supabase status lists it) with public access disabled for private channels in supabase/config.toml; verified by npm run check:realtime",
    "stripe": "Stripe test-mode keys (STRIPE_SECRET_KEY, NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY, STRIPE_WEBHOOK_SECRET) in .env.local and Stripe CLI installed and logged in for webhook forwarding"
  },
  "tasks": [
    {"id": "S01", "phase": 1, "title": "Scaffold, PWA shell, quality gates", "requires": ["network"], "acceptance": "Next.js 16.3.x (App Router) + TypeScript 6.0.x strict + Tailwind 4 builds with the exact versions pinned in CLAUDE.md (three, @react-three/fiber and @react-three/drei pinned without ^); npm scripts dev, build, start, typecheck, lint (ESLint CLI with jsx-a11y and no-console), format:check (Prettier), test (Vitest), e2e (Playwright, specs in tests/e2e) and budget, each with one passing sample; Playwright projects 'mobile-390' (390x844, touch) and 'desktop-1280'; tests/e2e/webgl-smoke.spec.ts proves headless Chromium creates a WebGL2 context, with launch flags documented in README; a shared e2e fixture fails any test on a console warning or error (PERF-1) and provides an axe check that fails on serious or critical violations (A11Y-2); PWA manifest via app/manifest.ts (name 'Clout City: NYC', short name 'Clout City'), icons, installable, locked mobile viewport; bottom tab layout correct at 390px; one overlay layer system (named layers, reserved safe zones for HUD, sheets, toasts and banners) with screenshot and bounding-box tests at 390 and 1280 proving no overlap (UX-1); structured logger in src/lib/log.ts; supabase CLI added as a devDependency and supabase/config.toml initialised (no running stack needed); .gitignore covers env files, build output, test artefacts and the geo download cache.", "review": false, "passes": false, "blocked": false, "attempts": 0},
    {"id": "S02", "phase": 1, "title": "Data, copy, formatters, and store", "requires": [], "acceptance": "/data folders for items, premium, events, jobs, venues, landmarks, geo, zones, audio, config (including config/perf.json with every budget from CLAUDE.md, config/theme.json palette tokens, config/realtime.json) and copy, each validated by a zod schema with a test; central copy file with slang-pack layer (test proves swapping the pack changes rendered text); one shared formatter module: money shown as whole dollars (GR-11) and counts via Intl.NumberFormat notation 'compact' (UX-2); a copy test fails if any copy string uses a superlative (cheapest, biggest, best, most, fastest) as literal text rather than a value computed from data (GR-11); Zustand store with localStorage persistence and schema version (test for persist and rehydrate).", "review": false, "passes": false, "blocked": false, "attempts": 0},
    {"id": "S03", "phase": 1, "title": "Core engine", "requires": [], "acceptance": "Pure-function game clock (1 real min = 10 game min of passive time, pauses when tab hidden, 1x/2x toggle); actions fast-forward the personal clock instantly by their duration; the engine never reads the real clock (time is injected) and exposes city time (real New York wall-clock time) separately from the personal game clock; energy, hunger, mood decay with penalties at zero; action system with time, money, energy costs and stat effects validated in the engine; save/load with a schema migration test; unit tests for time math, action fast-forward, day and week rollover, insufficient funds, and city time across a DST change.", "review": false, "passes": false, "blocked": false, "attempts": 0},
    {"id": "S04", "phase": 1, "title": "Geo pipeline and projection", "requires": ["network"], "acceptance": "npm run geo:build reproducibly downloads pinned sources (NYC Open Data borough boundaries clipped to shoreline, NYC parks, Neighborhood Tabulation Areas, MTA static GTFS subway shapes and stops; OSM only for a layer no city source provides, kept in its own ODbL file) into a gitignored cache and writes simplified, quantized layers to /data/geo plus play zones (grouped NTAs) to /data/zones; output is deterministic (checksum test: same input gives byte-identical output); raw MTA files are kept unmodified in the cache and derived files are labelled derived; /data/geo/SOURCES.md lists each source URL, retrieval date, license or terms, transformations and required attribution text (MTA: not endorsed, no accuracy claim; OSM ODbL notice if used); one projection module (lat/lng to local metres, fixed origin) is shared by scene and engine; base geo gzipped size is within perf.json geoBaseGzKB; unit tests prove known coordinates land in the correct borough (Times Square in Manhattan, the Unisphere in Queens, Prospect Park in Brooklyn, a Bronx point, St George in Staten Island), an Upper Bay point is in no borough, and every subway station lies on a line.", "review": true, "passes": false, "blocked": false, "attempts": 0},
    {"id": "S04a", "phase": 1, "title": "3D city base scene", "requires": ["webgl"], "acceptance": "The react-three-fiber canvas is lazy-loaded with no SSR so the DOM shell is interactive before the 3D chunk arrives; borough land extruded from /data/geo, water plane, parks, subway lines as ribbons in our own colours with plain line letters and stations as markers (no MTA logos or bullets); toon shading via a shared gradient ramp and palette tokens from config/theme.json; camera rig with one-finger pan, pinch zoom and limited two-finger rotate and tilt, bounded to the NYC extent with zoom limits; frameloop is on demand (test hook frame counter shows zero frames over 2 s idle); zero console warnings with the pinned three version (if R3F triggers three deprecation warnings, pin three to the newest version that does not and record it in progress.md); required map attribution visible on the map; a test-mode hook exposes camera state and renderer.info; Playwright pans and zooms on mobile-390 and asserts camera state; draw calls and triangles at the default view are within the mid-tier budget.", "review": true, "passes": false, "blocked": false, "attempts": 0},
    {"id": "S04b", "phase": 1, "title": "Quality tiers and performance budgets", "requires": ["webgl"], "acceptance": "A pure tier picker chooses low, mid or high from WebGL2 support, MAX_TEXTURE_SIZE, deviceMemory, hardwareConcurrency, renderer string and Save-Data/prefers-reduced-data, with every threshold in perf.json (unit tests per signal); the runtime steps down one tier via drei PerformanceMonitor when average FPS stays below the config floor, with hysteresis, and never auto-upgrades above the detected tier; a settings override is persisted; per-tier settings (DPR cap, shadows, outlines, building density, max visible avatars) come from config; npm run budget fails when shell JS, 3D chunk JS, total JS, base geo or district assets exceed perf.json (gzipped); npm run e2e:perf runs a cold load under the cc-mid-4g profile (4 Mbps down, 1 Mbps up, 150 ms RTT, 4x CPU) on the low tier and asserts shell interactive within budget and playable within budget (median of 3 runs), a warm load within budget, and draw calls and triangles per tier; any shadow uses PCFShadowMap, never PCFSoftShadowMap.", "review": true, "passes": false, "blocked": false, "attempts": 0},
    {"id": "S04c", "phase": 1, "title": "Tappable places, accessible Places panel, no-WebGL fallback", "requires": ["webgl"], "acceptance": "Points placed by real latitude and longitude render as instanced pins, are tappable with an on-screen hit area of at least 44 px and open a place sheet stub; a DOM Places panel lists every place grouped by borough, is fully keyboard navigable, offers the same actions as tapping in 3D and announces selection (A11Y-3); when WebGL is unavailable or the context is lost, the app shows the Places panel and a static stylised fallback and stays playable, and recovers when the context is restored; Playwright taps a point in the canvas (screen coordinates from the test hook) and the same place via the panel, and a WebGL-disabled run completes a place selection; axe passes.", "review": false, "passes": false, "blocked": false, "attempts": 0},
    {"id": "S04d", "phase": 1, "title": "District buildings", "requires": ["network", "webgl"], "acceptance": "The geo script derives low-poly building masses from NYC Open Data building footprints (roof height field) for districts listed in config (Midtown, Lower Manhattan, Downtown Brooklyn and DUMBO, Williamsburg, Long Island City, Astoria, Flushing, Jamaica), simplified and merged per district per tier; elsewhere procedural low blocks by density; rendered as merged or instanced meshes with toon shading and flat emissive lit windows at night; no building carries a business name; each tier stays within its district-asset, draw-call and triangle budgets (npm run budget and e2e:perf); SOURCES.md updated.", "review": true, "passes": false, "blocked": false, "attempts": 0},
    {"id": "S04e", "phase": 1, "title": "Offline and caching", "requires": [], "acceptance": "A Serwist service worker precaches the shell, the 3D chunk, base geo and district assets for the detected tier, with versioned caches so updates replace old data; authenticated API responses are never cached; the service worker script is served with the no-cache headers from the Next.js PWA guide; Playwright loads the map, goes offline, reloads and completes a solo action; the warm-load budget passes.", "review": false, "passes": false, "blocked": false, "attempts": 0},
    {"id": "S05", "phase": 1, "title": "Guest start on the 3D map", "requires": ["webgl"], "acceptance": "Opening the root URL in a fresh browser shows the shell, then the playable 3D NYC map centred on the player's Queens start within the perf.json budgets, with no signup; a player avatar placeholder stands at the start point; anonymous Supabase auth with a local-only fallback when env vars are missing (test runs with env vars absent); HUD with stats, clock, money, clout and the goal line 'Make it in New York', placed in the overlay safe zones; page title and meta use the tagline 'Tap In. Blow Up.'; Playwright test confirms.", "review": false, "passes": false, "blocked": false, "attempts": 0},
    {"id": "S05a", "phase": 1, "title": "Welcome card: 18+ check, consent, audio choice", "requires": [], "acceptance": "On first visit one welcome card sits over the already-loading map (the map keeps loading behind it and perf budgets still pass) with a neutral year-of-birth picker (no default, no hint of the threshold), a consent checkbox linking Terms and Privacy, and the audio choice 'Play our music' or 'I'll bring my own'; under 18 shows an in-voice 'come back when you're 18' screen, locks the gate on that device for 24 hours, and creates no Supabase user; 18+ stores attestation (boolean and timestamp, not the birth year), consent version and timestamp, and the audio choice locally; anonymous Supabase sign-in happens only after a passing attestation; the form follows the shared pattern (noValidate, one zod schema, all errors at once inline with aria-invalid and aria-describedby, focus on the first invalid field, errors recomputed on change) (GR-1, GR-2, GR-8); no AudioContext is created and no audio is requested before the audio choice (GR-13); returning players never see the card again; existing e2e specs use a shared fixture that passes the card; Playwright covers the 18+ path, the under-18 path, an empty submit and an error that is fixed.", "review": true, "passes": false, "blocked": false, "attempts": 0},
    {"id": "S05b", "phase": 1, "title": "Audio channels and 'My own music'", "requires": [], "acceptance": "Audio system with separate music, sfx, ambience and voice channels plus master, each with its own volume; a one-tap HUD control and a settings toggle for 'My own music' mute in-game music only while sfx and ambience keep playing, with visible now-playing state and an accessible name; the choice is remembered per device (and synced to the account in S18c) and nothing overrides it; audio unlocks only from a deliberate tap on the audio choice or the sound control (GR-13); where the browser supports it, the audio session is set to mix with other apps (for example Safari's navigator.audioSession, checked against current docs) and sfx never take over the media session; all audio assets are CC0 or otherwise licensed and listed in /data/audio/SOURCES.md, with no third-party streams; audio loads lazily after the map is playable; unit tests for mixer state; Playwright proves no audio requests before the choice and that muting music keeps sfx enabled; mixing with a background music app on real iOS and Android is listed under Needs human review.", "review": true, "passes": false, "blocked": false, "attempts": 0},
    {"id": "S06", "phase": 1, "title": "Guided first action and skippable tour", "requires": [], "acceptance": "A coach-mark tour over the live map (at most 6 steps, no tutorial screens, skippable, resumable from Help) leads the player through a first bodega purchase near their Queens start in about 20 seconds; a new player starts with at most 3 notifications, each meaningful (GR-9); no further gate or age check appears; Playwright completes the guided purchase and, separately, the skip and resume-from-Help path.", "review": false, "passes": false, "blocked": false, "attempts": 0},
    {"id": "S07", "phase": 2, "title": "Boroughs, landmarks, and venues", "requires": [], "acceptance": "Five boroughs in data. Queens, Brooklyn, and Manhattan each have 8 invented venues with original names at plausible real coordinates (bodega, food spot, subway station, park or gym, coffee shop, thrift or boutique, club, job site). Landmarks at real coordinates with category, nameMode, and legalReviewed:false, at minimum: Brooklyn Bridge, Manhattan Bridge, Queensboro Bridge; Flatiron Building, Chrysler Building; Statue of Liberty (viewed from Battery Park), Washington Square Arch; Central Park, the High Line, Prospect Park, Flushing Meadows (Unisphere), Astoria Park; the Queens ballpark and the Brooklyn arena (generic labels); City Hall, Brooklyn Borough Hall, Queens Borough Hall; Grand Central, Penn Station, Jamaica Station; Times Square, DUMBO, Coney Island boardwalk, Flushing Main Street; 9/11 Memorial (memorial category). Landmarks show as placeholder markers in 3D until S07a and S07b. Bronx and Staten Island render as dimmed 'expanding soon' land teasing the Bronx ballpark and the Staten Island Ferry. Brooklyn and Manhattan unlock by clout level, with in-voice why-locked copy that is also in the accessible name. Validation tests: every landmark has a category and nameMode; branded names use generic labels; memorials have no flex, clout, emote, or event hooks; any superlative in venue copy is computed from data. Gating tests.", "review": true, "passes": false, "blocked": false, "attempts": 0},
    {"id": "S07a", "phase": 2, "title": "Low-poly landmarks I: bridges, buildings, stations, government", "requires": ["webgl"], "acceptance": "Code-built low-poly models (procedural primitives, no downloaded models) in the toon style for every S07 landmark in the bridge, building, station and government categories, placed at real coordinates and orientation; generic-labelled landmarks show only their generic label; per-tier LOD via drei Detailed; per-landmark triangle budget from perf.json; merged or instanced where repeated; npm run budget and e2e:perf pass for every tier; each model is reachable from the Places panel.", "review": true, "passes": false, "blocked": false, "attempts": 0},
    {"id": "S07b", "phase": 2, "title": "Low-poly landmarks II: parks, monuments, stadiums, neighborhoods, memorial", "requires": ["webgl"], "acceptance": "Code-built low-poly models for the remaining S07 landmarks; the Statue of Liberty is visible from Battery Park at the default zoom range; the memorial uses a muted palette with no emissive or animated effects, no emotes and no flex FX (test asserts no effect components are attached); per-tier LOD and triangle budgets as S07a; npm run budget and e2e:perf pass for every tier.", "review": true, "passes": false, "blocked": false, "attempts": 0},
    {"id": "S08", "phase": 2, "title": "Transit and rush hour", "requires": [], "acceptance": "Walk, subway, and taxi with time and cost computed from real distances between points, per-mode speeds and fares in config; subway trips route via the nearest stations on the real lines in /data/geo, with walking legs at each end; travel fast-forwards the personal clock while the avatar animates along the route in 3D (subway along its ribbon) for at most the config animation length, and users with prefers-reduced-motion get an instant cut; rush hour (7-10am, 4-7pm) slows subway and drains mood; random MTA delay event hook; no MTA logos or official line bullets; unit tests for distance, routing, and modifiers.", "review": false, "passes": false, "blocked": false, "attempts": 0},
    {"id": "S09", "phase": 2, "title": "Location action sheet, club door, landmark visits", "requires": [], "acceptance": "Tapping a venue or landmark in 3D or choosing it in the Places panel opens the same action sheet filtered by personal time of day and opening hours; closed venues show opening time; the club opens at night with a cover charge, a minimum clout level at the door with in-voice refusal copy, and a clout gain inside; non-memorial landmarks have a Visit action (time cost, mood gain) and a flexMultiplier from config for use by S13; memorials show a respectful info card only; tests.", "review": false, "passes": false, "blocked": false, "attempts": 0},
    {"id": "S10", "phase": 2, "title": "Items, inventory, and shop", "requires": [], "acceptance": "12 clothing and makeup items across 3 rarity tiers and 5 slots plus 3 gift types, all with currency 'cash', price, rarity, sellValue, cloutValue, statEffects; gifts are consumed when used on NPCs or yourself and cannot target another player; inventory and outfit equip; buy and sell with depreciation, prices displayed via the shared money formatter; schema validation and unit tests including insufficient funds.", "review": false, "passes": false, "blocked": false, "attempts": 0},
    {"id": "S11", "phase": 2, "title": "Jobs and rent", "requires": [], "acceptance": "Four jobs per CLAUDE.md anchors (barista, retail, delivery with higher energy cost, junior dev gated by clout level with why-locked copy) with 4-hour shifts that fast-forward the personal clock; rent due every 7 game days; missed rent escalates to eviction and a move to cheaper housing; housing copy that compares rents is computed from data (GR-11); unit tests.", "review": false, "passes": false, "blocked": false, "attempts": 0},
    {"id": "S12", "phase": 2, "title": "Economy simulation test", "requires": [], "acceptance": "A scripted bot plays 30 game days solo with a sensible strategy and ends neither bankrupt nor wildly rich (bounds in test); it saves roughly $150 per week and reaches the first apartment upgrade affordability between game days 10 and 14; any cost tuning needed to hit this is done in /data/config and logged; the bot also records its maximum clout and cash gain per action and per game day into a fixture used by S18c plausibility ceilings; test fails if balance drifts.", "review": true, "passes": false, "blocked": false, "attempts": 0},
    {"id": "S13", "phase": 3, "title": "Clout, style, flex, levels", "requires": [], "acceptance": "Integer clout from item cloutValue (counts only while owned or equipped; a buy/sell loop cannot farm clout, proven by test), first paycheck, and a flex action with seeded-random viral chance weighted by outfit style score and the landmark flexMultiplier when flexing at a landmark; style score multiplies clout gains; six levels (Nobody, Local, Scene Regular, Known, Famous, Icon) in config with HUD progress; a level-up event is emitted; every clout change writes a typed ledger entry (source, amount, currency) so premium items (S25) plug in and can be capped and S18c can check plausibility without engine changes; unit tests.", "review": true, "passes": false, "blocked": false, "attempts": 0},
    {"id": "S14", "phase": 3, "title": "Events", "requires": [], "acceptance": "Data-driven event engine with conditions (time, borough, location, stats, clout, items), weights, and choice outcomes; modal UI in the overlay system; 15 events in the voice of CLAUDE.md including MTA delay, rent hike, free pizza, club promoter offer, viral moment, 2 mild crime events, and at least 2 landmark-tied events; validation tests prove no event can fire at a memorial, no crime event can fire at a government building, and no event rewards or requires drinking or references drugs or sexual content; seeded-random tests.", "review": false, "passes": false, "blocked": false, "attempts": 0},
    {"id": "S15", "phase": 3, "title": "Goals, grants, Icon moment, prestige", "requires": [], "acceptance": "Goals screen (first paycheck, first outfit, first landmark visit, first club night, first friend, level thresholds) with rewards and progress; every reward goes through one grant function that is idempotent (grant key), audited (grant log), eligibility-targeted and capped relative to the next progression goal from config, and granted value never counts toward goal progress (ECON-1, tests); reaching Icon shows a victory screen with a share hook and a prestige option (restart progress, keep cosmetics and premium items, earn a prestige badge; rules in config); tests.", "review": false, "passes": false, "blocked": false, "attempts": 0},
    {"id": "S16", "phase": 3, "title": "3D apartment and decor", "requires": ["webgl"], "acceptance": "A low-poly toon 3D apartment interior for the Queens room and the Brooklyn 1BR upgrade (higher rent, more slots), within per-tier budgets; 6 decor items across rarity tiers placed in slots by tapping in 3D or through an equivalent DOM slot list (A11Y-3); colour variants have human-readable names (A11Y-1); locked upgrades show in-voice why-locked copy, also in the accessible name; home score feeds clout; Playwright places an item both ways.", "review": false, "passes": false, "blocked": false, "attempts": 0},
    {"id": "S16a", "phase": 3, "title": "3D avatar and 'Make it you' creator", "requires": ["webgl"], "acceptance": "A modular low-poly 3D avatar (code-built or CC0 parts listed in SOURCES.md) within per-tier triangle budgets, used on the map and in the apartment; guests start immediately with a randomized avatar and never meet the creator before first play; after the first action the creator is offered (skippable, always reachable from the HUD) with the flow Look, Traits, Dream (career path: influencer, streamer, artist/DJ, founder/hustler), Neighborhood roll (dice reveal among Queens start neighborhoods), Home; option and roll copy is generated from the same data that drives the options (GR-10); Hair, Facial hair, Accessories, Skin and Outfit are separate categories (GR-12); every swatch has a human colour name (A11Y-1); career path sets the goal line copy and a path-tagged bonus from config, and the S12 bot meets its targets for every path; native controls clicked in e2e; tests.", "review": true, "passes": false, "blocked": false, "attempts": 0},
    {"id": "S18", "phase": 4, "title": "Core schema, RLS, age attestation", "requires": ["supabase"], "acceptance": "Migrations for profiles (with age attestation timestamp, consent version and timestamp, audio preference), saves, friendships, friend_boosts, roommates, referrals, live_stats, purchases, entitlements and grants, all with Row Level Security; purchases, entitlements and grants are readable only by their owner and writable only by the service role; a profile row is created on first guest session and receives the S05a attestation and consent; a server helper requires attestation and every social, realtime and purchase RPC calls it (test proves an unattested account is refused); a server-side function enforces one friend boost per sender per day; tests prove users cannot read or write others' private rows.", "review": true, "passes": false, "blocked": false, "attempts": 0},
    {"id": "S18a", "phase": 4, "title": "Handles and public profile", "requires": ["supabase"], "acceptance": "Guests get a generated safe handle from word lists in /data/copy; a handle form with live preview of the normalised handle, never a silent rewrite (GR-6), and the shared form pattern (GR-1, GR-2); server-side case-insensitive uniqueness, a filter for slurs, profanity, reserved and staff names and impersonation, and a rate limit on changes; the public profile exposes only handle, avatar, server-accepted level and career path, with no real-name field (GR-7); RLS and RPC tests including a filtered handle and a uniqueness race.", "review": true, "passes": false, "blocked": false, "attempts": 0},
    {"id": "S18b", "phase": 4, "title": "Safety core: block, mute, report, moderation", "requires": ["supabase"], "acceptance": "Migrations and RPCs for blocks (hide both ways), mutes, reports (reason enum, optional filtered note of at most 280 characters, context snapshot) and audited moderation actions, all with RLS (a reporter cannot read other reports; targets never see who reported them); content auto-hides after moderation.autoHideReports distinct reporters pending review; a /mod queue restricted server-side to accounts in MODERATOR_EMAILS with dismiss, warn, reset handle, suspend and ban actions; a /conduct Code of Conduct page; one reusable player actions component (Add friend, Mute, Block, Report) that every later player surface must use; the report form follows the shared form pattern; tests.", "review": true, "passes": false, "blocked": false, "attempts": 0},
    {"id": "S18c", "phase": 4, "title": "Cloud save sync and server plausibility", "requires": ["supabase"], "acceptance": "Whenever a session exists, saves sync to Supabase (debounced, versioned, offline queue, with conflict handling by version and a server check) and restore on load; the server validates each save delta against ceilings derived from the S12 bot fixture times a config margin (clout and cash per action and per real minute, owned cosmetics against cash-shop and entitlement rules) and rejects and flags implausible saves; only server-accepted level, career path and cosmetics are ever shown to other players; audio preference syncs; tests prove a tampered localStorage save cannot change the public level or show an unowned premium cosmetic, and offline play queues and later syncs.", "review": true, "passes": false, "blocked": false, "attempts": 0},
    {"id": "S19", "phase": 4, "title": "Account upgrade keeps progress", "requires": ["supabase"], "acceptance": "After the first milestone the player is prompted to save progress via email magic link or Google, and is nudged again at each level-up until saved (GR-4), with a clear warning that clearing browser data loses guest progress; all guest progress, attestation and consent carry over; the email form follows the shared form pattern; Playwright completes the magic-link flow using the local Supabase mail catcher; the Google button is present and its manual check is listed under Needs human review.", "review": true, "passes": false, "blocked": false, "attempts": 0},
    {"id": "S20", "phase": 4, "title": "Invite link and friends", "requires": ["supabase"], "acceptance": "Unique invite link with native share sheet; opening it lands on the map first (after the welcome card) with the referrer stored in the background, and an optional roommate-invite flag picked up by S21; friend list with send, accept, decline, mute, report, and block through the shared player actions component; friend prompts appear after first paycheck, first level-up, and first outfit purchase, capped per session; persistent 'Add friends' HUD button; no contact scraping; tests.", "review": true, "passes": false, "blocked": false, "attempts": 0},
    {"id": "S20a", "phase": 4, "title": "Friends-only chat with a fixed daily limit", "requires": ["supabase"], "acceptance": "One-to-one text chat between accepted friends only, for attested 18+ accounts (server-checked); migrations for messages and chat_quota with Row Level Security (users read only conversations they are part of; no client writes to chat_quota); a server-side function sends a message and decrements quota atomically, allowing 10 text messages per player per day with a New York midnight reset and 140 characters max; the limit of 10 is read from config, applies to every player, and no purchase, reward, goal, referral, friend count, or account type can raise it; messages containing links, images, phone numbers, emails, or social handles are rejected server-side and do not use quota; unlimited emoji reactions and preset quick-replies that do not count toward the limit; a visible 'N of 10 left today' counter and an in-voice message when the limit is reached, with time until reset; report and block on every chat, and blocking hides the conversation both ways; tests prove the 11th message is refused, concurrent sends cannot exceed the limit, rejected messages keep quota, the reset happens at New York midnight, and users cannot read others' conversations.", "review": true, "passes": false, "blocked": false, "attempts": 0},
    {"id": "S21", "phase": 4, "title": "Friend advantage", "requires": ["supabase"], "acceptance": "A friend can send one daily boost (energy plus small clout) per day and the sender gets a small reward, enforced server-side and issued through the grant function; each friend adds a capped clout-gain bonus; two friends can link as roommates at the same apartment tier (including from an S20 roommate invite) and each pays a config percentage of rent, with no cash moving between players and the link enforced server-side; the S12 solo bot still meets its targets with zero friends; tests.", "review": true, "passes": false, "blocked": false, "attempts": 0},
    {"id": "S22", "phase": 4, "title": "Share cards, photo snap, and deep links", "requires": [], "acceptance": "Branded 9:16 share cards via OG routes (footer 'Tap In. Blow Up. | Clout City: NYC') for level-up, borough move, viral flex, and landmark flex (landmark rendered in game art, never photos; never for memorials); a 'Snap' action renders the player's current 3D view into a card, where other players appear only as generic silhouettes with no handles; share links open a landing preview showing the real players-online count with one-tap 'Start your NYC story' that lands on the map with the referrer attached; snapshot and Playwright tests.", "review": false, "passes": false, "blocked": false, "attempts": 0},
    {"id": "S23", "phase": 4, "title": "Referral reward", "requires": ["supabase"], "acceptance": "When an invitee reaches their first paycheck, inviter and invitee each receive a referral-exclusive cosmetic item through the grant function; one reward per account or device; enforced server-side; fraud cases tested (self-invite, repeat device, reward replay).", "review": true, "passes": false, "blocked": false, "attempts": 0},
    {"id": "S24", "phase": 4, "title": "Heartbeat and live stats page", "requires": ["supabase"], "acceptance": "A heartbeat RPC every 60 seconds (config) upserts player_state.last_seen for attested sessions; cached aggregate counters (players online = distinct last_seen within 2 minutes, total players, visits today, visits all time) refreshed every 30 seconds with no per-viewer DB query; counts never include NPCs, ambient pedestrians, or test bots (UX-3, test); all numbers use the shared compact formatter (UX-2); public /live page 'How New York is growing, live' with LIVE badge, 'updated Ns ago', and OG image; 'Post these numbers' button opens a pre-filled X post with tagline and referral-tagged link; no personal data exposed; tests.", "review": true, "passes": false, "blocked": false, "attempts": 0},
    {"id": "S29", "phase": 5, "title": "Zones, shards, and server-authored presence", "requires": ["supabase", "realtime"], "acceptance": "Migrations and security-definer RPCs join_zone, move, set_activity, leave_zone with RLS: join_zone assigns a shard of at most realtime.shardSize players (friends placed together when room allows), records membership, and returns the private topic plus a snapshot of players seen within 2 minutes, capped, excluding blocked users both ways and ghost-mode players; move validates the destination (known venue, landmark, station or in-zone point), the mode, borough unlock against the server-accepted level, and a minimum interval from config, then writes player_state and calls realtime.send with a private topic and an id-and-enum-only payload (from, to, mode, startedAt, durationMs); set_activity accepts only an enum; RLS on realtime.messages lets only shard members read a topic and lets no client insert; unattested accounts are refused; integration tests prove a non-member cannot subscribe, a client cannot broadcast, rate limits hold, blocked users never appear in each other's snapshots, and payloads contain no free text.", "review": true, "passes": false, "blocked": false, "attempts": 0},
    {"id": "S30", "phase": 5, "title": "Client realtime layer and graceful degradation", "requires": ["supabase", "realtime"], "acceptance": "A PresenceTransport interface in src/realtime with a Supabase implementation and an in-memory fake; the client joins the shard of its current zone, switches zones on travel, re-joins with exponential backoff after disconnect, leaves or pauses when the tab is hidden, and refreshes the access token on expiry; with env vars missing, offline, or Realtime unreachable the city stays fully playable solo with an honest 'You're offline' or 'City is quiet' status and no error toasts or console errors; unit tests with the fake transport for join, switch, reconnect and degrade; integration test against local Supabase.", "review": true, "passes": false, "blocked": false, "attempts": 0},
    {"id": "S31", "phase": 5, "title": "Other players and ambient life on the 3D map", "requires": ["supabase", "realtime", "webgl"], "acceptance": "Other players render as instanced low-poly avatars (billboards on the low tier) capped at the per-tier max visible, nearest first, interpolating movement intents along the same routes as S08; optional handle labels with a settings toggle; a 'N people here' count from the snapshot only (UX-3) using the shared formatter; scripted ambient pedestrians are visibly different from players, never selectable as players, and never counted (test); every player avatar is also listed in the Places panel venue occupant list (A11Y-3); per-tier draw-call and triangle budgets still pass with the max visible players; a two-browser Playwright test proves player B sees player A arrive at a venue within 3 seconds.", "review": true, "passes": false, "blocked": false, "attempts": 0},
    {"id": "S32", "phase": 5, "title": "Player surfaces, privacy, and ghost mode", "requires": ["supabase", "realtime"], "acceptance": "Tapping another player's avatar or occupant-list entry opens a player card showing only handle, avatar, server-accepted level and career path, with the shared player actions (Add friend, Mute, Block, Report); block removes both players from each other's snapshots and renders immediately and server-side thereafter; mute hides that player's avatar and emotes locally and persists; ghost mode (settings and HUD) removes the player from snapshots and stops their broadcasts server-side; the app never requests geolocation (test asserts the permission is never queried); two-browser Playwright tests for block, mute, report and ghost mode; axe passes.", "review": true, "passes": false, "blocked": false, "attempts": 0},
    {"id": "S33", "phase": 5, "title": "Preset emotes between players", "requires": ["supabase", "realtime"], "acceptance": "A fixed set of preset emotes from /data/copy (for example wave, hype, dap), sent through a server RPC with a per-sender rate limit from config and broadcast to the shard as an enum; no free text, no custom content, no voice; emotes from muted or blocked players never render; emotes are disabled at memorials; emotes never count toward or interact with the chat quota; tests for the rate limit, the block and mute filters, and memorial suppression.", "review": true, "passes": false, "blocked": false, "attempts": 0},
    {"id": "S34", "phase": 5, "title": "City-time live events and calendar", "requires": [], "acceptance": "Scheduled live events defined in /data/events/live keyed to city time (real New York time, with server time offset when online and device time offline), including a weekly club night and at least 4 calendar dates with generic names for trademarked events; the map shows upcoming events with a countdown; event bonuses come from config and are issued through the grant function (ECON-1); attendance counts shown to players come from real presence only (UX-3); no event at memorials; unit tests for scheduling across DST and for offline behavior.", "review": false, "passes": false, "blocked": false, "attempts": 0},
    {"id": "S35", "phase": 5, "title": "Realtime load, cost, and abuse test", "requires": ["supabase", "realtime"], "acceptance": "A script (npm run sim:realtime) runs at least 50 simulated clients against local Supabase across several zones and measures messages per player-minute, join rate and snapshot latency; a test fails if messages per player-minute exceed realtime.budgetMsgsPerPlayerMinute in config or if any client exceeds server rate limits without being refused; the run writes a cost projection (monthly messages and connections at 100, 1,000 and 5,000 average concurrent players, using the Supabase pricing recorded in CLAUDE.md) to progress.md; abuse cases tested: rapid move spam, zone-hop spam, joining a full shard, and reconnect storms.", "review": true, "passes": false, "blocked": false, "attempts": 0},
    {"id": "S25", "phase": 6, "title": "Premium catalog and clout rules", "requires": [], "acceptance": "/data/premium holds at least 8 premium items (outfits, apartment themes, profile badges, share-card frames) across rarity tiers, each with currency 'usd', a price tier from config, cloutValue, and styleValue; premium items cannot be bought or sold for in-game cash, have no sellValue, and cannot be transferred; total clout from premium items is capped by premiumCloutCap in config; premium store screen shows clear USD prices and owned state (purchase button wired in S26); S12 simulation extended so a bot owning every premium item stays within balance bounds and cannot reach Icon on premium clout alone; tests.", "review": true, "passes": false, "blocked": false, "attempts": 0},
    {"id": "S26", "phase": 6, "title": "Stripe Checkout and entitlements", "requires": ["supabase", "stripe"], "acceptance": "Stripe Checkout in test mode only, with the API version pinned to the one in the installed stripe-node; buying requires a saved account (guests are prompted to save progress first) and the server verifies the 18+ attestation before creating a session; the Checkout session is created server-side from catalog prices (the client never sends a price); the webhook verifies signatures and writes purchases and entitlements idempotently (duplicate-webhook test); entitlements restore on sign-in on any device and premium cosmetics become visible to other players only once the entitlement exists; a refund webhook revokes the entitlement, its clout, and its public visibility; tests using Stripe CLI fixtures.", "review": true, "passes": false, "blocked": false, "attempts": 0},
    {"id": "S27", "phase": 7, "title": "Copy, brand, and legal pages pass", "requires": [], "acceptance": "All player-facing text comes from the copy file with the slang pack applied to events, goals, prompts, emotes, chat quick-replies and limit messages, landmarks, live events, and share cards; welcome line and tagline present; placeholder Terms (stating 18+), Privacy (including 'No ad trackers, ever.' if still true), Purchases and Refunds, and Code of Conduct pages with a TODO for legal review; a credits page and in-app attribution for NYC Open Data, MTA (with not-endorsed and no-accuracy wording), OpenStreetMap with a link to openstreetmap.org/copyright and an ODbL download of any OSM-derived layer, and every CC0 or licensed asset.", "review": true, "passes": false, "blocked": false, "attempts": 0},
    {"id": "S28", "phase": 7, "title": "Polish, smoke test, deploy readiness", "requires": [], "acceptance": "Loading, empty, and error states on every screen; offline solo play works and the shared city degrades honestly; every perf.json budget passes in npm run budget and e2e:perf; README covers setup, env vars, local Supabase and Realtime, Stripe CLI, data sources, quality tiers and budgets, moderation setup (MODERATOR_EMAILS), the production Supabase plan requirement and Realtime cost projection, adding items, premium items, events, live events, venues, landmarks, zones, and copy, and Vercel deploy steps (the deploy itself is a human step); end-to-end smoke test passes: open link, welcome card, land on the 3D map, first action, visit a landmark, buy item, level up, share card, and (when Supabase is configured) a second browser sees the player move.", "review": false, "passes": false, "blocked": false, "attempts": 0}
  ]
}
```

---

## 5. Revised loop prompt (write to `docs/spec/loop-prompt.md`)

```markdown
# Loop iteration prompt

You are the **orchestrator** for one iteration of the autonomous build loop for Clout City: NYC
("Tap In. Blow Up."). You have fresh context; your memory is in the files. You delegate
specialist work to the subagents in `.claude/agents/` per CLAUDE.md's Orchestration Model.
Work serially on branch `dev` in the main checkout: no worktrees, no parallel code-writers.

1. **Read** `CLAUDE.md`, `progress.md` (environment, open rulings, learnings, blockers, phase
   reviews), `prd.json`, and the Build guardrails section of `docs/local/OPEN-ISSUES.md`.
   Confirm you are on `dev` (`git checkout dev`); never commit to or push `main`.
2. **Pick one task**: `passes` false, `blocked` not true, `phase` ≤ the phase limit at the end
   of this prompt. Order by phase, then number, then letter suffix (S04 < S04a < S04b < S05).
   If its acceptance names a blocked task, or architect finds a hard dependency on one, block it
   with reason "depends on S##" (step 4 rules) and stop.
   If no eligible task remains, go to step 14.
3. **Check attempts.** If `attempts` ≥ 3, set `blocked` true, summarise the earlier attempts
   (from Iteration notes) under "Blocked tasks", commit `S##: blocked after 3 attempts`, stop.
4. **Check requirements.** Compare `requires` with progress.md Environment. If any is "no", set
   `blocked` true, write exactly what a human must do under "Blocked tasks" (copy the unblock
   steps from Environment), commit `S##: blocked on <key>`, stop.
5. **Record the attempt.** Increment `attempts` in prd.json and commit `S##: start attempt N`
   before any other work.
6. **Plan (architect)** when the task has design weight: `review` is true, OR `requires` includes
   `webgl` or `realtime`, OR this is a retry (attempts ≥ 2). Give architect: the task JSON,
   CLAUDE.md, the guardrail rows for this task (CLAUDE.md / OPEN-ISSUES mapping), the relevant
   progress.md notes (including why earlier attempts failed, so it picks a different approach),
   and tell it: "Loop mode: the orchestrator approves; do not wait for the user; list any
   product ruling as a question." Review the plan against acceptance and CLAUDE.md. If it needs
   a ruling not covered by progress.md "Open rulings", block the task with the question, stop.
   Otherwise you approve it. Tasks without design weight go straight to step 7 with your own
   brief plan.
7. **Implement (code-ninja)** on `dev` with the approved plan, acceptance text, guardrails, and
   these limits: implement only this task; nothing CLAUDE.md marks out of scope; no commits, no
   pushes; never edit prd.json, progress.md, CLAUDE.md or acceptance text.
8. **Test (bug-hunter)**: write and run unit, integration (when `requires` includes supabase) and
   Playwright e2e tests (tests/e2e, one spec per flow) for every acceptance clause. Tell it: work
   in this checkout, no commits, never edit product code, never weaken an assertion to pass.
   **Fix loop:** if it reports product failures, pass the report to code-ninja to fix, then
   re-launch bug-hunter. At most 3 fix cycles this iteration. Existing tests may change only when
   this task's acceptance changes the behaviour they guard; note each such change in progress.md.
9. **Gates** (run them yourself; all must pass):
   `npm run format:check && npm run typecheck && npm run lint && npm test && npm run build`,
   plus `npm run e2e` when the task touches any user flow, `npm run test:integration` when it
   requires supabase, and `npm run budget && npm run e2e:perf` when it touches src/scene, /data/geo,
   assets or dependencies. Never mark a task passing without running the gates.
10. **On success:** set `passes` true, commit `S##: short description` (code, tests, prd.json,
    progress.md together), and append a short note under "Iteration notes" (what was built, what
    the next iteration should know). Add durable lessons to "Learnings and gotchas"; log economy
    tuning under "Tuning log". If S01 passes, its webgl smoke proves headless WebGL: set
    Environment `webgl: yes` in the same commit.
11. **On failure** (gates still red after the fix loop): `git stash push -u -m "S##-attempt-N"`,
    append a note under "Iteration notes" with what was tried and why it failed, commit
    progress.md as `S##: attempt N failed`, stop.
12. If `review` is true, also add a line under "Needs human review" saying exactly what a human
    should check (for 3D tasks always include real-device FPS on the reference phones).
13. If a task needs something you cannot do (keys, accounts, deploys, legal decisions, a
    product ruling), set `blocked` true, record exactly what is needed, commit, stop.
    **Findings:** the orchestrator records every new issue a subagent reports (bug, risk,
    question, guardrail breach) in `docs/local/OPEN-ISSUES.md` with an ID and evidence (Rule 22),
    and adds a one-line pointer (`OPEN-ISSUES: BUG-n …`) to that iteration's note, because
    docs/local is gitignored.
14. **Phase end.** When no eligible task remains in the highest phase within the limit and
    progress.md "Phase reviews" has no entry for it:
    a. Run `qa-mafia` (Mode A) against `npm run build && npm run start` locally, with that
       phase's user stories from progress.md "Phase user stories". Reports go to
       `qa-reports/phase-<N>-<story-slug>.md`. qa-mafia reports and stops; do not fix
       anything. Record each failure in OPEN-ISSUES.md and summarise verdicts under
       "Phase reviews". Skip any cleanup that needs the user; note it.
    b. `git push origin dev`, then open the PR (or comment on the open one) with
       `gh pr create --base main --head dev --title "Phase <N>: <phase name>"`. The body lists
       tasks passed and blocked, Needs human review items, and qa-mafia verdicts, and ends with
       the attribution line. Never merge. Never push to main.
    c. Commit progress.md as `loop: phase <N> review`.
15. Never edit tests just to make them pass. Never weaken acceptance criteria. Never edit
    CLAUDE.md or any task's acceptance text. Never mark a task passing without running the gates.

When no eligible task remains after your update (every task within the phase limit is passed or
blocked, and the phase-end step is done), output exactly: `<promise>COMPLETE</promise>`

Phase limit: <N>
```

---

## 6. Revised progress.md (write to the repo root)

```markdown
# Progress log

The loop appends here after each task. Fresh iterations read this first.

## Machine facts (2026-10-06)
- Node v24.19.0, npm 12.0.2 (Next.js 16.3.8 needs Node >= 20.9: OK)
- Docker 29.7.2 installed, daemon NOT running
- Supabase CLI: not installed globally. S01 adds it as an npm devDependency (`npx supabase`)
- Stripe CLI: not installed
- gh: installed (auth status unverified: run `gh auth status`)
- Playwright Chromium: installed (WebKit and Firefox not installed; optional)
- Network: available

## Environment (a human fills this in; the loop may set webgl only, per loop step 10)
Tasks whose `requires` includes an item marked no are blocked with these instructions.
- network: yes
- webgl: no (pending S01: becomes yes when tests/e2e/webgl-smoke.spec.ts passes)
  Unblock: if the smoke fails, follow the README note on Chromium launch flags, then set yes.
- supabase: no
  Unblock:
  1. Start Docker Desktop.
  2. After S01 has landed: `npx supabase start`.
  3. Copy API URL, anon key and service_role key from `npx supabase status` into .env.local as
     NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY.
  4. Set yes.
- realtime: no
  Unblock: supabase above, then confirm `npx supabase status` lists Realtime and
  `npm run check:realtime` passes (added with S29), then set yes.
- stripe: no
  Unblock:
  1. Install Stripe CLI (https://docs.stripe.com/stripe-cli).
  2. `stripe login`.
  3. Put test-mode STRIPE_SECRET_KEY and NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY in .env.local, and
     STRIPE_WEBHOOK_SECRET from `stripe listen --print-secret`.
  4. Set yes.
- playwright browsers installed: yes (chromium)
- github: yes if `gh auth status` shows a login with push access to origin; needed for phase PRs
- qa mailbox: no (QA_EMAIL / QA_EMAIL_PASSWORD in .env.local; needed only for deployed-env QA.
  Local magic links use the Supabase mail catcher)
- moderators: MODERATOR_EMAILS in .env.local (comma-separated; default: the user's account)

## Open rulings (defaults the loop uses until the user rules; see plan section 8)
- Q-A age gate: neutral year-of-birth picker; under 18 locks the gate 24 h on that device
- Q-B 18+ content: nightlife and alcohol as flavour only, never rewarded; no drugs, sexual
  content or gambling; mild profanity only
- Q-C clocks: personal game clock per player plus shared real NYC city time for shared features
- Q-D strangers: preset emotes only
- Q-E realtime vendor: Supabase Realtime behind PresenceTransport; migrate when the trigger in
  CLAUDE.md is hit
- Q-F visibility: guests visible under generated handles; ghost mode for everyone
- Q-G music: CC0 tracks only, no radio streams
- Q-H CAPTCHA: Turnstile on anonymous sign-in in production only (not local/e2e)

## Pinned versions and why (Rule 2)
- three 0.182.0: R3F 9.8.1 uses THREE.Clock (deprecated r183) and PCFSoftShadowMap
  (deprecated r186). Newer three versions warn in the console (PERF-1).
- typescript 6.0.3: typescript-eslint 8.71.1 requires < 6.1.0 (TypeScript 7.0.2 is latest).
- eslint 9.39.5: eslint-plugin-jsx-a11y 6.10.2 supports only up to ESLint ^9.
- Next 16 removed `next lint`: use the ESLint CLI.

## Learnings and gotchas
- Supabase Realtime bills a broadcast to N subscribers as N+1 messages. Keep shards small and
  send intents, not per-frame positions. Presence track() is not for high-frequency data.
- Supabase anonymous sign-ins: 30 per hour per IP by default (shared Wi-Fi and carrier NAT can
  hit it). Raise it in the dashboard for production and add Turnstile.
- Free Supabase projects pause after a week idle. Production needs Pro.
- Headless Chromium renders WebGL in software. Never assert FPS in CI; assert bytes, timings,
  draw calls and triangles.
- docs/local/ is gitignored: put OPEN-ISSUES pointers into iteration notes.

## Phase user stories (qa-mafia, Mode A, at phase end)
1. New visitor on a phone: opens the link, passes the 18+ welcome card, picks audio, lands on the
   3D map in Queens, takes or skips the tour, buys a first bodega breakfast, finds any place via
   the Places panel, still plays after going offline and reloading.
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
(none yet)

## Blocked tasks
(none yet)

## Needs human review
(none yet)

## Iteration notes
(none yet)
```

---

## 7. Risks and tradeoffs (Rule 20)

### 3D on cheap phones
**Risk.** Three plus R3F plus drei uses most of the JS budget. Parse and compile time on a 4x-throttled CPU dominates time to playable.

**Mitigations:**
- Lazy-load the 3D chunk behind an interactive DOM shell.
- Code-built landmarks (no glTF downloads).
- Merged or instanced districts.
- Render on demand.
- Three tiers plus runtime downgrade, with the Places panel as the floor.

**Tradeoff.** I re-baselined "3 s on 4G" to ≤ 2.5 s for the shell and ≤ 6 s to playable on low, cold. That is slower than the original target but honest for 3D.

**Gaps.** CI cannot measure FPS, so real-device checks are human-review items every phase. `e2e:perf` timings are noisy, which is why the test takes the median of 3 runs. If they still flap, keep the budgets and move them to a nightly job rather than loosening them.

**Version pin.** Pinning three 0.182.0 trades newer three features for PERF-1 compliance. Revisit when R3F moves to `THREE.Timer`.

### Realtime cost and scale
Model: shard size 16, about 2 server events per player per minute. That is about 32 messages per player-minute, or about 1.38M per average-concurrent player per month (about $3.50 at Supabase Pro overage).

| Average concurrent players | Messages per month | Approx. cost per month | Messages per second |
|---|---|---|---|
| 100 | ~138M | ~$330 | — |
| 1,000 | ~1.4B | ~$3.4k | ~530 |

At 1,000 the ~530 messages per second exceeds Pro's capped 500/s, so it needs Pro with no spend cap.

Durable Objects bills only incoming messages (20:1) and outgoing ones are free, so fan-out would be roughly two orders of magnitude cheaper.

**Recommendation.** Ship on Supabase (one vendor, RLS auth, local stack, testable) behind `PresenceTransport`. Migrate when S35's projection exceeds about $500 a month or sustained average concurrency passes about 150.

Writing every move to `player_state` and `realtime.messages` costs about 33 inserts per second at 1,000 concurrent players. That is acceptable, and it buys server authority and anti-spoofing. Realtime RLS policies are cached per connection, so a block takes effect on the next snapshot or rejoin. S32 also filters on the client immediately.

### Moderation in an 18+ shared world
Free-text surface with strangers is limited to handles and report notes. Emotes are presets and chat is friends-only.

**Residual risks:**
- Offensive handles that slip past the filter
- Harassment by emote spam (rate-limited, mute and block available)
- Stalking a player's avatar (mitigated by ghost mode, block both ways, no real-world geolocation)
- Fake reports used against someone (auto-hide threshold, human review)

Someone must staff `/mod` (Q-F).

Age assurance is self-declared. That is a reasonable baseline for a game with no sexual content, but it is not verification. Changing laws (state age-verification statutes) need a legal check before launch.

### Legal
**Landmark names.** `legalReviewed:false` until a human checks. Generic labels for branded names. Trademarked event names get generic names (S34).

**OSM ODbL.** Avoid OSM where NYC Open Data suffices. Any OSM-derived layer is a Derivative Database: offer it under ODbL from /credits and show "© OpenStreetMap contributors" with a link to openstreetmap.org/copyright.

**MTA terms:**
- No endorsement claims and no accuracy claims; both are covered.
- Host the data ourselves (we bundle it).
- **"You will not modify or delete any of the data"** conflicts with simplifying shapes. Mitigation: keep raw GTFS unmodified in the cache and treat rendered lines as derived artwork. **This needs a human or legal ruling before launch (SEC item).**

**NYC Open Data** is generally unrestricted. Record its terms of use in SOURCES.md.

**Audio.** CC0 only. No radio rebroadcast (Q-3).

**Privacy.** Storing the full date of birth is avoided; only a boolean and a timestamp are stored.

### Other
- **Simplicity vs scope.** 48 tasks versus the original 28. The 3D and realtime work is split so each task fits one iteration.
- **Retired task.** S17 is retired rather than renumbered. Selection order is now (phase, id), which the loop prompt states explicitly.

## 8. Open questions for the user (each has a default the loop uses)
1. **Q-A Age gate form.** Default: neutral year-of-birth picker at first launch; under 18 locks the gate for 24 h on that device; only a boolean and timestamp are stored. Alternative: an "I'm 18+" checkbox, faster but weaker.
2. **Q-B 18+ content.** Default: nightlife and alcohol as flavour only, never rewarded; no drugs, sexual content or gambling; mild profanity only.
3. **Q-C Clocks in a shared world.** Default: each player keeps a personal fast-forward game clock, and shared features run on real NYC time. Two players at the same club may be at different personal game times. Alternative: a single shared clock, which breaks the fast-forward actions.
4. **Q-D Stranger interaction.** Default: preset emotes only (S33). Alternative: none at all (drop S33).
5. **Q-E Realtime vendor and budget.** Default: Supabase Pro behind the transport interface, migrating to Durable Objects at the cost trigger. Also: are you OK with Pro without a spend cap at launch?
6. **Q-F Moderation staffing and visibility.** Default: you are the sole moderator via MODERATOR_EMAILS; guests are visible under generated handles; ghost mode for everyone.
7. **Q-G Music source (Q-3).** Default: CC0 loops, no radio. Commissioned music can come later.
8. **Q-H Turnstile CAPTCHA on anonymous sign-in.** It is a third-party script. Default: on in production only.
9. **Q-1 (still open) and the MTA "no modification" clause.** Default: proceed with generic labels for branded names and derived subway artwork; everything stays `legalReviewed:false` until legal review before launch.
10. **Out-of-scope list.** It still blocks IDEA-4, IDEA-5 (free text), IDEA-8, IDEA-9 and IDEA-12. Confirm it stands. Default: it stands.

### Critical Files for Implementation
- /Users/jesutoniaderibigbe/Downloads/cloutcity/CLAUDE.md
- /Users/jesutoniaderibigbe/Downloads/cloutcity/prd.json (new, from section 4; original at docs/spec/original/prd.json)
- /Users/jesutoniaderibigbe/Downloads/cloutcity/progress.md (new, from section 6)
- /Users/jesutoniaderibigbe/Downloads/cloutcity/docs/spec/loop-prompt.md (new, from section 5)
- /Users/jesutoniaderibigbe/Downloads/cloutcity/.claude/agents/qa-mafia.md and /Users/jesutoniaderibigbe/Downloads/cloutcity/.claude/agents/bug-hunter.md (placeholders), plus /Users/jesutoniaderibigbe/Downloads/cloutcity/docs/local/OPEN-ISSUES.md (record the SEC item for the MTA "no modification" clause and the PERF item for the three/R3F pin)