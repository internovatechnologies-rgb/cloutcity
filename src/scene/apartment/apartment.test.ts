import { describe, expect, it } from 'vitest'
import { PerspectiveCamera, type InstancedMesh, type Mesh } from 'three'
import itemsJson from '@data/items/items.json'
import { HOME_IDS } from '@/lib/data/homes'
import { buildApartment } from './buildApartment'
import { buildDecorModel, DECOR_MODEL_IDS } from './buildDecor'
import { buildRoomGeometry, roomBounds } from './buildRoom'
import {
  apartmentConfig,
  avatarReserve,
  dayNightConfig,
  dayNightModel,
  roomInterior,
  roomPalette,
  tierBudget,
  tokenHex,
  toonRamp,
} from './data'
import { boundingSphere, cameraPosition, fitDistance } from './fit'
import { lightingAt as cityLightingAt, mixHexLinear } from '@/lib/dayNight/lightingAt'
import { lightingAt } from './lighting'
import { triangleCount } from './parts'
import { createPlaceholderVisuals } from './visuals'

const decorItems = itemsJson.items.filter((item) => item.category === 'decor')

describe('apartment data', () => {
  it('reads every home interior with its slots', () => {
    for (const home of HOME_IDS) {
      const interior = roomInterior(home)
      expect(interior.slots.length).toBeGreaterThan(0)
      for (const slot of interior.slots) expect(slot.position).toHaveLength(3)
    }
    expect(roomInterior('brooklyn-1br').slots).toHaveLength(5)
  })

  it('resolves the room palette to hex and keeps the avatar reserve inside every tier', () => {
    for (const hex of Object.values(roomPalette)) expect(hex).toMatch(/^#[0-9a-f]{6}$/i)
    expect(() => tokenHex('no-such-token')).toThrow(/unknown palette token/)
    for (const tier of ['low', 'mid', 'high'] as const) {
      const budget = tierBudget(tier)
      expect(avatarReserve.drawCalls).toBeLessThan(budget.drawCallsMax)
      expect(avatarReserve.triangles).toBeLessThan(budget.trianglesMax)
    }
    expect(tierBudget('high').shadows).toBe('pcf-directional')
    expect(tierBudget('mid').shadows).toBe('blob-or-baked')
    expect(tierBudget('low').shadows).toBe('none')
  })

  it('keeps tap targets at least 44 px across', () => {
    expect(apartmentConfig.hitRadiusPx * 2).toBeGreaterThanOrEqual(44)
  })
})

describe('decor models', () => {
  it('has a model for every decor item and nothing else', () => {
    expect([...DECOR_MODEL_IDS].sort()).toEqual(decorItems.map((item) => item.id).sort())
    expect(buildDecorModel('cargo-pants')).toBeNull()
  })

  it('builds each as one merged geometry with at most two material groups, low-poly', () => {
    for (const id of DECOR_MODEL_IDS) {
      const model = buildDecorModel(id)
      if (model === null) throw new Error(`no model for ${id}`)
      const groups = model.geometry.groups.length
      expect(groups, id).toBeLessThanOrEqual(2)
      expect(model.second === null ? groups <= 1 : groups === 2, id).toBe(true)
      expect(triangleCount(model.geometry), id).toBeGreaterThan(0)
      expect(triangleCount(model.geometry), id).toBeLessThan(1500)
      expect(model.footprintM).toBeGreaterThan(0)
      model.geometry.dispose()
    }
  })
})

describe('room shell', () => {
  it('is one vertex-coloured geometry for every home', () => {
    for (const home of HOME_IDS) {
      const geometry = buildRoomGeometry(roomInterior(home), apartmentConfig, roomPalette)
      expect(geometry.getAttribute('color')).toBeDefined()
      expect(geometry.groups).toHaveLength(0)
      expect(triangleCount(geometry)).toBeLessThan(1000)
      geometry.dispose()
    }
  })
})

describe('camera fit', () => {
  const sphere = boundingSphere([-1, 0, -1], [1, 2, 1])

  it('puts the sphere around the box', () => {
    expect(sphere.center).toEqual([0, 1, 0])
    expect(sphere.radius).toBeCloseTo(Math.sqrt(3))
  })

  it('backs off further for a shorter free row and never fits a zero row to nothing', () => {
    const view = { fovDeg: 50, width: 390, height: 844, margin: 1 }
    const tall = fitDistance(sphere, { ...view, rowHeight: 600 })
    const short = fitDistance(sphere, { ...view, rowHeight: 200 })
    expect(short).toBeGreaterThan(tall)
    expect(fitDistance(sphere, { ...view, rowHeight: 0 })).toBeGreaterThan(0)
  })

  it('keeps the data direction', () => {
    const at = cameraPosition([0, 1, 0], [0, 1, 5], [0, 1, 0], 10)
    expect(at).toEqual([0, 1, 10])
    expect(() => cameraPosition([0, 0, 0], [1, 1, 1], [1, 1, 1], 5)).toThrow(/coincide/)
  })
})

describe('lighting seam (S04f)', () => {
  const input = {
    model: dayNightModel,
    room: dayNightConfig.room,
    lights: apartmentConfig.lights,
    palette: roomPalette,
  }
  const city = (minute: number) => cityLightingAt(minute, dayNightModel)

  it('follows the city keyframe by minute of day, scaled for the room', () => {
    const noon = lightingAt(720, input)
    expect(noon.sun.color).toBe(city(720).colors.sun)
    expect(noon.sun.intensity).toBeCloseTo(city(720).sunIntensity * input.room.sunScale)
    expect(noon.ambient.intensity).toBeCloseTo(city(720).ambientIntensity * input.room.ambientScale)
    // The save's clock is absolute: day 3 at noon lights like day 1 at noon.
    expect(lightingAt(720 + 2 * 1440, input)).toEqual(noon)
    // The sun keeps coming through the window.
    expect(noon.sun.direction).toEqual(apartmentConfig.lights.sunDirection)
  })

  it('is lamp-lit at night and darker than by day', () => {
    const noon = lightingAt(720, input)
    const night = lightingAt(23 * 60, input)
    expect(city(23 * 60).nightGlow).toBe(1)
    expect(night.sun.intensity).toBeLessThan(noon.sun.intensity)
    expect(night.ambient.color).not.toBe(city(23 * 60).colors.ambient)
    expect(night.ambient.color).toBe(
      mixHexLinear(city(23 * 60).colors.ambient, roomPalette.lamp, input.room.lampMix),
    )
    expect(noon.ambient.color).toBe(city(720).colors.ambient)
  })

  it('steps between keyframes under reduced motion', () => {
    // 06:30 blends dawn into morning; step mode shows dawn as is.
    expect(lightingAt(390, { ...input, step: true })).toEqual(lightingAt(345, input))
  })
})

describe('apartment scene graph', () => {
  const build = () =>
    buildApartment(
      roomInterior('queens-room'),
      apartmentConfig,
      roomPalette,
      createPlaceholderVisuals(apartmentConfig, roomPalette, toonRamp),
    )
  const decorMeshes = (apartment: ReturnType<typeof build>) =>
    apartment.group.children.filter((child) => child.name.startsWith('apartment-decor-'))

  it('draws one mesh per filled slot and swaps it when the colour changes', () => {
    const apartment = build()
    apartment.setPlaced({ 'wall-1': { itemId: 'fairy-string-lights', color: '#ffffff' } })
    expect(decorMeshes(apartment)).toHaveLength(1)
    const first = decorMeshes(apartment)[0]
    apartment.setPlaced({ 'wall-1': { itemId: 'fairy-string-lights', color: '#ffffff' } })
    expect(decorMeshes(apartment)[0]).toBe(first)
    apartment.setPlaced({ 'wall-1': { itemId: 'fairy-string-lights', color: '#ff0000' } })
    expect(decorMeshes(apartment)[0]).not.toBe(first)
    apartment.setPlaced({})
    expect(decorMeshes(apartment)).toHaveLength(0)
    apartment.dispose()
  })

  it('keeps every slot marker in one instanced mesh and blobs only on the mid tier', () => {
    const apartment = build()
    const markers = apartment.group.getObjectByName('apartment-slot-markers') as InstancedMesh
    const blobs = apartment.group.getObjectByName('apartment-blob-shadows') as InstancedMesh
    expect(markers.count).toBe(apartment.slots.length)
    apartment.setPlaced({ 'floor-1': { itemId: 'cloud-lounge-chair', color: '#ffffff' } })
    apartment.setTier('mid')
    expect(blobs.visible).toBe(true)
    apartment.setTier('low')
    expect(blobs.visible).toBe(false)
    apartment.setTier('high')
    const chair = decorMeshes(apartment)[0] as Mesh
    expect(chair.castShadow).toBe(true)
    // The room is rebuilt for the tier through the visuals seam, and stays one object.
    expect(
      apartment.group.children.filter((child) => child.name === 'apartment-room'),
    ).toHaveLength(1)
    apartment.dispose()
  })

  it('projects every slot to the screen for picking', () => {
    const apartment = build()
    const camera = new PerspectiveCamera(50, 390 / 844, 0.05, 100)
    const interior = roomInterior('queens-room')
    const bounds = roomBounds(interior, apartmentConfig)
    const sphere = boundingSphere(bounds.min, bounds.max)
    camera.position.set(
      ...cameraPosition(sphere.center, interior.camera.position, interior.camera.target, 8),
    )
    camera.lookAt(...sphere.center)
    camera.updateMatrixWorld()
    const slots = apartment.screenSlots(camera, 390, 844)
    expect(slots.map((slot) => slot.id)).toEqual(interior.slots.map((slot) => slot.id))
    for (const slot of slots) {
      expect(slot.x).toBeGreaterThan(0)
      expect(slot.x).toBeLessThan(390)
    }
    apartment.dispose()
  })
})
