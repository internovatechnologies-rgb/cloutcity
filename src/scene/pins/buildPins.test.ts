import { describe, expect, it } from 'vitest'
import { Color, DataTexture, InstancedMesh, Mesh, PerspectiveCamera, RedFormat } from 'three'
import { scene as sceneConfig } from '@/lib/data/config'
import { land, parks } from '@/lib/data/geo'
import { decodeRing } from '@/lib/geo/codec'
import { pointInPolygon } from '@/lib/geo/polygon'
import { scenePalette } from '@/lib/theme'
import { placesLayer } from '@/lib/world/placesLayer'
import { landTopY } from '../geo/buildLand'
import { polygonsOfKind } from '../geo/buildParks'
import { createCityMaterials, dimmedColor } from '../materials'
import { buildChipGeometry, chipAnchor } from './buildChips'
import {
  buildLandmarkPinGeometry,
  buildPins,
  buildVenuePinGeometry,
  pinColor,
  pinHeight,
  PIN_HEAD,
  PIN_LOOKS,
  buildBadgePinGeometry,
  pinGlow,
  pinLook,
} from './buildPins'
import {
  NIGHT_GLOW_ATTRIBUTE,
  createDayNightUniforms,
  nightGlowSource,
} from '../lighting/nightGlow'

const palette = scenePalette()
const top = landTopY(sceneConfig.land)
const ramp = new DataTexture(new Uint8Array([128, 255]), 2, 1, RedFormat)
const build = () => buildPins(placesLayer.pins, palette, sceneConfig, top, ramp)

function mesh(group: { getObjectByName(name: string): unknown }, name: string): InstancedMesh {
  const found = group.getObjectByName(name)
  if (!(found instanceof InstancedMesh)) throw new Error(`no ${name}`)
  return found
}

describe('pin geometry', () => {
  it('stands on the ground with its head where taps aim, and stays low-poly', () => {
    for (const [kind, geometry] of [
      ['venue', buildVenuePinGeometry(sceneConfig.pins.radialSegments)],
      ['landmark', buildLandmarkPinGeometry()],
      ['badge', buildBadgePinGeometry()],
    ] as const) {
      geometry.computeBoundingBox()
      const box = geometry.boundingBox
      expect(box?.min.y ?? -1).toBeCloseTo(0, 6)
      expect(box?.max.y ?? 0).toBeLessThanOrEqual(1.01)
      expect(box?.max.y ?? 0).toBeGreaterThan(PIN_HEAD[kind])
      expect(geometry.getAttribute('position').count / 3).toBeLessThanOrEqual(40)
      expect(geometry.getAttribute('normal')).toBeDefined()
    }
  })
})

