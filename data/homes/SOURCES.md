# Homes

Where each home (`HOME_IDS`, src/lib/data/homes.ts) sits on the map: the player's start point
and avatar position (S05). The points are plausible residential blocks chosen by hand, not
real addresses; no building or business is depicted.

| Home           | Neighbourhood                                       | Point (WGS84)     | Checked                                                               |
| -------------- | --------------------------------------------------- | ----------------- | --------------------------------------------------------------------- |
| queens-room    | Astoria, Queens (zone qn01), near Late Lantern Deli | 40.7651, −73.9247 | On land, in qn01, not in a park (src/lib/world/homes-content.test.ts) |
| brooklyn-1br   | Bedford-Stuyvesant, Brooklyn (zone bk03)            | 40.6872, −73.9418 | Same checks                                                           |
| manhattan-loft | Lower East Side, Manhattan (zone mn03)              | 40.7180, −73.9860 | Same checks                                                           |

Zones and land come from the S04 geo layers (data/geo/SOURCES.md).
