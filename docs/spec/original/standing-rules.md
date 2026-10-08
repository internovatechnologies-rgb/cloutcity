# Clout City: NYC: standing rules

**Clout City: NYC** (tagline: **"Tap In. Blow Up."**) is a mobile-first, browser-based, Sims-style life game set on a stylized version of the real map of New York City. Use the name and tagline consistently in the app title, PWA manifest, landing page, share cards, and store listings. The player is a teen, university student, or early-career person trying to **"Make it in New York"** (become famous: influencer, streamer, artist/DJ, founder/hustler). Art, copy, characters, invented venues, and code are original. The geography and iconic public landmarks are real. Do not copy any existing game.

## Stack
- Next.js (App Router), TypeScript strict, Tailwind
- Zustand (persisted to localStorage), Supabase (anonymous auth, Postgres, RLS), Stripe Checkout (**test mode only**, phase 5)
- PWA, mobile-first (design for 390px width), deploy target Vercel
- Tests: Vitest for logic, Playwright for end-to-end

## Architecture rules
- Game logic lives in pure functions under `/src/engine`, with no React imports. UI only calls the engine.
- All content (items, premium items, events, NPCs, jobs, venues, landmarks, geography, copy) lives in `/data`. All balance numbers live in `/data/config`. Never hardcode numbers in components.
- All player-facing copy comes from `/data/copy` through a slang-pack layer so slang can be swapped without code changes.
- Player state is local-first: cash, stats, and inventory live in the Zustand store and sync to Supabase saves when signed in. Solo play must work offline and without Supabase configured.
- Server-side enforcement for anything that matters: chat quota and message filtering, friend boosts, roommate links, referral rewards, real-money purchases and entitlements, live stats. Never trust the client for these.
- **Out of scope:** no player-to-player transfer of cash or items, no trading, no gifting between players, no group or crew chat, and no way to raise the chat limit. Do not build these, even partially.
- Every Supabase table has Row Level Security.

## Map and landmarks
- Real geography (borough shapes, water, major parks, subway lines) comes from public sources (NYC Open Data, MTA public GTFS, OpenStreetMap), preprocessed into `/data/geo` by a reproducible script in `/scripts`. Record sources and licenses in `/data/geo/SOURCES.md` and show required attribution in the app.
- The map is drawn in the game's sticker style. No third-party tile services, no Google Maps, no photos of real places.
- Iconic landmarks sit at real coordinates in these categories: bridge, building, monument, park, stadium, government, station, neighborhood, memorial.
- Businesses (bodegas, food spots, coffee shops, boutiques, clubs, job sites) are invented, with original names.
- Trademarked or corporate-branded names (for example the Empire State Building, Rockefeller Center, sponsored stadium names) use generic labels ("the Queens ballpark"). Every landmark has `nameMode` (`real` or `generic`) and `legalReviewed: false` until a human checks it.
- Do not use MTA logos or official line bullet designs. Plain line letters and numbers drawn in our own style are fine.
- Memorials are respectful, look-only stops: an info card, with no flex, clout, events, or jokes.
- No crime events at government buildings or memorials.

## Non-negotiable product principles
1. **Instant map start.** A link lands the player on a playable map within seconds. No signup, no login wall. Guest session is automatic. "Save your progress" prompt only after the first milestone. Guest progress must carry over to the account.
2. **Goal: Make it in New York.** Four career paths (influencer, streamer, artist/DJ, founder/hustler) share one clout ladder: Nobody, Local, Scene Regular, Known, Famous, Icon. Icon triggers a milestone moment and a prestige option.
3. **Teen voice.** Playful, confident, NYC attitude. Slang in flavor text, NPC dialogue, events, notifications, share cards. Buttons, stat names, and prices stay plain and clear.
4. **Friends early and often, with an advantage.** Friend prompts appear after wins, never before. Persistent "Add friends" in the HUD. Advantages: daily friend boost, a capped per-friend clout bonus, and a roommate rent discount (each roommate pays less; no cash moves between players). Friends are an advantage, not a requirement; solo play stays fully progressable. Cap invite prompts per session. Never scrape contacts.