describe('buildPins', () => {
  it('draws every place in three instanced meshes: venues, landmarks and model badges', () => {
    const pins = build()
    const venues = mesh(pins.group, 'pins-venue')
    const landmarks = mesh(pins.group, 'pins-landmark')
    const badges = mesh(pins.group, 'pins-badge')
    const looks = placesLayer.pins.map(pinLook)
    expect(venues.count).toBe(looks.filter((look) => look === 'venue').length)
    expect(landmarks.count).toBe(looks.filter((look) => look === 'landmark').length)
    // Every modelled landmark's pin is a badge (S07a).
    expect(badges.count).toBe(placesLayer.pins.filter((pin) => pin.badge === true).length)
    expect(badges.count).toBeGreaterThan(0)
    expect(venues.count + landmarks.count + badges.count).toBe(placesLayer.pins.length)
    expect(pins.pins.map((pin) => pin.id).sort()).toEqual(placesLayer.pins.map((p) => p.id).sort())
    pins.dispose()
  })

  it('colours each pin by kind, and teasers and memorials by style', () => {
    const pins = build()
    const color = new Color()
    for (const look of PIN_LOOKS) {
      const instanced = mesh(pins.group, `pins-${look}`)
      pins.pins
        .filter((pin) => pinLook(pin) === look)
        .forEach((pin, i) => {
          instanced.getColorAt(i, color)
          expect(color.getHexString(), pin.id).toBe(
            new Color(pinColor(pin, palette)).getHexString(),
          )
        })
    }
    const styleOf = (id: string) => pins.pins.find((pin) => pin.id === id)?.style
    expect(styleOf('bronx-ballpark')).toBe('teaser')
    expect(styleOf('staten-island-ferry')).toBe('teaser')
    expect(styleOf('september-11-memorial')).toBe('memorial')
    expect(pinColor({ kind: 'landmark', style: 'memorial' }, palette)).toBe(palette.pins.muted)
    expect(pinColor({ kind: 'venue', style: 'normal' }, palette)).toBe(palette.pins.venue)
    pins.dispose()
  })

  it('rescales with the camera distance, clamped, only past the rescale ratio', () => {
    const pins = build()
    const venues = mesh(pins.group, 'pins-venue')
    const heightNow = () => {
      const m = venues.instanceMatrix.array
      return m[5] ?? 0
    }
    pins.applyDistance(4500)
    expect(heightNow()).toBeCloseTo(pinHeight(4500, sceneConfig.pins), 4)
    pins.applyDistance(4600)
    expect(heightNow()).toBeCloseTo(pinHeight(4500, sceneConfig.pins), 4)
    pins.applyDistance(40_000)
    expect(heightNow()).toBeCloseTo(sceneConfig.pins.maxHeightM, 4)
    pins.applyDistance(10)
    expect(heightNow()).toBeCloseTo(sceneConfig.pins.minHeightM, 4)
    pins.dispose()
  })

  it('shows the selection ring under the selected pin only', () => {
    const pins = build()
    pins.applyDistance(4500)
    const ring = pins.group.getObjectByName('pin-selection')
    if (!(ring instanceof Mesh)) throw new Error('no ring')
    expect(ring.visible).toBe(false)
    const target = placesLayer.pins.find((pin) => pin.id === 'glowmatic')
    if (target === undefined) throw new Error('no glowmatic')
    pins.setSelected('glowmatic')
    expect(pins.selectedId()).toBe('glowmatic')
    expect(ring.visible).toBe(true)
    expect(ring.position.x).toBe(target.x)
    expect(ring.position.z).toBe(-target.y)
    pins.setSelected('no-such-place')
    expect(pins.selectedId()).toBeNull()
    expect(ring.visible).toBe(false)
    pins.dispose()
  })

  it('projects pin heads to the screen, and skips pins behind the camera', () => {
    const pins = build()
    pins.applyDistance(1000)
    const target = placesLayer.pins.find((pin) => pin.id === 'glowmatic')
    if (target === undefined) throw new Error('no glowmatic')
    const camera = new PerspectiveCamera(45, 390 / 844, 1, 100_000)
    const headY = top + sceneConfig.pins.liftM + PIN_HEAD.venue * pinHeight(1000, sceneConfig.pins)
    camera.position.set(target.x, headY + 1000, -target.y + 1)
    camera.lookAt(target.x, headY, -target.y)
    camera.updateProjectionMatrix()
    const screen = pins.screenPins(camera, 390, 844)
    const glow = screen.find((pin) => pin.id === 'glowmatic')
    expect(glow?.x).toBeCloseTo(195, 0)
    expect(glow?.y).toBeCloseTo(422, 0)
    // Looking away (up): every pin is behind the camera.
    camera.lookAt(target.x, headY + 2000, -target.y + 1)
    expect(pins.screenPins(camera, 390, 844)).toEqual([])
    pins.dispose()
  })

  it('honours a per-pin liftM (S07a) and returns ground points by id', () => {
    const [first, ...rest] = placesLayer.pins
    if (first === undefined) throw new Error('no pins')
    const pins = buildPins([{ ...first, liftM: 50 }, ...rest], palette, sceneConfig, top, ramp)
    pins.applyDistance(4500)
    const instanced = mesh(pins.group, `pins-${first.kind}`)
    expect(instanced.instanceMatrix.array[13]).toBeCloseTo(top + sceneConfig.pins.liftM + 50, 6)
    expect(pins.groundOf(first.id)?.toArray()).toEqual([first.x, top, -first.y])
    expect(pins.groundOf('nope')).toBeNull()
    pins.dispose()
  })
})

