/**
 * Schema for data/config/scene.json: the 3D city's camera rig, layer heights and render sizes.
 * Distances are metres (1 scene unit = 1 m), angles degrees, widths CSS pixels. Colours are not
 * here: they are palette tokens in data/config/theme.json (`scene`).
 */
import { z } from 'zod'
import { LandmarkSceneConfigSchema } from './landmarkModels'

const metres = z.number().positive()
const ratio = z.number().positive()

/** A default angle and the range the player may move it within. */
const AngleRangeSchema = z
  .strictObject({ default: z.number(), min: z.number(), max: z.number() })
  .refine((angle) => angle.min <= angle.default && angle.default <= angle.max, {
    error: 'default must lie within min..max',
  })

const KEYFRAME_IDS = ['dawn', 'morning', 'day', 'golden', 'dusk', 'night'] as const
const unit = z.number().min(0).max(1)

/** One keyframe of the day (src/lib/dayNight/types.ts `SceneKeyframe`). */
const DayNightKeyframeSchema = z.strictObject({
  id: z.enum(KEYFRAME_IDS),
  /** Game minute of day the keyframe is reached. */
  atMinute: z.int().min(0).max(1439),
  /** Minutes it stays fully on before blending towards the next keyframe. */
  holdMinutes: z.int().nonnegative(),
  /** The interface palette from this keyframe on (S04g). */
  ui: z.enum(['day', 'night']),
  /** Azimuth clockwise from north, elevation above the horizon (clamped to minSunElevationDeg). */
  sun: z.strictObject({ azimuthDeg: z.number(), elevationDeg: z.number().min(-90).max(90) }),
  sunIntensity: z.number().nonnegative(),
  /** LightShadow.intensity: the shadow fades at night instead of being switched off. */
  shadowIntensity: unit,
  ambientIntensity: z.number().nonnegative(),
  hemisphereIntensity: z.number().nonnegative(),
  /** Lit windows and landmark glow, 0 by day to 1 at night (the shared uNightGlow uniform). */
  nightGlow: unit,
})

export const DayNightConfigSchema = z
  .strictObject({
    /** Lighting changes in steps of this many game minutes (must divide 1440). */
    quantizeMinutes: z.int().positive(),
    minSunElevationDeg: z.number().min(0).lt(90),
    /** Shown until the HUD has read the save (a new game starts at 08:00). */
    unknownMinute: z.int().min(0).max(1439),
    /** Fog near and far, as multiples of the camera distance. */
    fog: z.strictObject({ nearPerDistance: ratio, farPerDistance: ratio }),
    /**
     * The apartment (S16): the city keyframe's sun and ambient scaled for indoors, and the share
     * of warm lamp light mixed into the ambient colour at full night glow.
     */
    room: z.strictObject({ sunScale: ratio, ambientScale: ratio, lampMix: unit }),
    /** Every keyframe once, in clock order. */
    keyframes: z.array(DayNightKeyframeSchema).length(KEYFRAME_IDS.length),
  })
  .refine((d) => 1440 % d.quantizeMinutes === 0, {
    error: 'quantizeMinutes must divide a day of 1440 minutes',
    path: ['quantizeMinutes'],
  })
  .refine((d) => d.fog.nearPerDistance < d.fog.farPerDistance, {
    error: 'fog must start before it ends',
    path: ['fog'],
  })
  .refine((d) => d.keyframes.every((k, i) => k.id === KEYFRAME_IDS[i]), {
    error: `keyframes must be ${KEYFRAME_IDS.join(', ')}, in that order`,
    path: ['keyframes'],
  })
  .refine(
    (d) =>
      d.keyframes.every((k, i) => {
        const next = d.keyframes[(i + 1) % d.keyframes.length]
        if (next === undefined) return false
        if (i + 1 < d.keyframes.length && next.atMinute <= k.atMinute) return false
        return k.holdMinutes < (next.atMinute - k.atMinute + 1440) % 1440
      }),
    {
      error: 'keyframes must be in clock order, each hold ending before the next',
      path: ['keyframes'],
    },
  )
  .refine(
    (d) =>
      d.keyframes.filter((k, i) => k.ui !== d.keyframes[(i + 1) % d.keyframes.length]?.ui)
        .length === 2,
    { error: 'the interface must switch to night once and back to day once', path: ['keyframes'] },
  )

