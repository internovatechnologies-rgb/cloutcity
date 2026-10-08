# Audio sources

Every sound in Clout City: NYC is released under **CC0 1.0 Universal** (public domain
dedication, <https://creativecommons.org/publicdomain/zero/1.0/>). No attribution is required;
we credit the authors anyway (the in-game "Title by Artist" line and /credits).

All audio is served from our own origin under `/audio/`. The game plays no streams, no radio and
nothing from any other site.

`npm run audio:build` rebuilds every file below from the pinned originals in
`scripts/audio/sources.json` (downloaded into the gitignored `.cache/audio/`, each checked against
the sha256 recorded here). `npm run audio:build -- --check` verifies the committed files offline.

Licences were checked on each source page on 2026-10-06, when the originals were downloaded.

## Transformations (all assets)

1. Excerpt (music and ambience only, times below).
2. Downmix to mono (both music originals are already mono).
3. Two-pass EBU R128 loudness normalisation (ffmpeg `loudnorm`, linear): music −16 LUFS,
   ambience −26 LUFS, sound effects −18 LUFS (measured padded to 3 s), true peak −1 dBTP.
4. Music and ambience: the excerpt's last seconds are crossfaded (quarter-sine) into its start,
   so the file loops without a seam.
5. Resampled to 48 kHz and encoded twice: Opus in WebM (music 64 kbps, ambience 40, sfx 48, VBR)
   and AAC-LC in .m4a (music 64 kbps, ambience 48, sfx 64). Metadata stripped.

## Music

| id           | title             | author   | page                                                | licence (deed)                                                | retrieved  | original file                                                                                                           | original sha256                                                    | excerpt                          |
| ------------ | ----------------- | -------- | --------------------------------------------------- | ------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------- |
| `lofi-loop`  | Lofi Hip Hop Loop | omfgdude | <https://opengameart.org/content/lofi-hip-hop-loop> | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | 2026-10-06 | `LofiLoop_2.ogg` from <https://opengameart.org/sites/default/files/LofiLoop_2.ogg> (1,430,666 B, Vorbis 22.05 kHz mono) | `e57ba821d4db8d66783ca984a2778ec68d1439e862239ec36407344ef3bd1eab` | 8 s to 52 s, 2 s loop crossfade  |
| `lofi-again` | Lofi again        | Omfgdude | <https://opengameart.org/content/lofi-again>        | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | 2026-10-06 | `lofiagain.ogg` from <https://opengameart.org/sites/default/files/lofiagain.ogg> (2,419,417 B, Vorbis 44.1 kHz mono)    | `d3b3410a186d45dadbcf87a8072b5a7f3b3f5a11fe38d9a7e9bdb3f66d5d86fa` | 10 s to 54 s, 2 s loop crossfade |

## Ambience

| id          | title                                                                                                 | author      | page                                                      | licence (deed)                                                | retrieved  | original file                                                                                                                                                                      | original sha256                                                    | excerpt                            |
| ----------- | ----------------------------------------------------------------------------------------------------- | ----------- | --------------------------------------------------------- | ------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------- |
| `nyc-night` | New York City night evening rooftop ambience traffic, Bushwick, Brooklyn, above-ground subway M train | SpliceSound | <https://freesound.org/people/SpliceSound/sounds/369891/> | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | 2026-10-06 | Freesound's public high-quality preview `369891_1480854-hq.mp3` from <https://cdn.freesound.org/previews/369/369891_1480854-hq.mp3> (23,350,612 B, MP3 48 kHz stereo, 22 min 39 s) | `a22873c91e153c24214d808c54ed2f7c186b6884c867c4afdacdef68cd101213` | 120 s to 154 s, 3 s loop crossfade |

## Sound effects

| id         | title                                                    | author | page                                        | licence (deed)                                                                             | retrieved  | original file                                                                                                                                            | original sha256 (archive)                                          |
| ---------- | -------------------------------------------------------- | ------ | ------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `ui-tap`   | Interface Sounds, `Audio/click_001.ogg`                  | Kenney | <https://kenney.nl/assets/interface-sounds> | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) (License.txt in the archive) | 2026-10-06 | `kenney_interface-sounds.zip` from <https://kenney.nl/media/pages/assets/interface-sounds/fa43c1dd4d-1677589452/kenney_interface-sounds.zip> (834,536 B) | `f2193d072726d6758a5f7871b2dcc54dcce0d5c35c6f0a62f92549b327c81232` |
| `purchase` | Interface Sounds, `Audio/confirmation_002.ogg`           | Kenney | <https://kenney.nl/assets/interface-sounds> | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) (License.txt in the archive) | 2026-10-06 | same archive as `ui-tap`                                                                                                                                 | `f2193d072726d6758a5f7871b2dcc54dcce0d5c35c6f0a62f92549b327c81232` |
| `clout-up` | Music Jingles, `Audio/Steel jingles/jingles_STEEL12.ogg` | Kenney | <https://kenney.nl/assets/music-jingles>    | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) (License.txt in the archive) | 2026-10-06 | `kenney_music-jingles.zip` from <https://kenney.nl/media/pages/assets/music-jingles/f37e530b9e-1677590399/kenney_music-jingles.zip> (1,239,525 B)        | `b729ba57959bd58793d2c5cafa348aaf2655d354f3da35ec4729e03ec77197b8` |