describe('dimmed boroughs', () => {
  it('places one "expanding soon" chip inside each dimmed borough', () => {
    const dimmed = placesLayer.boroughs.filter((b) => b.render === 'dimmed').map((b) => b.id)
    expect([...dimmed].sort()).toEqual(['bronx', 'staten-island'])
    for (const id of dimmed) {
      const borough = land.boroughs.find((b) => b.id === id)
      if (borough === undefined) throw new Error(`no ${id}`)
      const anchor = chipAnchor(borough.polygons)
      if (anchor === null) throw new Error(`no anchor for ${id}`)
      expect(
        borough.polygons.some((polygon) => pointInPolygon(anchor, polygon.map(decodeRing))),
      ).toBe(true)
    }
    const geometry = buildChipGeometry(
      [
        { x: 0, y: 0 },
        { x: 10, y: 10 },
      ],
      sceneConfig.chips,
      5,
    )
    expect(geometry.getIndex()?.count).toBe(12)
    expect(chipAnchor([])).toBeNull()
  })

  it('dims land and parks of dimmed boroughs only, towards the haze', () => {
    const ramp2 = new DataTexture(new Uint8Array([255]), 1, 1, RedFormat)
    const fakeAtlas = ramp2
    const materials = createCityMaterials(palette, sceneConfig, fakeAtlas, new Set(['bronx']))
    const t = sceneConfig.dimmed.towardBackground
    expect(materials.land.bronx.color.getHex()).toBe(
      dimmedColor(palette.land.bronx, palette.haze, t).getHex(),
    )
    expect(materials.land.queens.color.getHex()).toBe(new Color(palette.land.queens).getHex())
    expect(materials.parkDimmed.color.getHex()).not.toBe(materials.park.color.getHex())
    const bronxParks = polygonsOfKind(parks.parks, 'park', {
      ids: new Set(['bronx']),
      exclude: false,
    })
    const otherParks = polygonsOfKind(parks.parks, 'park', {
      ids: new Set(['bronx']),
      exclude: true,
    })
    expect(bronxParks.length + otherParks.length).toBe(polygonsOfKind(parks.parks, 'park').length)
    expect(bronxParks.length).toBeGreaterThan(0)
    materials.dispose()
  })
})

describe('pin night glow (S04f)', () => {
  const glowing = () => {
    const uniforms = createDayNightUniforms()
    return buildPins(placesLayer.pins, palette, sceneConfig, top, ramp, uniforms.uNightGlow)
  }

  it('lifts every normal pin by a share of its own colour, never a memorial or teaser pin', () => {
    const lift = sceneConfig.pins.nightGlow
    const out = new Color()
    for (const pin of placesLayer.pins) {
      const glow = pinGlow(pin, palette, lift, out)
      if (pin.style === 'normal') {
        expect(glow.getHex()).toBe(new Color(pinColor(pin, palette)).multiplyScalar(lift).getHex())
      } else {
        expect(glow.getHex()).toBe(0)
      }
    }
    expect(placesLayer.pins.some((pin) => pin.style === 'memorial')).toBe(true)
  })

  it('writes the glow per instance on the shared, patched pin material', () => {
    const pins = glowing()
    const out = new Color()
    for (const look of PIN_LOOKS) {
      const instanced = mesh(pins.group, `pins-${look}`)
      expect(nightGlowSource(instanced.material as never)).toBe('attribute')
      const attribute = instanced.geometry.getAttribute(NIGHT_GLOW_ATTRIBUTE)
      const list = placesLayer.pins.filter((pin) => pinLook(pin) === look)
      list.forEach((pin, i) => {
        const expected = pinGlow(pin, palette, sceneConfig.pins.nightGlow, out)
        expect([attribute.getX(i), attribute.getY(i), attribute.getZ(i)]).toEqual(
          expected.toArray().map((value) => Math.fround(value)),
        )
      })
    }
    pins.dispose()
  })

  it('stays unpatched without the shared uniform', () => {
    const pins = build()
    const instanced = mesh(pins.group, 'pins-venue')
    expect(nightGlowSource(instanced.material as never)).toBeUndefined()
    expect(instanced.geometry.getAttribute(NIGHT_GLOW_ATTRIBUTE)).toBeUndefined()
    pins.dispose()
  })
})