export const SceneConfigSchema = z.strictObject({
  /** The camera starts over the player's home (data/homes/homes.json), not a fixed point. */
  camera: z
    .strictObject({
      fovDeg: z.number().gt(0).lt(180),
      distanceM: metres,
      minDistanceM: metres,
      maxDistanceM: metres,
      /** 0 looks straight down; keep it under 90 so the camera stays above the ground. */
      polarDeg: AngleRangeSchema.refine((a) => a.min >= 0 && a.max < 90, {
        error: 'polar angles must lie in [0, 90)',
      }),
      /** 0 is north-up; the range must stay within one turn. */
      azimuthDeg: AngleRangeSchema.refine((a) => a.min >= -180 && a.max <= 180, {
        error: 'azimuth angles must lie in [-180, 180]',
      }),
      /** The near plane follows the camera distance, clamped, to keep depth precision. */
      nearPerDistance: ratio,
      nearMinM: metres,
      nearMaxM: metres,
      /** The far plane is fixed at this multiple of maxDistanceM. */
      farPerMaxDistance: z.number().min(1),
    })
    .refine((c) => c.minDistanceM <= c.distanceM && c.distanceM <= c.maxDistanceM, {
      error: 'distanceM must lie within minDistanceM..maxDistanceM',
      path: ['distanceM'],
    })
    .refine((c) => c.nearMinM <= c.nearMaxM, {
      error: 'nearMinM must not exceed nearMaxM',
      path: ['nearMinM'],
    }),
  /** Borough land is extruded `heightM` deep with its bottom `baseM` below the water plane. */
  land: z
    .strictObject({ heightM: metres, baseM: z.number().nonnegative() })
    .refine((land) => land.baseM < land.heightM, {
      error: 'baseM must be below heightM so the land shows above the water',
    }),
  /** The water plane extends this far beyond the sea polygon. */
  water: z.strictObject({ extraM: z.number().nonnegative() }),
  /** Parks sit this far above the land top. */
  parks: z.strictObject({ liftM: metres }),
  subway: z.strictObject({
    liftM: metres,
    lineWidthPx: z.number().positive(),
    /** A dark casing under the ribbons (S04b turns it off on the low tier). */
    casing: z.boolean(),
    casingWidthPx: z.number().positive(),
  }),
  stations: z
    .strictObject({
      radialSegments: z.int().min(3),
      heightM: metres,
      /** Marker radius grows with camera distance (clamped) so stations stay visible. */
      radiusPerDistance: ratio,
      minRadiusM: metres,
      maxRadiusM: metres,
      /** Markers are rescaled when the distance changes by more than this factor. */
      rescaleRatio: z.number().gt(1),
    })
    .refine((s) => s.minRadiusM <= s.maxRadiusM, {
      error: 'minRadiusM must not exceed maxRadiusM',
    }),
  /**
   * The player's avatar placeholder (S05): a toon capsule on a flat ring at the player's home.
   * Like the station markers it grows with camera distance (clamped), so it stays visible from
   * the default view and never towers over the street up close. Ratios are of its height.
   */
  avatar: z
    .strictObject({
      heightPerDistance: ratio,
      minHeightM: metres,
      maxHeightM: metres,
      /** Capsule radius. */
      radiusRatio: z.number().gt(0).lt(0.5),
      ringOuterRatio: ratio,
      ringInnerRatio: z.number().nonnegative(),
      /** The ring floats this far above the land so it never fights it in the depth test. */
      ringLiftRatio: z.number().nonnegative().max(0.1),
      capSegments: z.int().min(1).max(16),
      radialSegments: z.int().min(3).max(32),
      ringSegments: z.int().min(3).max(64),
    })
    .refine((a) => a.minHeightM <= a.maxHeightM, {
      error: 'minHeightM must not exceed maxHeightM',
    })
    .refine((a) => a.ringInnerRatio < a.ringOuterRatio, {
      error: 'ringInnerRatio must be less than ringOuterRatio',
    }),
  labels: z.strictObject({
    /** Line letters are hidden when the camera is farther than this. */
    maxDistanceM: metres,
    chipSizeM: metres,
    chipGapM: z.number().nonnegative(),
    /** Chips sit this far north of their terminal station. */
    offsetM: z.number().nonnegative(),
    liftM: metres,
    atlasCellPx: z.int().min(16).max(256),
    alphaTest: z.number().gt(0).lt(1),
    /** Chip artwork, as fractions of an atlas cell (chip, corner radius, letter size, text width). */
    chipFill: z.number().gt(0).max(1),
    cornerRadius: z.number().nonnegative().max(0.5),
    fontScale: z.number().gt(0).max(1),
    textMaxWidth: z.number().gt(0).max(1),
  }),
  lights: z.strictObject({
    /**
     * The high tier's directional shadow (S04b, perf.json `shadows`). The light follows the
     * camera target so its shadow map covers the view; sizes are multiples of the camera
     * distance so the shadow stays sharp at every zoom.
     */
    shadow: z.strictObject({
      /** Half the width of the square the shadow map covers. */
      extentPerDistance: ratio,
      /** How far towards the sun the light sits from the target. */
      lightPerDistance: ratio,
      /** Depth of the shadow camera, from the light. */
      depthPerDistance: ratio,
      bias: z.number().max(0),
      normalBias: z.number().nonnegative(),
    }),
  }),
  /**
   * The day/night cycle on the personal game clock (S04f): keyframes the city's sun, ambient and
   * hemisphere light, fog and night glow blend between. Colours are theme.json `sky.<id>`.
   * `src/lib/dayNight/resolveDayNight.ts` checks clock order and holds when the model is built.
   */
  dayNight: DayNightConfigSchema,
  /**
   * How the 3D map starts (S04b, PERF-4): the canvas mounts when the main thread is idle (or
   * after `idleTimeoutMs` at the latest), and the city build yields to the browser between
   * layers so taps and other islands are not blocked for its whole length.
   */
  startup: z.strictObject({
    idleTimeoutMs: z.int().positive(),
  }),
  /** "Expanding soon" land and parks (S04c): their colour mixed this far towards theme `scene.haze`. */
  dimmed: z.strictObject({ towardBackground: z.number().gt(0).lt(1) }),
  /** Place pins (S04c): instanced markers whose height follows the camera distance, clamped. */
  pins: z
    .strictObject({
      liftM: z.number().nonnegative(),
      heightPerDistance: ratio,
      minHeightM: metres,
      maxHeightM: metres,
      /** Pins are rescaled when the distance changes by more than this factor. */
      rescaleRatio: z.number().gt(1),
      radialSegments: z.int().min(3),
      /**
       * Screen radius of a pin's tap target. At least 22 px, so the target is at least 44 px
       * across (CLAUDE.md "Art direction": hit targets ≥ 44 px).
       */
      hitRadiusPx: z.number().min(22),
      /** Pins this close to the nearest hit (in pixels) make the tap ambiguous: a chooser opens. */
      ambiguityPx: z.number().nonnegative(),
      /** A pointer that moves farther than this, or stays down longer, is a drag, not a tap. */
      tapSlopPx: z.number().positive(),
      tapMaxMs: z.int().positive(),
      /** Selection ring radius as a fraction of the pin height. */
      ringRadius: ratio,
      ringSegments: z.int().min(8),
      /**
       * Night glow lift (S04f): at full night a pin glows this share of its own colour, so it
       * stays readable and tappable in the dark. Muted pins never glow.
       */
      nightGlow: z.number().min(0).max(1),
    })
    .refine((p) => p.minHeightM <= p.maxHeightM, {
      error: 'minHeightM must not exceed maxHeightM',
    }),
  /** The camera move to a place picked outside the map (the Places panel, a hook). */
  focus: z.strictObject({
    tweenMs: z.int().nonnegative(),
    /** The camera ends at most this far from the place. */
    maxDistanceM: metres,
  }),
  /**
   * Travel (S08): the vehicle the avatar rides in, sized as a multiple of the avatar's height (so
   * it scales with the camera like the avatar), and the trail drawn behind it (at most
   * `trailMaxPoints` points, one line; off on the low tier unless `trailOnLow`).
   */
  travel: z.strictObject({
    taxiLengthRatio: z.number().gt(0),
    trainLengthRatio: z.number().gt(0),
    vehicleWidthRatio: z.number().gt(0),
    vehicleHeightRatio: z.number().gt(0),
    /** A trail point is added each time the traveller moves this much (avatar heights). */
    trailStepRatio: z.number().gt(0),
    /** The trail's height above the land top (avatar heights). */
    trailLiftRatio: z.number().nonnegative(),
    trailMaxPoints: z.int().min(2).max(64),
    trailWidthPx: z.number().gt(0),
    trailOnLow: z.boolean(),
  }),
  /** "Expanding soon" ground chips on dimmed boroughs, drawn from a runtime atlas. */
  chips: z.strictObject({
    widthM: metres,
    heightM: metres,
    liftM: metres,
    atlasWidthPx: z.int().min(64).max(2048),
    atlasHeightPx: z.int().min(16).max(1024),
    fontScale: z.number().gt(0).max(1),
    textMaxWidth: z.number().gt(0).max(1),
    cornerRadius: z.number().nonnegative().max(0.5),
    alphaTest: z.number().gt(0).lt(1),
  }),
  /**
   * The hand-made models (S04h, DEC-24). `lit` (MeshStandardMaterial on mid/high, Lambert on low)
   * is the default until the user picks from the showcase; `toon` uses the shared toon ramp.
   * Colours come from each model's vertex colours (theme.json `models` tokens).
   */
  models: z.strictObject({
    shading: z.enum(['lit', 'toon']),
    /** Material per quality tier when shading is `lit`. */
    litMaterial: z.strictObject({
      low: z.enum(['lambert', 'standard']),
      mid: z.enum(['lambert', 'standard']),
      high: z.enum(['lambert', 'standard']),
    }),
    roughness: z.number().min(0).max(1),
    metalness: z.number().min(0).max(1),
    /** `_EMISSIVE` vertices (lit windows, lamps) glow at this intensity by day and by night. */
    emissive: z.strictObject({
      dayIntensity: z.number().nonnegative(),
      nightIntensity: z.number().nonnegative(),
    }),
    /** Decoded models kept in memory after their last user unmounts (LRU). */
    cacheMaxEntries: z.int().min(1),
    /**
     * The player's hand-made avatar on the map (S05 swap): the shared rig with this head and
     * body, posed on `clip`. The capsule placeholder stays while it loads, if it fails, on
     * devices reporting less than `minDeviceMemoryGB` (navigator.deviceMemory), and on the
     * tiers in `capsuleTiers` (the low tier's triangle headroom, TUNE-7).
     */
    player: z.strictObject({
      head: z.string().regex(/^head-[a-z0-9-]+$/),
      body: z.string().regex(/^body-[a-z0-9-]+$/),
      clip: z.string().min(1),
      minDeviceMemoryGB: z.number().positive(),
      capsuleTiers: z.array(z.enum(['low', 'mid', 'high'])),
    }),
    /**
     * Apartment decor drawn with a hand-made model (S16 + S04h): decor item id → model id and the
     * model slot the player's colour variant recolours. Items left out keep their code-built
     * stand-in (string lights and the neon sign wait for their Blender models).
     */
    decor: z.record(
      z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
      z.strictObject({
        model: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
        slot: z.string().min(1),
      }),
    ),
  }),
  /** The static SVG map (GET /geo/fallback) shown when the 3D map is unavailable. */
  fallback: z.strictObject({
    /** SVG user units are whole multiples of this many metres. */
    metresPerUnit: metres,
    /** Douglas-Peucker tolerance for outlines. */
    toleranceM: metres,
    /** Land and park polygons smaller than these are left out. */
    minLandAreaM2: z.number().nonnegative(),
    minParkAreaM2: z.number().nonnegative(),
    dotRadiusM: metres,
    labelSizeM: metres,
    labelOpacity: z.number().gt(0).max(1),
    dimmedLabelOpacity: z.number().gt(0).max(1),
  }),
  /**
   * The apartment interior (S16, src/scene/apartment/): the floor slab and wall insets, the ledge or
   * side table drawn under each surface slot, the slot markers, tap picking, the camera fit, the
   * static lighting (until S04f drives it from the clock) and the mid tier's blob shadows.
   */
  apartment: z.strictObject({
    floorThicknessM: metres,
    /**
     * Walls are single-sided planes facing into the room, so a wall between the camera and the
     * room is culled (the cutaway); trim, the window pane and the door sit this far in front of
     * their wall so they never fight it in the depth test.
     */
    insetM: metres,
    trimHeightM: metres,
    /** A surface slot this close to a side wall sits on a ledge; elsewhere on a side table. */
    ledgeDepthM: metres,
    ledgeThicknessM: metres,
    tableSizeM: metres,
    marker: z.strictObject({
      radiusM: metres,
      segments: z.int().min(3).max(64),
      liftM: z.number().nonnegative(),
      /** The selected or highlighted slot's marker grows by this factor. */
      selectedScale: z.number().min(1),
    }),
    /** At least 22 px, so a slot's tap target is at least 44 px across (CLAUDE.md "Art direction"). */
    hitRadiusPx: z.number().min(22),
    /** Slots this close to the nearest hit (in pixels) make the tap ambiguous: a chooser opens. */
    ambiguityPx: z.number().nonnegative(),
    /** The room's bounding sphere is fitted into the free scene row with this much margin. */
    fitMargin: z.number().min(1),
    /**
     * The room's light comes from the city's day/night keyframe (scene `dayNight.room` scales
     * it); only the direction through the window and the shadow map size are the room's own.
     */
    lights: z.strictObject({
      sunDirection: z
        .strictObject({ x: z.number(), y: z.number(), z: z.number() })
        .refine((d) => d.y > 0, { error: 'the light must come from above' }),
      /** The high tier's one directional shadow map (PCFShadowMap). */
      shadowMapSizePx: z.int().min(256).max(4096),
    }),
    /** The mid tier's blob shadows under placed floor and surface decor. */
    blob: z.strictObject({
      radiusM: metres,
      opacity: z.number().gt(0).max(1),
      liftM: z.number().nonnegative(),
    }),
  }),
  /** The landmark kit's levels of detail and look per quality tier (S07a). */
  landmarks: LandmarkSceneConfigSchema,
  /**
   * District buildings and procedural blocks (S04d). Windows are a mask texture repeated over
   * the district walls (one cell per `floorM` storey and `windowSpacingM` of wall), glowing with
   * the shared night-glow uniform (src/scene/lighting/nightGlow.ts, driven by S04f's day/night
   * rig); view distances are multiplied by the tier's lodDistanceScale.
   */
  buildings: z.strictObject({
    floorM: metres,
    windowSpacingM: metres,
    /** The window's share of its cell, across and up. */
    windowWidth: z.number().gt(0).lt(1),
    windowHeight: z.number().gt(0).lt(1),
    /** Share of windows lit at night. */
    litShare: z.number().min(0).max(1),
    /**
     * The window mask texture repeats every this many cells each way, so lit and dark windows
     * vary within the tile.
     */
    windowTileCells: z.int().min(1).max(16),
    /** The window pattern costs fragment work: off where the tier has no headroom. */
    windows: z.strictObject({ low: z.boolean(), mid: z.boolean(), high: z.boolean() }),
    /** Per-building spread of the facade's brightness (0.12 = plus or minus 12%). */
    wallJitter: z.number().min(0).max(0.5),
    /** Beyond these distances from the camera, districts and blocks are not drawn. */
    viewM: z.strictObject({ districts: metres, blocks: metres }),
    /** A district loads once the camera is this close to its draw distance. */
    loadMarginM: z.number().nonnegative(),
    /** The longest a build slice runs before it gives the browser a turn. */
    buildSliceMs: z.number().positive(),
  }),
  /**
   * Name chips of the modelled landmarks (S07a): one flat rounded plate per landmark, floating
   * above its model's top and `offsetM` south of its pin, all in one mesh and one atlas, shown
   * within `landmarks.labelMaxDistanceM` of the camera target. Text comes from the server's copy
   * (generic labels for generic-name landmarks), never from the model data.
   */
  landmarkChips: z.strictObject({
    widthM: metres,
    heightM: metres,
    offsetM: z.number().nonnegative(),
    liftM: z.number().nonnegative(),
    atlasWidthPx: z.int().min(64).max(2048),
    cellHeightPx: z.int().min(16).max(256),
    fontScale: ratio.max(1),
    textMaxWidth: ratio.max(1),
    cornerRadius: z.number().min(0).max(0.5),
    alphaTest: z.number().gt(0).lt(1),
  }),
})
export type SceneConfig = z.infer<typeof SceneConfigSchema>

/**
 * What the city's 3D chunk reads: the scene config without the blocks other code reads itself
 * (the apartment chunk imports its own; the fallback map is drawn on the server), so they never
 * travel with the page.
 */
export type CitySceneConfig = Omit<SceneConfig, 'apartment' | 'fallback'>

export function citySceneConfig(scene: SceneConfig): CitySceneConfig {
  const city: Partial<SceneConfig> = { ...scene }
  delete city.apartment
  delete city.fallback
  return city as CitySceneConfig
}