## Two kinds of purchases
- **In-game cash items** are earned through play and bought with in-game cash. They drive progression: clothing, makeup, gifts, decor, apartment upgrades. They have `sellValue` (with depreciation), `cloutValue`, and `statEffects`.
- **Premium items** are bought with real money only (USD via Stripe). They can never be bought or sold for in-game cash and can never be transferred. They may add clout and style, but total clout from premium items is capped by `premiumCloutCap` in `/data/config`, and premium clout alone can never reach Icon.
- Never sell in-game cash, energy, time skips, or clout directly for real money.
- Gifts are consumed (money sink): used on NPCs during events or on yourself, never sent to other players.

## Safety rules (teens are the audience)
- Content stays teen-safe: no drug references, no sexual content, no mocking of any group, crime is mild and cartoonish.
- Age check happens before the first chat message, friend request, invite or share, or real-money purchase. Never before solo play or in-game cash purchases. Under 13: solo play only, chat, all other social features, and real-money purchases blocked. 13-17: friends-only chat, no contact sharing, parental-consent notice before real-money purchases.
- Chat: one-to-one between accepted friends only. Max **10 text messages per player per day** (New York midnight reset), 140 characters each, enforced server-side and atomically. The limit is fixed at 10 for every player: it is never sold, rewarded, earned, tiered by age, or raised by any feature. Reactions and preset quick-replies are unlimited and do not count. No links, images, phone numbers, emails, or social handles in messages. A message rejected by the filter does not use quota. Report and block on every chat.
- Report and block on every friend surface.

## Balance anchors (tunable in /data/config)
- 1 real minute = 10 game minutes of passive time. Actions (shifts, travel, meals, visits) fast-forward the clock instantly by their duration with a short animation; the player never waits in real time for an action to finish. Game day = 24 game hours. Rent due every 7 game days.
- Start: $150 cash, Queens room. Rent: Queens room $280/wk, Brooklyn 1BR $520/wk, Manhattan loft $1100/wk.
- Jobs (4-hour shifts): barista $14/hr, retail $16/hr, delivery $18/hr (higher energy cost), junior dev $35/hr (needs clout level). Food $4-12. Subway fare $3.
- Target feel: a new player working about 2 shifts a day can pay rent and save roughly $150/week; the first apartment upgrade lands around game day 10-14. If the wage anchors and this target conflict, keep the target and tune costs (food, energy recovery, transit), not wages. Log the change in progress.md.
- Rarity tiers: Common (frequent, cheap), Medium, Rare (expensive, limited).
- Premium price tiers live in `/data/config` and are placeholders until a human sets them.

## Art direction
Flat, bold, sticker-style illustration with a warm night-city palette (deep indigo, hot pink, taxi yellow). Landmarks are illustrated in the same style, never photos. Emoji and SVG allowed; permissively licensed assets only. Chunky thumb-friendly UI, snappy animations, juicy feedback on every purchase and clout gain.

## Voice samples (match this energy; refresh seasonally)
- Bodega: "Bacon egg & cheese. It's giving breakfast of champions."
- MTA delay: "The train is 'experiencing delays.' You are experiencing main-character suffering."
- Rent due: "Landlord said 'rent' and your wallet said 'not today.'"
- Clout up: "Your name's starting to ring. Brooklyn noticed."
- Landmark flex: "Brooklyn Bridge at golden hour. The algorithm is about to eat."
- Friend prompt: "That W deserves witnesses. Tag a friend in?"
- Welcome: "Welcome to Clout City. Tap in. Blow up."
- Share card footer: "Tap In. Blow Up. | Clout City: NYC"

## Conventions
- Small commits, one task per commit, message format `S##: short description` (for example `S07: add landmark data`). Loop housekeeping commits use `loop: short description`.
- Write unit tests for engine logic (clock, stats, travel, rent, economy, clout, premium cap, age gate rules, chat quota and filter).
- Keep a README with setup, env vars, data sources, and how to add items, events, venues, landmarks, and copy.
