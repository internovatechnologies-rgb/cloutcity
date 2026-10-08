/**
 * The district buildings and blocks of one quality tier, loaded and culled by view (S04d,
 * TUNE-7): a district is fetched and built (time-sliced) once the camera comes within its draw
 * distance plus a margin, drawn only while within that distance, and the blocks draw only the
 * instances in view. Nothing loads until the city is on screen (`start`). three only, no React:
 * Buildings.tsx owns one per tier and feeds it the camera.
 */
import { Group, Mesh, Vector3, type Camera, type Material } from 'three'
import type { DistrictAssets } from '@/lib/data/districts'
import type { SceneConfig } from '@/lib/data/schemas/scene'
import { toLocal } from '../geo/coords'
import type { BoroughId } from '../geo/schema'
import { createSlicer } from '../schedule'
import { buildBlocks, type BlockColors, type BlocksObjects } from './buildBlocks'
import {
  buildDistrictGeometry,
  districtMasses,
  drawnAt,
  massesFor,
  type DistrictColors,
  type DistrictGeometry,
} from './buildDistrict'
import { BlocksMiniSchema, DistrictBuildingsMiniSchema } from './schema'
import { distanceToDistrict, drawDistances, type ViewPoint } from './view'

export type DistrictStatus = 'idle' | 'loading' | 'ready' | 'failed'

export interface DistrictView {
  readonly id: string
  readonly status: DistrictStatus
  /** Drawn for the current view (loaded and within the draw distance). */
  readonly visible: boolean
  readonly masses: number
  readonly drawnMasses: number
  /** Triangles at the current density (whether or not the camera sees them). */
  readonly triangles: number
}

export interface BuildingsLayerView {
  readonly tier: DistrictAssets['tier']
  readonly started: boolean
  /** A fetch or build is under way. */
  readonly busy: boolean
  readonly density: number
  readonly drawDistances: { readonly districts: number; readonly blocks: number }
  readonly districts: readonly DistrictView[]
  readonly blocks: {
    readonly status: DistrictStatus
    readonly total: number
    readonly drawn: number
    readonly triangles: number
  }
}

export interface BuildingsLayerOptions {
  readonly assets: DistrictAssets
  readonly groundY: number
  readonly config: SceneConfig['buildings']
  readonly districtColors: DistrictColors
  readonly blockColors: BlockColors
  readonly dimmedBoroughs: ReadonlySet<BoroughId>
  readonly materials: {
    readonly district: Material
    readonly blocks: Material
    readonly blocksDimmed: Material
  }
  /** Compiles an object's shaders before it is first drawn (renderer.compileAsync). */
  readonly prepare: (object: Group | Mesh) => Promise<void>
  /** Something to draw changed: request a frame. */
  readonly onChange: () => void
  /** A file failed to load or validate (the rest of the city carries on without it). */
  readonly onError: (url: string, reason: string) => void
  readonly fetchJson?: (url: string) => Promise<unknown>
  readonly yieldFn?: () => Promise<void>
}

export interface BuildingsLayer {
  readonly group: Group
  /** The city is on screen: loading may begin. */
  start(): void
  /** Applies the camera: draw distances, district visibility, loads, block culling. */
  setView(camera: Camera): void
  setDensity(density: number): void
  setDistanceScale(scale: number): void
  view(): BuildingsLayerView
  dispose(): void
}

interface DistrictEntry {
  status: DistrictStatus
  mesh: Mesh | null
  built: DistrictGeometry | null
}

const _world = new Vector3()

async function defaultFetchJson(url: string): Promise<unknown> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return (await response.json()) as unknown
}

