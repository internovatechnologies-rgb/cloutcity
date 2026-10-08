import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MeshBasicMaterial, PerspectiveCamera } from 'three'
import { describe, expect, it, vi } from 'vitest'
import { scene } from '@/lib/data/config'
import { districtAssets } from '@/lib/data/districts'
import { createBuildingsLayer } from './layer'

const DATA = join(import.meta.dirname, '../../../data')
const assets = districtAssets('low')
const GROUND = scene.land.heightM - scene.land.baseM

/** Serves the committed files for the asset URLs; anything else fails like a 404. */
function fakeFetch() {
  const fetched: string[] = []
  const fetchJson = vi.fn(async (url: string) => {
    fetched.push(url)
    const district = assets.districts.find((d) => d.url === url)
    const path = district
      ? `geo/districts/${district.id}.low.derived.json`
      : url === assets.blocksUrl
        ? 'geo/blocks.low.derived.json'
        : null
    if (path === null) throw new Error('HTTP 404')
    return JSON.parse(readFileSync(join(DATA, path), 'utf8')) as unknown
  })
  return { fetchJson, fetched }
}

/** A camera 3000 m above a district's centre, looking straight down. */
function cameraOver(id: string): PerspectiveCamera {
  const district = assets.districts.find((d) => d.id === id)
  if (district === undefined) throw new Error(id)
  const camera = new PerspectiveCamera(45, 390 / 844, 1, 100_000)
  camera.position.set(district.centre.x, GROUND + 3000, -district.centre.y + 1)
  camera.lookAt(district.centre.x, GROUND, -district.centre.y)
  camera.updateMatrixWorld()
  return camera
}

function layerWith(fetchJson: (url: string) => Promise<unknown>, onError = vi.fn()) {
  const material = new MeshBasicMaterial()
  return createBuildingsLayer({
    assets,
    groundY: GROUND,
    config: scene.buildings,
    districtColors: {
      walls: ['#7b5a4a', '#9a9286'],
      roof: '#5b5d61',
      jitter: 0.1,
      windowTile: { u: 16, v: 13.2 },
    },
    blockColors: { blocks: ['#9a9286'], dimmed: '#5a5852', jitter: 0.1 },
    dimmedBoroughs: new Set(['bronx', 'staten-island']),
    materials: { district: material, blocks: material, blocksDimmed: material },
    prepare: async () => undefined,
    onChange: vi.fn(),
    onError,
    fetchJson,
    yieldFn: async () => undefined,
  })
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

describe('buildings layer', () => {
  it('loads nothing before the city is on screen', async () => {
    const { fetchJson, fetched } = fakeFetch()
    const layer = layerWith(fetchJson)
    layer.setView(cameraOver('jamaica'))
    await settle()
    expect(fetched).toEqual([])
    expect(layer.view().started).toBe(false)
    layer.dispose()
  })

  it('loads the blocks and only districts near the view, then culls by draw distance', async () => {
    const { fetchJson, fetched } = fakeFetch()
    const layer = layerWith(fetchJson)
    layer.setDensity(0.5)
    layer.setDistanceScale(0.6)
    layer.setView(cameraOver('jamaica'))
    layer.start()
    for (let i = 0; i < 20 && layer.view().busy; i++) await settle()
    const view = layer.view()
    expect(fetched).toContain(assets.blocksUrl)
    const loaded = view.districts.filter((d) => d.status === 'ready').map((d) => d.id)
    // Jamaica is far from every other district: only it is in reach.
    expect(loaded).toEqual(['jamaica'])
    const jamaica = view.districts.find((d) => d.id === 'jamaica')
    expect(jamaica?.visible).toBe(true)
    expect(jamaica?.drawnMasses).toBe(Math.ceil((jamaica?.masses ?? 0) * 0.5))
    expect(view.blocks.status).toBe('ready')
    expect(view.blocks.drawn).toBeGreaterThan(0)
    expect(view.blocks.drawn).toBeLessThan(view.blocks.total)
    expect(view.drawDistances.districts).toBeCloseTo(scene.buildings.viewM.districts * 0.6, 6)

    // Far away: the district stays loaded but is not drawn.
    const far = new PerspectiveCamera(45, 1, 1, 100_000)
    far.position.set(-30_000, 5000, 30_000)
    far.lookAt(-30_000, 0, 29_000)
    far.updateMatrixWorld()
    layer.setView(far)
    expect(layer.view().districts.find((d) => d.id === 'jamaica')?.visible).toBe(false)
    layer.dispose()
  })

  it('reports a file that fails and carries on with the rest', async () => {
    const { fetchJson } = fakeFetch()
    const onError = vi.fn()
    const failing = async (url: string) => (url === assets.blocksUrl ? { nope: 1 } : fetchJson(url))
    const layer = layerWith(failing, onError)
    layer.setView(cameraOver('jamaica'))
    layer.start()
    for (let i = 0; i < 20 && layer.view().busy; i++) await settle()
    expect(layer.view().blocks.status).toBe('failed')
    expect(onError).toHaveBeenCalledWith(assets.blocksUrl, 'invalid blocks file')
    expect(layer.view().districts.find((d) => d.id === 'jamaica')?.status).toBe('ready')
    layer.dispose()
  })
})
