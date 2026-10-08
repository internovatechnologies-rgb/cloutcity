/**
 * The `places` layer of GET /geo/base (S04c): every venue and landmark as a pin, and how the
 * scene draws each borough. Built on the server at build time from the same data the game uses
 * (src/lib/world/places.ts), so the 3D chunk needs no place data, copy or engine config.
 */
import type { Borough } from '@/lib/data/schemas/content'
import type { PinStyle } from '@/scene/geo/schema'
import { landmarkPinLifts } from './landmarksLayer'
import { boroughRenderState, boroughs, mapPlaces, type MapPlace } from './places'

export interface PlacePin {
  readonly id: string
  readonly kind: MapPlace['kind']
  readonly category: MapPlace['category']
  readonly borough: Borough
  /** Local metres, rounded to whole metres like every other geo layer. */
  readonly x: number
  readonly y: number
  /** A playable place, a teaser on "expanding soon" land, or a muted memorial. */
  readonly style: PinStyle
  /** Extra height above the land top (S07a lifts pins over landmark models). Omitted when 0. */
  readonly liftM?: number
  /**
   * The landmark has a 3D model (S07a): its pin is a compact badge floating over the model
   * instead of the placeholder marker. Omitted otherwise.
   */
  readonly badge?: true
}

export interface BoroughRender {
  readonly id: Borough
  /** `dimmed`: "expanding soon" land, drawn but not playable. */
  readonly render: 'normal' | 'dimmed'
  /** Places shown as teaser pins on dimmed land. */
  readonly teaserIds: readonly string[]
}

export interface PlacesLayer {
  readonly pins: readonly PlacePin[]
  /** In data/boroughs/boroughs.json order. */
  readonly boroughs: readonly BoroughRender[]
}

function pinStyle(place: MapPlace, render: BoroughRender): PinStyle {
  if (place.category === 'memorial') return 'memorial'
  return render.render === 'dimmed' ? 'teaser' : 'normal'
}

export function buildPlacesLayer(): PlacesLayer {
  const renders: BoroughRender[] = boroughs.map((entry) => {
    const state = boroughRenderState(entry.id)
    return { id: entry.id, render: state.state, teaserIds: [...state.teaserLandmarkIds] }
  })
  const renderOf = new Map(renders.map((render) => [render.id, render]))
  const lifts = landmarkPinLifts()
  const pins = mapPlaces().map((place): PlacePin => {
    const render = renderOf.get(place.borough)
    if (render === undefined) throw new Error(`places layer: no borough "${place.borough}"`)
    const lift = place.kind === 'landmark' ? lifts.get(place.id) : undefined
    return {
      id: place.id,
      kind: place.kind,
      category: place.category,
      borough: place.borough,
      x: Math.round(place.x),
      y: Math.round(place.y),
      style: pinStyle(place, render),
      ...(lift === undefined ? {} : { badge: true as const }),
      ...(lift === undefined || lift === 0 ? {} : { liftM: lift }),
    }
  })
  return { pins, boroughs: renders }
}

/** The layer GET /geo/base serves (built once per server process). */
export const placesLayer: PlacesLayer = buildPlacesLayer()
