# Moderation sources

`handle-blocklist.json` holds the terms the server-side handle filter refuses
(`private.handle_allowed` in `supabase/migrations/*_s18a_handles_profile.sql`, twin
`src/lib/handles/filter.ts`). It is server data: browser code never imports it
(`src/lib/client-imports.test.ts`), and the database gets it through the migration's generated
seed (`npm run handles:sql`, checked by `scripts/moderation/blocklist-sql.test.ts`).

Every term is stored in **skeleton form**, the form the filter compares: lower case, letters and
digits only, leetspeak digits read as letters (0→o, 1→i, 3→e, 4→a, 5→s, 7→t, 8→b, 9→g).

- `contains` terms are refused anywhere in a handle, after the `allow` words are taken out.
- `exact` terms are refused as the whole handle, with or without trailing digits.
- `allow` holds innocent words that contain a `contains` term (badminton, cocktail, therapist).

Retrieved 2026-10-07. The lists are a starting point and need a human review (see the report
for S18a) before launch.

## List of Dirty, Naughty, Obscene, and Otherwise Bad Words (`ldnoobw`)

- Source: <https://github.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words>,
  file `en` at commit `4638b970cb8d9d82789564fcba1f4a1eb508ff1a` (403 lines, sha256
  `af851ecef1d5f212caba17339b12ac39cc2fef7d78c74876f67237644fcee8bd`).
- Licence: [Creative Commons Attribution 4.0 International (CC BY
  4.0)](https://creativecommons.org/licenses/by/4.0/).
- Attribution: "List of Dirty, Naughty, Obscene, and Otherwise Bad Words" by Shutterstock and
  contributors, licensed under CC BY 4.0. **Modified**: the list here is a transformation of the
  original, as follows.
- Changes made:
  1. Each entry lower-cased, with spaces and punctuation removed (`alabama hot pocket` →
     `alabamahotpocket`, `g-spot` → `gspot`), then put in skeleton form (`2g1c` → `2gic`).
  2. The one entry with no letters or digits (an emoji) dropped.
  3. Entries of five or more characters filed under `contains`, shorter ones under `exact`.
  4. Short entries that are slurs or core profanity with few innocent uses moved to `contains`:
     bdsm, clit, cock, coon, cunt, dick, fag, fuck, jizz, kike, nsfw, porn, pthc, rape, sex,
     shit, slut, spic, twat, xxx.
  5. Long entries that are innocent fragments or common words moved to `exact`: bigblack,
     hotchick, tightwhite, tiedup, girlon, tastemy, jellydonut, taintedlove, hardcore,
     domination, barenaked, dogstyle, hotcarl, hugefat, jackoff, mrhands, rosypalm, violetwand,
     wrappingmen, swinger, shota, snowballing.
  6. Duplicates after these steps merged.

## The Big Username Blocklist (`bigUsernameBlocklist`)

- Source: <https://github.com/marteinn/The-Big-Username-Blocklist>, file `list.json` at commit
  `e13d824dfc8cd0a17f5e627a2bbf5c067dfeb2e1` (542 entries, sha256
  `fe13b62a522c732065261c50734c36d45cc4f42d9c1ff320b721226aaf403565`).
- Licence: MIT. Copyright (c) 2015-2021 Martin Sandström. Permission is hereby granted, free
  of charge, to any person obtaining a copy of this software and associated documentation files
  (the "Software"), to deal in the Software without restriction, including without limitation
  the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
  the Software, and to permit persons to whom the Software is furnished to do so, subject to the
  following conditions: The above copyright notice and this permission notice shall be included
  in all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS",
  WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
  OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN
  ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE
  OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
- Changes made: each entry lower-cased with punctuation removed (`.well-known` → `wellknown`);
  entries that do not start with a letter (`400`, `404`) dropped, since no handle can match
  them; the rest put in skeleton form and filed under `exact`.

## Curated lists (`staff`, `brand`, `agency`, `extra`)

Written for Clout City: NYC (original work, same licence as the rest of the repository).

- `staff`: our own name and team, moderator, admin and support titles, system words, and the
  clout level names, so nobody can pass as staff or as a level badge.
- `brand`: platforms, payment apps and game brands players might impersonate.
- `agency`: New York City and federal agencies and offices (NYPD, FDNY, MTA, mayor, police).
- `extra`: slurs and hate terms the sources miss, and drug names (CLAUDE.md "Safety rules":
  no drug references, no slurs).

Short or common words (`mod`, `mta`, `apple`, `meta`, `cia`) are `exact` so they do not refuse
innocent handles (`Modern`, `CalmTaxi`, `Pineapple`, `Metro`, `Social`).
