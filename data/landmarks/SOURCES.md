# Landmark sources

Coordinates are Wikidata "coordinate location" (P625) values, which Wikidata publishes under
CC0 1.0 (<https://creativecommons.org/publicdomain/zero/1.0/>). Retrieved 2026-10-06. Values
are rounded to 5 decimal places (about 1 m). Approach points marked "approximate" were picked
by hand on public land and checked against the S04 borough and zone layers by
`src/lib/world/places-content.test.ts`.

Every landmark has `legalReviewed: false` until a human checks its name and depiction.

## nameMode rule

A landmark uses a `generic` label when its real name contains a corporate or sponsor brand,
or when its owner actively licenses or claims the name or image as commercial IP. Civic,
park and place names owned by the public stay `real`. Generic ids are brand-free.

## Landmarks

| id                       | Wikidata                                            | location                                    | approach                                             | nameMode                              | reasoning                                                                                                                                                   |
| ------------------------ | --------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `brooklyn-bridge`        | Q125006                                             | 40.70567, -73.99633 (midspan, water)        | Brooklyn Bridge Park Q929440, 40.69778, -73.99833    | real                                  | City-owned bridge; public place name.                                                                                                                       |
| `manhattan-bridge`       | Q125050                                             | 40.70722, -73.99083 (midspan, water)        | Canal St / Bowery, 40.71640, -73.99510 (approximate) | real                                  | City-owned bridge.                                                                                                                                          |
| `queensboro-bridge`      | Q125157                                             | 40.75694, -73.95472 (over Roosevelt Island) | Queensbridge Park Q49547265, 40.75639, -73.94889     | real ("Queensboro Bridge")            | City-owned bridge; the common name, not the official dedication.                                                                                            |
| `wedge-building`         | Q220728                                             | 40.74111, -73.98972                         |                                                      | generic ("Fifth Ave wedge")           | The owner asserts image rights in the building; a USPTO 3D-configuration application (98342455) covers its shape.                                           |
| `deco-spire`             | Q11274                                              | 40.75143, -73.97572                         |                                                      | generic ("Lexington Deco spire")      | The building's name is a car-maker brand.                                                                                                                   |
| `statue-of-liberty`      | Q9202                                               | 40.68921, -74.04443 (Liberty Island)        | The Battery Q13689, 40.70361, -74.01611              | real                                  | National monument; viewed from Battery Park.                                                                                                                |
| `washington-square-arch` | Q2550491                                            | 40.73124, -73.99710                         |                                                      | real                                  | City park monument.                                                                                                                                         |
| `central-park`           | Q160409                                             | 40.78250, -73.96611                         |                                                      | real                                  | City park.                                                                                                                                                  |
| `high-line`              | Q843869                                             | 40.74830, -74.00500                         |                                                      | real (review flag)                    | City park name. Kept real by the S07 plan decision and flagged for legal review, as the park's non-profit operator also uses the name for its own programs. |
| `prospect-park`          | Q1049632                                            | 40.66143, -73.97035                         |                                                      | real                                  | City park.                                                                                                                                                  |
| `flushing-meadows`       | Q745296 (park), Q717956 (Unisphere, the point used) | 40.74639, -73.84500                         |                                                      | real ("Flushing Meadows Corona Park") | City park. The info copy names the Unisphere: flagged for legal review.                                                                                     |
| `astoria-park`           | Q4811114                                            | 40.77944, -73.92194                         |                                                      | real                                  | City park.                                                                                                                                                  |
| `queens-ballpark`        | Q1072882                                            | 40.75699, -73.84578                         |                                                      | generic ("Queens ballpark")           | Sponsored stadium name; team names are trademarks.                                                                                                          |
| `brooklyn-arena`         | Q807966                                             | 40.68265, -73.97469                         |                                                      | generic ("Brooklyn arena")            | Sponsored arena name.                                                                                                                                       |
| `city-hall`              | Q1065206                                            | 40.71278, -74.00611                         |                                                      | real ("City Hall")                    | Government building.                                                                                                                                        |
| `brooklyn-borough-hall`  | Q929403                                             | 40.69278, -73.99028                         |                                                      | real                                  | Government building.                                                                                                                                        |
| `queens-borough-hall`    | Q2122585                                            | 40.71361, -73.82806                         |                                                      | real                                  | Government building.                                                                                                                                        |
| `midtown-terminal`       | Q11290                                              | 40.75278, -73.97722                         |                                                      | generic ("42nd St terminal")          | The operator's licensing program claims the terminal's name and image.                                                                                      |
| `penn-station`           | Q54451                                              | 40.75064, -73.99390                         |                                                      | real (review flag)                    | Common place name of a public rail station. Kept real by the S07 plan decision and flagged for legal review.                                                |
| `jamaica-station`        | Q11310077                                           | 40.69972, -73.80778                         |                                                      | real                                  | Place name.                                                                                                                                                 |
| `times-square`           | Q11259                                              | 40.75750, -73.98583                         |                                                      | real                                  | Public place name.                                                                                                                                          |
| `dumbo`                  | Q1264951                                            | 40.70306, -73.98944                         |                                                      | real ("DUMBO")                        | Neighborhood name.                                                                                                                                          |
| `coney-island-boardwalk` | Q4380603                                            | 40.57330, -73.97880                         |                                                      | real                                  | City boardwalk. Copy never names rides or amusement brands.                                                                                                 |
| `flushing-main-street`   | Q6736067                                            | 40.76060, -73.83060                         |                                                      | real                                  | Street and neighborhood name.                                                                                                                               |
| `september-11-memorial`  | Q1136137                                            | 40.71139, -74.01361                         |                                                      | real ("9/11 Memorial")                | Memorial: look-only, plain factual copy in base only, never overridden by a slang pack.                                                                     |
| `bronx-ballpark`         | Q753529                                             | 40.82957, -73.92639                         |                                                      | generic ("Bronx ballpark")            | Team and stadium names are trademarks. Teaser on expanding-soon land.                                                                                       |
| `staten-island-ferry`    | Q5927015 (St. George terminal point)                | 40.64330, -74.07420                         |                                                      | real                                  | City service. Teaser on expanding-soon land.                                                                                                                |

## Model heights

Code-built low-poly models (S07a, `data/landmarks/models.json`). Model tops come from Wikidata
"height" (P2048, CC0 1.0), retrieved 2026-10-07, where Wikidata has one; every other height is
stylised and approximate. A bridge's height is its tower top above the water. Placement and
heading come from NYC DCP LION street centerlines (see `data/geo/SOURCES.md`, "LION street
centerlines") and are written to `landmarks/frames.derived.json` by `npm run geo:build`.

LEGAL-1: `wedge-building` and `midtown-terminal` are plain massing (no ornament, no sculpture
group, no clock); `deco-spire` ends in a generic tapered spire, not a copy of the real crown;
`penn-station` is generic entrance pavilions and a canopy only. No model carries text, signage,
logos or clock faces.

| id                      | archetype        | depiction | top     | height source                              | orientation                               |
| ----------------------- | ---------------- | --------- | ------- | ------------------------------------------ | ----------------------------------------- |
| `brooklyn-bridge`       | suspensionBridge | stylised  | 84 m    | Wikidata Q125006 P2048 = 84 m (CC0)        | LION `BROOKLYN BRIDGE` → 136°             |
| `manhattan-bridge`      | suspensionBridge | stylised  | 102 m   | Wikidata Q125050 P2048 = 102 m (CC0)       | LION `MANHATTAN BRIDGE` → 157°            |
| `queensboro-bridge`     | cantileverBridge | stylised  | 105 m   | Wikidata Q125157 P2048 = 105 m (CC0)       | LION `ED KOCH QUEENSBORO BRIDGE` → 119.7° |
| `wedge-building`        | wedgeTower       | massing   | 94 m    | Wikidata Q220728 P2048 = 94 m (CC0)        | LION `5 AVENUE` → 29.4°                   |
| `deco-spire`            | setbackSpire     | stylised  | 318.9 m | Wikidata Q11274 P2048 = 318.9 m (CC0)      | LION `LEXINGTON AVENUE` → 298.9°          |
| `midtown-terminal`      | terminalHall     | massing   | 36 m    | approximate (stylised; no Wikidata height) | LION `VANDERBILT AVENUE` → 207.7°         |
| `penn-station`          | stationConcourse | stylised  | 13 m    | approximate (stylised; no Wikidata height) | LION `8 AVENUE` → 299°                    |
| `jamaica-station`       | stationConcourse | stylised  | 22 m    | approximate (stylised; no Wikidata height) | LION `SUTPHIN BOULEVARD` → 69.9°          |
| `staten-island-ferry`   | stationConcourse | stylised  | 20 m    | approximate (stylised; no Wikidata height) | LION `FERRY TERMINAL VIADUCT` → 58.8°     |
| `city-hall`             | civicHall        | stylised  | 34 m    | approximate (stylised; no Wikidata height) | LION `CITY HALL PARK GREENWAY` → 205.6°   |
| `brooklyn-borough-hall` | civicHall        | stylised  | 33 m    | approximate (stylised; no Wikidata height) | LION `JORALEMON STREET` → 12.7°           |
| `queens-borough-hall`   | civicHall        | stylised  | 20 m    | approximate (stylised; no Wikidata height) | LION `QUEENS BOULEVARD` → 208.8°          |
