import { DataTexture, MeshToonMaterial, NoColorSpace, RepeatWrapping } from 'three'
import { describe, expect, it } from 'vitest'
import { scene } from '@/lib/data/config'
import { nightGlowSource } from '../lighting/nightGlow'
import { createBuildingMaterial, createWindowMask, windowTile } from './materials'

const ramp = new DataTexture(new Uint8Array([90, 170, 255]), 3, 1)

describe('window mask', () => {
  it('is a repeating linear red mask with about litShare of its windows lit', () => {
    const mask = createWindowMask(scene.buildings)
    expect(mask.colorSpace).toBe(NoColorSpace)
    expect(mask.wrapS).toBe(RepeatWrapping)
    expect(mask.wrapT).toBe(RepeatWrapping)
    const data = mask.image.data as Uint8Array
    const size = mask.image.width
    expect(size).toBe(scene.buildings.windowTileCells * 16)
    // Cell corners (where roofs sample) are wall.
    expect(data[0]).toBe(0)
    const lit = [...data].filter((v) => v === 255).length / data.length
    const fullWindow = scene.buildings.windowWidth * scene.buildings.windowHeight
    expect(lit).toBeGreaterThan(0)
    expect(lit).toBeLessThanOrEqual(fullWindow + 0.05)
  })

  it('repeats every windowTileCells cells of the wall', () => {
    const tile = windowTile(scene.buildings)
    expect(tile.u).toBe(scene.buildings.windowSpacingM * scene.buildings.windowTileCells)
    expect(tile.v).toBe(scene.buildings.floorM * scene.buildings.windowTileCells)
  })
})

describe('createBuildingMaterial', () => {
  it('binds district walls to the shared night glow through the mask source', () => {
    const uniform = { value: 0 }
    const mask = createWindowMask(scene.buildings)
    const walls = createBuildingMaterial({
      gradientMap: ramp,
      colors: 'vertex',
      windows: { uniform, mask, color: '#ffd98a' },
    })
    expect(walls).toBeInstanceOf(MeshToonMaterial)
    expect(walls.vertexColors).toBe(true)
    expect(walls.gradientMap).toBe(ramp)
    expect(nightGlowSource(walls)).toBe('mask')
    const blocks = createBuildingMaterial({ gradientMap: ramp, colors: 'instance' })
    expect(blocks.vertexColors).toBe(false)
    expect(nightGlowSource(blocks)).toBeUndefined()
  })
})