export function createBuildingsLayer(options: BuildingsLayerOptions): BuildingsLayer {
  const fetchJson = options.fetchJson ?? defaultFetchJson
  const group = new Group()
  group.name = 'buildings'
  const entries = new Map<string, DistrictEntry>(
    options.assets.districts.map((d) => [d.id, { status: 'idle', mesh: null, built: null }]),
  )
  let blocks: BlocksObjects | null = null
  let blocksStatus: DistrictStatus = 'idle'
  let started = false
  let disposed = false
  let density = 1
  let scale = 1
  let camera: Camera | null = null
  let busy = 0
  const queue: string[] = []
  let pumping = false

  const ranges = () => drawDistances(options.config, scale)

  const viewPoint = (): ViewPoint | null => {
    if (camera === null) return null
    camera.getWorldPosition(_world)
    const local = toLocal(_world)
    return { x: local.x, y: local.y, altitude: Math.max(0, _world.y - options.groundY) }
  }

  const applyDensity = (entry: DistrictEntry) => {
    if (entry.built === null || entry.mesh === null) return
    entry.mesh.geometry.setDrawRange(0, drawnAt(entry.built, density).index)
  }

  const applyView = () => {
    const point = viewPoint()
    if (point === null || camera === null) return
    const { districts: districtRange, blocks: blockRange } = ranges()
    for (const asset of options.assets.districts) {
      const entry = entries.get(asset.id)
      if (entry === undefined) continue
      const distance = distanceToDistrict(point, asset)
      if (entry.mesh !== null) entry.mesh.visible = distance <= districtRange
      if (
        started &&
        entry.status === 'idle' &&
        distance <= districtRange + options.config.loadMarginM
      ) {
        entry.status = 'loading'
        queue.push(asset.id)
      }
    }
    queue.sort((a, b) => {
      const da = options.assets.districts.find((d) => d.id === a)
      const db = options.assets.districts.find((d) => d.id === b)
      return (da ? distanceToDistrict(point, da) : 0) - (db ? distanceToDistrict(point, db) : 0)
    })
    blocks?.cull(camera, blockRange)
    void pump()
  }

  const fail = (url: string, error: unknown) =>
    options.onError(url, error instanceof Error ? error.message : String(error))

  async function loadBlocks(): Promise<void> {
    blocksStatus = 'loading'
    busy++
    try {
      const parsed = BlocksMiniSchema.safeParse(await fetchJson(options.assets.blocksUrl))
      if (!parsed.success) throw new Error('invalid blocks file')
      if (disposed) return
      const built = buildBlocks(
        parsed.data,
        options.groundY,
        options.blockColors,
        options.dimmedBoroughs,
        { normal: options.materials.blocks, dimmed: options.materials.blocksDimmed },
      )
      await options.prepare(built.group)
      if (disposed) {
        built.dispose()
        return
      }
      blocks = built
      blocksStatus = 'ready'
      group.add(built.group)
      applyView()
      options.onChange()
    } catch (error) {
      blocksStatus = 'failed'
      fail(options.assets.blocksUrl, error)
    } finally {
      busy--
    }
  }

  async function loadDistrict(id: string): Promise<void> {
    const asset = options.assets.districts.find((d) => d.id === id)
    const entry = entries.get(id)
    if (asset === undefined || entry === undefined) return
    busy++
    try {
      const parsed = DistrictBuildingsMiniSchema.safeParse(await fetchJson(asset.url))
      if (!parsed.success || parsed.data.district !== id) throw new Error('invalid district file')
      if (disposed) return
      const step = createSlicer(options.config.buildSliceMs, options.yieldFn)
      const built = await buildDistrictGeometry(
        districtMasses(parsed.data),
        options.groundY,
        options.districtColors,
        step,
      )
      if (disposed) {
        built.geometry.dispose()
        return
      }
      const mesh = new Mesh(built.geometry, options.materials.district)
      mesh.name = `district-${id}`
      mesh.raycast = () => {}
      mesh.matrixAutoUpdate = false
      entry.built = built
      entry.mesh = mesh
      applyDensity(entry)
      await options.prepare(mesh)
      if (disposed) return
      entry.status = 'ready'
      group.add(mesh)
      applyView()
      options.onChange()
    } catch (error) {
      entry.status = 'failed'
      fail(asset.url, error)
    } finally {
      busy--
    }
  }

  /** Loads queued districts one at a time, nearest first. */
  async function pump(): Promise<void> {
    if (pumping) return
    pumping = true
    try {
      while (!disposed && queue.length > 0) {
        const id = queue.shift()
        if (id !== undefined) await loadDistrict(id)
      }
    } finally {
      pumping = false
    }
  }

  return {
    group,
    start() {
      if (started || disposed) return
      started = true
      void loadBlocks()
      applyView()
    },
    setView(next) {
      camera = next
      applyView()
    },
    setDensity(next) {
      density = next
      for (const entry of entries.values()) applyDensity(entry)
      options.onChange()
    },
    setDistanceScale(next) {
      scale = next
      applyView()
      options.onChange()
    },
    view() {
      const blockView = blocks?.view()
      return {
        tier: options.assets.tier,
        started,
        busy: busy > 0 || queue.length > 0,
        density,
        drawDistances: ranges(),
        districts: options.assets.districts.map((asset) => {
          const entry = entries.get(asset.id)
          const drawn = entry?.built ? drawnAt(entry.built, density) : null
          return {
            id: asset.id,
            status: entry?.status ?? 'idle',
            visible: entry?.mesh?.visible === true && entry.status === 'ready',
            masses: entry?.built?.masses ?? 0,
            drawnMasses: entry?.built ? massesFor(density, entry.built.masses) : 0,
            triangles: drawn?.triangles ?? 0,
          }
        }),
        blocks: {
          status: blocksStatus,
          total: blockView?.total ?? 0,
          drawn: blockView?.drawn ?? 0,
          triangles: blockView?.triangles ?? 0,
        },
      }
    },
    dispose() {
      disposed = true
      queue.length = 0
      for (const entry of entries.values()) {
        entry.mesh?.geometry.dispose()
        entry.mesh?.removeFromParent()
      }
      blocks?.dispose()
      blocks?.group.removeFromParent()
      group.removeFromParent()
    },
  }
}
