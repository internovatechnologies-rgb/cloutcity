/**
 * Turns one catalog model into its per-tier GLBs.
 *
 * Static models: every primitive of every entry is baked to per-triangle vertex colours,
 * harmonised (harmonise.ts), moved into model space and merged into ONE mesh with ONE primitive
 * and one placeholder material (Part 2 swaps in the shared lit/toon material). UVs, tangents and
 * images are dropped. `_EMISSIVE` (VEC3, linear RGB, u8 normalised; zero = no glow) carries each
 * vertex's night-glow colour (S04f night-glow contract) and `_SLOT` (u8) the
 * recolourable regions; each is written only when the model uses it.
 *
 * Skinned models keep one skinned mesh and its joints (avatar heads and bodies share the Kenney
 * rig, so Part 2 rebinds them to one skeleton). Rigs keep the joints and the listed clips only.
 *
 * Lower tiers simplify the source meshes before the bake (simplifySource). Every tier then runs
 * dedup → prune → weld → quantize → reorder → meshopt. The
 * meshopt vertex codec is forced to v0 so three r182's bundled decoder (meshoptimizer 0.22)
 * reads every file; decode.test.ts proves it.
 */
import { posix } from 'node:path'
import {
  Document,
  GLB_BUFFER,
  NodeIO,
  type ILogger,
  type Mesh,
  type Node,
  type GLTF,
  type Primitive,
  type Skin,
  type TypedArray,
} from '@gltf-transform/core'
import {
  ALL_EXTENSIONS,
  EXTMeshoptCompression,
  KHRMeshQuantization,
} from '@gltf-transform/extensions'
import {
  dedup,
  prune,
  quantize,
  reorder,
  resample,
  weld,
  weldPrimitive,
} from '@gltf-transform/functions'
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer'
import { MODEL_TIERS, type ModelTier } from '../../src/lib/data/schemas/assets.ts'
import { TextureCache, triangleColours, triangleIndices } from './bake.ts'
import { externalUris, readGltfContainer, resolveUri, type Pack } from './fetch.ts'
import {
  harmoniseAll,
  hexToLinear,
  linearToHex,
  linearToLab,
  swatchesFor,
  type Grade,
  type Rgb,
  type Anchor,
} from './harmonise.ts'
import type { Model } from './schema.ts'

export interface BuiltTier {
  readonly bytes: Uint8Array
  readonly triangles: number
}

export interface BuiltModel {
  readonly model: Model
  readonly tiers: Readonly<Record<ModelTier, BuiltTier>>
  readonly bounds: { readonly min: Vec3; readonly max: Vec3 } | undefined
  readonly emissive: boolean
  /** Colour report: token (or graded hex when nothing was close) → triangle count. */
  readonly colours: ReadonlyMap<string, number>
  readonly warnings: readonly string[]
}

export interface BuildContext {
  /** Theme `models` tokens → sRGB hex. */
  readonly palette: Readonly<Record<string, string>>
  readonly maxDeltaE: number
  readonly grade: Grade
}

/** Collects glTF Transform's warnings so the build prints them per model instead of console. */
class CollectingLogger implements ILogger {
  readonly warnings: string[] = []
  debug(): void {}
  info(): void {}
  warn(text: string): void {
    this.warnings.push(text)
  }
  error(text: string): void {
    this.warnings.push(`error: ${text}`)
  }
}

/**
 * Meshopt encoder with the vertex codec pinned to v0: meshoptimizer ≥ 0.23 can emit v1 vertex
 * streams, which the 0.22 decoder bundled with three r182 cannot read.
 */
const encoderV0 = {
  ...MeshoptEncoder,
  encodeGltfBuffer: (source: Uint8Array, count: number, size: number, mode: string) =>
    MeshoptEncoder.encodeGltfBuffer(source, count, size, mode, 0),
}

/** Attributes quantize() may touch; COLOR_0, _EMISSIVE and _SLOT are already 8-bit. */
const QUANTIZE_PATTERN = /^(?:POSITION|NORMAL|JOINTS_\d+|WEIGHTS_\d+)$/

const KEPT_EXTENSIONS = new Set(['EXT_meshopt_compression', 'KHR_mesh_quantization'])

type Mat4 = readonly number[]

function transformPoint(m: Mat4, x: number, y: number, z: number): [number, number, number] {
  return [
    (m[0] ?? 0) * x + (m[4] ?? 0) * y + (m[8] ?? 0) * z + (m[12] ?? 0),
    (m[1] ?? 0) * x + (m[5] ?? 0) * y + (m[9] ?? 0) * z + (m[13] ?? 0),
    (m[2] ?? 0) * x + (m[6] ?? 0) * y + (m[10] ?? 0) * z + (m[14] ?? 0),
  ]
}

/** Inverse transpose of the upper 3×3 (column-major), so normals survive non-uniform scale. */
function normalMatrix(m: Mat4): { matrix: number[]; determinant: number } {
  const a = m[0] ?? 0
  const b = m[1] ?? 0
  const c = m[2] ?? 0
  const d = m[4] ?? 0
  const e = m[5] ?? 0
  const f = m[6] ?? 0
  const g = m[8] ?? 0
  const h = m[9] ?? 0
  const i = m[10] ?? 0
  const determinant = a * (e * i - f * h) - d * (b * i - c * h) + g * (b * f - c * e)
  if (determinant === 0) throw new Error('degenerate node transform')
  const k = 1 / determinant
  // Cofactor matrix = (inverse)ᵀ · det.
  return {
    determinant,
    matrix: [
      (e * i - f * h) * k,
      (g * f - d * i) * k,
      (d * h - g * e) * k,
      (h * c - b * i) * k,
      (a * i - g * c) * k,
      (g * b - a * h) * k,
      (b * f - e * c) * k,
      (d * c - a * f) * k,
      (a * e - d * b) * k,
    ],
  }
}

/** Entry placement for composites: rotate about Y, then offset. */
function entryMatrix(rotateYDeg = 0, at: readonly number[] = [0, 0, 0]): number[] {
  const r = (rotateYDeg * Math.PI) / 180
  const cos = Math.cos(r)
  const sin = Math.sin(r)
  return [cos, 0, -sin, 0, 0, 1, 0, 0, sin, 0, cos, 0, at[0] ?? 0, at[1] ?? 0, at[2] ?? 0, 1]
}

function multiply(a: Mat4, b: Mat4): number[] {
  const out = new Array<number>(16).fill(0)
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0
      for (let k = 0; k < 4; k++) sum += (a[k * 4 + row] ?? 0) * (b[col * 4 + k] ?? 0)
      out[col * 4 + row] = sum
    }
  }
  return out
}

function readerIO(logger: ILogger): NodeIO {
  return new NodeIO().registerExtensions(ALL_EXTENSIONS).setLogger(logger)
}

/** Reads one model entry (and the buffers and textures it names) from the pack, in memory. */
export async function loadEntry(pack: Pack, path: string, logger: ILogger): Promise<Document> {
  const full = posix.join(pack.source.download.root, path)
  const bytes = pack.files.get(full)
  if (bytes === undefined) throw new Error(`${pack.source.id}: ${full} is not in the pack`)
  const { json, bin } = readGltfContainer(bytes)
  // Copies: glTF Transform wants ArrayBuffer-backed views, and the reader must not alias the pack.
  const resources: Record<string, Uint8Array<ArrayBuffer>> = {}
  if (bin !== undefined) resources[GLB_BUFFER] = new Uint8Array(bin)
  for (const uri of externalUris(json)) {
    const resolved = resolveUri(full, uri)
    const data = pack.files.get(resolved)
    if (data === undefined)
      throw new Error(`${pack.source.id}: ${resolved} (from ${full}) is missing`)
    resources[uri] = new Uint8Array(data)
  }
  const doc = await readerIO(logger).readJSON({ json: json as unknown as GLTF.IGLTF, resources })
  doc.setLogger(logger)
  return doc
}

interface Classified {
  readonly linear: Rgb
  /** Linear night-glow colour for `_EMISSIVE`, or undefined when the colour does not glow. */
  readonly emissive: Rgb | undefined
  readonly token: string | undefined
  readonly label: string
}

/** `_SLOT` value: 1 + the first slot whose tokens (and joints, for skinned parts) match; else 0. */
function slotOf(model: Model, token: string | undefined, joint?: string): number {
  if (token === undefined) return 0
  const index = model.slots.findIndex(
    (slot) =>
      slot.tokens.includes(token) &&
      (slot.joints === undefined || (joint !== undefined && slot.joints.includes(joint))),
  )
  return index + 1
}

const colourKey = (rgb: Rgb) => `${rgb[0]},${rgb[1]},${rgb[2]}`

/**
 * Harmonises every triangle colour of a model together (harmoniseAll needs the whole model to
 * re-centre each swatch group) and returns a lookup from source colour to its classification.
 */
function colourClassifier(model: Model, ctx: BuildContext, triangles: readonly Rgb[]) {
  const index = new Map<string, number>()
  const colours: Rgb[] = []
  const weights: number[] = []
  for (const rgb of triangles) {
    const key = colourKey(rgb)
    const at = index.get(key)
    if (at === undefined) {
      index.set(key, colours.length)
      colours.push(rgb)
      weights.push(1)
    } else weights[at] = (weights[at] ?? 0) + 1
  }
  const anchors: Anchor[] = Object.entries(model.remap ?? {}).map(([hex, token]) => {
    const [swatch] = swatchesFor([token], ctx.palette)
    if (swatch === undefined) throw new Error(`${model.id}: unknown token ${token}`)
    return {
      lab: linearToLab(hexToLinear(hex)),
      swatch,
      ...(model.remapMaxDeltaE !== undefined && { maxDeltaE: model.remapMaxDeltaE }),
    }
  })
  const harmonised = harmoniseAll(
    { colours, weights, anchors },
    ctx.grade,
    swatchesFor(model.swatches, ctx.palette),
    model.maxDeltaE ?? ctx.maxDeltaE,
  )
  const classified = harmonised.map(({ linear, token }): Classified => ({
    linear,
    emissive:
      token !== undefined && model.emissive.includes(token)
        ? glowColour(model, ctx, token)
        : undefined,
    token,
    label: token ?? `~${linearToHex(linear)}`,
  }))
  return (rgb: Rgb): Classified => {
    const hit = classified[index.get(colourKey(rgb)) ?? -1]
    if (hit === undefined)
      throw new Error(`${model.id}: colour ${colourKey(rgb)} was not classified`)
    return hit
  }
}

/** The glow colour of an emissive token: its catalog `glow` override, else the token itself. */
function glowColour(model: Model, ctx: BuildContext, token: string): Rgb {
  const [swatch] = swatchesFor([model.glow?.[token] ?? token], ctx.palette)
  if (swatch === undefined) throw new Error(`${model.id}: unknown glow token`)
  return swatch.linear
}

const toU8 = (c: number) => Math.round(Math.min(1, Math.max(0, c)) * 255)

interface Soup {
  positions: number[]
  normals: number[]
  colours: number[]
  emissive: number[]
  slots: number[]
}

function addPrimitive(
  model: Model,
  soup: Soup,
  prim: Primitive,
  world: Mat4,
  colours: readonly Rgb[],
  classify: (c: Rgb) => Classified,
  counts: Map<string, number>,
) {
  const position = prim.getAttribute('POSITION')
  if (position === null) throw new Error('primitive without POSITION')
  const normal = prim.getAttribute('NORMAL')
  const indices = triangleIndices(prim)
  const { matrix: nm, determinant } = normalMatrix(world)
  // A mirroring transform flips winding; swap two corners to keep faces pointing out.
  const order = determinant < 0 ? [0, 2, 1] : [0, 1, 2]
  const p: number[] = []
  const n: number[] = []
  for (let t = 0; t < indices.length; t += 3) {
    const c = classify(colours[t / 3] ?? [1, 1, 1])
    counts.set(c.label, (counts.get(c.label) ?? 0) + 1)
    const corners = order.map((k) => indices[t + k] ?? 0)
    const world3 = corners.map((index) => {
      position.getElement(index, p)
      return transformPoint(world, p[0] ?? 0, p[1] ?? 0, p[2] ?? 0)
    })
    let flat: number[] | undefined
    if (normal === null) {
      const [a = [0, 0, 0], b = [0, 0, 0], d = [0, 0, 0]] = world3
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]] as const
      const v = [d[0] - a[0], d[1] - a[1], d[2] - a[2]] as const
      flat = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
    }
    for (const [k, index] of corners.entries()) {
      const point = world3[k] ?? [0, 0, 0]
      soup.positions.push(point[0] ?? 0, point[1] ?? 0, point[2] ?? 0)
      let nx: number
      let ny: number
      let nz: number
      if (flat === undefined && normal !== null) {
        normal.getElement(index, n)
        nx = (nm[0] ?? 0) * (n[0] ?? 0) + (nm[3] ?? 0) * (n[1] ?? 0) + (nm[6] ?? 0) * (n[2] ?? 0)
        ny = (nm[1] ?? 0) * (n[0] ?? 0) + (nm[4] ?? 0) * (n[1] ?? 0) + (nm[7] ?? 0) * (n[2] ?? 0)
        nz = (nm[2] ?? 0) * (n[0] ?? 0) + (nm[5] ?? 0) * (n[1] ?? 0) + (nm[8] ?? 0) * (n[2] ?? 0)
      } else {
        ;[nx, ny, nz] = (flat ?? [0, 1, 0]) as [number, number, number]
      }
      const length = Math.hypot(nx, ny, nz) || 1
      soup.normals.push(nx / length, ny / length, nz / length)
      soup.colours.push(toU8(c.linear[0]), toU8(c.linear[1]), toU8(c.linear[2]))
      const glow = c.emissive ?? [0, 0, 0]
      soup.emissive.push(toU8(glow[0]), toU8(glow[1]), toU8(glow[2]))
      soup.slots.push(slotOf(model, c.token))
    }
  }
}

type Vec3 = [number, number, number]
interface Box {
  readonly min: Vec3
  readonly max: Vec3
}

function bounds(positions: ArrayLike<number>): Box {
  const min: Vec3 = [Infinity, Infinity, Infinity]
  const max: Vec3 = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i + k] ?? 0
      if (v < (min[k] ?? 0)) min[k] = v
      if (v > (max[k] ?? 0)) max[k] = v
    }
  }
  return { min, max }
}

function fitScale(model: Model, box: Box): number {
  const size = box.max.map((v, k) => v - (box.min[k] ?? 0))
  const { fit } = model
  if ('scale' in fit) return fit.scale
  const measure = 'height' in fit ? (size[1] ?? 0) : Math.max(size[0] ?? 0, size[2] ?? 0)
  if (!(measure > 0)) throw new Error(`${model.id}: cannot fit a model with no extent`)
  return ('height' in fit ? fit.height : fit.length) / measure
}

/** Rounds to 1e-4 m so bounds in the manifest do not churn on float noise. */
const round = (value: number) => Math.round(value * 10_000) / 10_000 + 0

function fittedBounds(box: Box): Box {
  const r = ([x, y, z]: Vec3): Vec3 => [round(x), round(y), round(z)]
  return { min: r(box.min), max: r(box.max) }
}

async function buildStatic(
  model: Model,
  pack: Pack,
  ctx: BuildContext,
  logger: CollectingLogger,
  tier: ModelTier,
) {
  const textures = new TextureCache()
  const parts: { prim: Primitive; world: Mat4; colours: Rgb[] }[] = []
  for (const entry of model.entries) {
    const src = await loadEntry(pack, entry.path, logger)
    const place = entryMatrix(entry.rotateYDeg, entry.at)
    const scene = src.getRoot().getDefaultScene() ?? src.getRoot().listScenes()[0]
    if (scene === undefined) throw new Error(`${model.id}: ${entry.path} has no scene`)
    scene.traverse((node: Node) => {
      const mesh = node.getMesh()
      if (mesh === null) return
      if (node.getSkin() !== null) throw new Error(`${model.id}: static model with a skinned mesh`)
      const world = multiply(place, node.getWorldMatrix())
      for (const prim of mesh.listPrimitives()) {
        simplifySource(src, prim, model.tiers[tier])
        parts.push({
          prim,
          world,
          colours: triangleColours(prim, textures, pack.source.factorEncoding),
        })
      }
    })
  }
  const classify = colourClassifier(
    model,
    ctx,
    parts.flatMap((part) => part.colours),
  )
  const counts = new Map<string, number>()
  const soup: Soup = { positions: [], normals: [], colours: [], emissive: [], slots: [] }
  for (const part of parts)
    addPrimitive(model, soup, part.prim, part.world, part.colours, classify, counts)
  if (soup.positions.length === 0) throw new Error(`${model.id}: no triangles`)

  const box = bounds(soup.positions)
  const scale = fitScale(model, box)
  const centre = [
    ((box.min[0] ?? 0) + (box.max[0] ?? 0)) / 2,
    model.pivot === 'center' ? ((box.min[1] ?? 0) + (box.max[1] ?? 0)) / 2 : (box.min[1] ?? 0),
    ((box.min[2] ?? 0) + (box.max[2] ?? 0)) / 2,
  ]
  const shift = model.pivot === 'source' ? [0, 0, 0] : centre
  const positions = Float32Array.from(soup.positions, (v, i) => (v - (shift[i % 3] ?? 0)) * scale)

  const doc = new Document().setLogger(logger)
  const buffer = doc.createBuffer()
  const accessor = (
    type: 'VEC3' | 'SCALAR',
    array: Float32Array<ArrayBuffer> | Uint8Array<ArrayBuffer>,
    normalized = false,
  ) =>
    doc.createAccessor().setType(type).setArray(array).setNormalized(normalized).setBuffer(buffer)
  const prim = doc
    .createPrimitive()
    .setAttribute('POSITION', accessor('VEC3', positions))
    .setAttribute('NORMAL', accessor('VEC3', Float32Array.from(soup.normals)))
    .setAttribute('COLOR_0', accessor('VEC3', Uint8Array.from(soup.colours), true))
    .setMaterial(placeholderMaterial(doc))
  const emissive = soup.emissive.some((v) => v > 0)
  if (emissive)
    prim.setAttribute('_EMISSIVE', accessor('VEC3', Uint8Array.from(soup.emissive), true))
  if (soup.slots.some((v) => v > 0))
    prim.setAttribute('_SLOT', accessor('SCALAR', Uint8Array.from(soup.slots)))
  const mesh = doc.createMesh(model.id).addPrimitive(prim)
  doc.createScene(model.id).addChild(doc.createNode(model.id).setMesh(mesh))
  return { doc, bounds: fittedBounds(bounds(positions)), emissive, counts }
}

function placeholderMaterial(doc: Document) {
  // Part 2 replaces it with the shared lit/toon material; vertex colours carry all colour.
  return doc
    .createMaterial('model')
    .setBaseColorFactor([1, 1, 1, 1])
    .setMetallicFactor(0)
    .setRoughnessFactor(1)
}

/**
 * Name of the joint with the largest weight at each triangle's first corner (after deindexing
 * every corner of a triangle shares its colour, so one joint per triangle is enough).
 */
function dominantJoints(prim: Primitive, skin: Skin | null): (string | undefined)[] {
  const joints = prim.getAttribute('JOINTS_0')
  const weights = prim.getAttribute('WEIGHTS_0')
  const count = (prim.getAttribute('POSITION')?.getCount() ?? 0) / 3
  if (skin === null || joints === null || weights === null) return new Array(count).fill(undefined)
  const names = skin.listJoints().map((joint) => joint.getName())
  const j: number[] = []
  const w: number[] = []
  return Array.from({ length: count }, (_, t) => {
    joints.getElement(t * 3, j)
    weights.getElement(t * 3, w)
    let best = 0
    for (let k = 1; k < w.length; k++) if ((w[k] ?? 0) > (w[best] ?? 0)) best = k
    return names[j[best] ?? -1]
  })
}

/**
 * Simplifies a source primitive for a tier BEFORE its colours are baked: the pack meshes share
 * vertices across faces (their atlas UVs are continuous), so meshoptimizer can collapse edges
 * there; after the bake every face owns its corners and nothing could collapse. Faces that merge
 * take the swatch under their new UV centroid.
 */
function simplifySource(
  doc: Document,
  prim: Primitive,
  { ratio, error }: Model['tiers'][ModelTier],
) {
  if (ratio >= 1) return
  // The bake reads only POSITION, NORMAL, the atlas UVs and skin weights: drop the rest and weld,
  // because duplicate vertices look like seams to the simplifier and stall it.
  const texCoord = prim.getMaterial()?.getBaseColorTextureInfo()?.getTexCoord() ?? 0
  for (const semantic of prim.listSemantics()) {
    const uv = /^TEXCOORD_(\d+)$/.exec(semantic)
    if (semantic === 'TANGENT' || (uv !== null && Number(uv[1]) !== texCoord)) {
      prim.setAttribute(semantic, null)
    }
  }
  weldPrimitive(prim)
  const position = prim.getAttribute('POSITION')
  if (position === null) return
  const positions = new Float32Array(position.getCount() * 3)
  const element: number[] = []
  for (let i = 0; i < position.getCount(); i++) {
    position.getElement(i, element)
    positions.set([element[0] ?? 0, element[1] ?? 0, element[2] ?? 0], i * 3)
  }
  const indices = triangleIndices(prim)
  const target = Math.floor((indices.length / 3) * ratio) * 3
  const [simplified] = MeshoptSimplifier.simplify(indices, positions, 3, target, error)
  prim.setIndices(
    doc
      .createAccessor()
      .setType('SCALAR')
      .setArray(new Uint32Array(simplified))
      .setBuffer(position.getBuffer()),
  )
}

/** Expands an indexed primitive so every triangle owns its three corners (for flat colours). */
function deindex(doc: Document, prim: Primitive): void {
  const indices = triangleIndices(prim)
  for (const semantic of prim.listSemantics()) {
    const src = prim.getAttribute(semantic)
    if (src === null) continue
    const size = src.getElementSize()
    const array = src.getArray()
    if (array === null) continue
    const Ctor = array.constructor as new (length: number) => TypedArray
    const out = new Ctor(indices.length * size)
    for (let i = 0; i < indices.length; i++) {
      const from = (indices[i] ?? 0) * size
      for (let k = 0; k < size; k++) out[i * size + k] = array[from + k] ?? 0
    }
    prim.setAttribute(
      semantic,
      doc
        .createAccessor()
        .setType(src.getType())
        .setArray(out)
        .setNormalized(src.getNormalized())
        .setBuffer(src.getBuffer()),
    )
  }
  prim.setIndices(null)
}

async function buildSkinned(
  model: Model,
  pack: Pack,
  ctx: BuildContext,
  logger: CollectingLogger,
  tier: ModelTier,
) {
  const [entry] = model.entries
  if (entry === undefined) throw new Error(`${model.id}: no entry`)
  const doc = await loadEntry(pack, entry.path, logger)
  const root = doc.getRoot()
  const counts = new Map<string, number>()
  let emissive = false
  let kept: Mesh | undefined
  for (const node of root.listNodes()) {
    const mesh = node.getMesh()
    if (mesh === null) continue
    const keep =
      model.kind === 'skinned' && (mesh.getName() === model.mesh || node.getName() === model.mesh)
    if (!keep) {
      node.setMesh(null).setSkin(null)
      continue
    }
    if (node.getSkin() === null) throw new Error(`${model.id}: ${model.mesh} is not skinned`)
    kept = mesh
  }
  if (model.kind === 'skinned' && kept === undefined) {
    throw new Error(`${model.id}: ${entry.path} has no mesh named ${model.mesh}`)
  }

  if (kept !== undefined) {
    const textures = new TextureCache()
    const material = placeholderMaterial(doc)
    for (const prim of kept.listPrimitives()) simplifySource(doc, prim, model.tiers[tier])
    const prims = kept.listPrimitives().map((prim) => ({
      prim,
      colours: triangleColours(prim, textures, pack.source.factorEncoding),
    }))
    const classify = colourClassifier(
      model,
      ctx,
      prims.flatMap((part) => part.colours),
    )
    const skin =
      root
        .listNodes()
        .find((node) => node.getMesh() === kept)
        ?.getSkin() ?? null
    for (const { prim, colours } of prims) {
      deindex(doc, prim)
      const joints = dominantJoints(prim, skin)
      for (const semantic of prim.listSemantics()) {
        if (/^(?:TEXCOORD_\d+|TANGENT|COLOR_\d+)$/.test(semantic)) prim.setAttribute(semantic, null)
      }
      const vertexCount = colours.length * 3
      const rgb = new Uint8Array(vertexCount * 3)
      const glow = new Uint8Array(vertexCount * 3)
      const slot = new Uint8Array(vertexCount)
      for (const [t, source] of colours.entries()) {
        const c = classify(source)
        counts.set(c.label, (counts.get(c.label) ?? 0) + 1)
        for (let k = 0; k < 3; k++) {
          const v = t * 3 + k
          rgb.set([toU8(c.linear[0]), toU8(c.linear[1]), toU8(c.linear[2])], v * 3)
          const g = c.emissive ?? [0, 0, 0]
          glow.set([toU8(g[0]), toU8(g[1]), toU8(g[2])], v * 3)
          slot[v] = slotOf(model, c.token, joints[t])
        }
      }
      const buffer = root.listBuffers()[0] ?? doc.createBuffer()
      prim.setAttribute(
        'COLOR_0',
        doc.createAccessor().setType('VEC3').setArray(rgb).setNormalized(true).setBuffer(buffer),
      )
      if (glow.some((v) => v > 0)) {
        emissive = true
        prim.setAttribute(
          '_EMISSIVE',
          doc.createAccessor().setType('VEC3').setArray(glow).setNormalized(true).setBuffer(buffer),
        )
      }
      if (slot.some((v) => v > 0)) {
        prim.setAttribute(
          '_SLOT',
          doc.createAccessor().setType('SCALAR').setArray(slot).setBuffer(buffer),
        )
      }
      prim.setMaterial(material)
    }
  }

  const animations = root.listAnimations()
  for (const clip of model.clips) {
    if (!animations.some((animation) => animation.getName() === clip)) {
      throw new Error(`${model.id}: ${entry.path} has no clip ${clip}`)
    }
  }
  for (const animation of animations) {
    if (model.clips.includes(animation.getName())) continue
    // Disposing an animation leaves its samplers holding their keyframe accessors, so prune
    // would keep the bytes; drop the samplers and channels first.
    for (const channel of animation.listChannels()) channel.dispose()
    for (const sampler of animation.listSamplers()) sampler.dispose()
    animation.dispose()
  }

  // One uniform scale at the top of the hierarchy: skinning, bind matrices and clips stay valid,
  // and every head, body and the rig share it, so parts from different characters line up.
  const scene = root.getDefaultScene() ?? root.listScenes()[0]
  if (scene === undefined) throw new Error(`${model.id}: ${entry.path} has no scene`)
  const scale = 'scale' in model.fit ? model.fit.scale : undefined
  if (scale === undefined) throw new Error(`${model.id}: skinned and rig models fit by scale`)
  for (const child of scene.listChildren()) {
    child.setTranslation(child.getTranslation().map((v) => v * scale) as [number, number, number])
    child.setScale(child.getScale().map((v) => v * scale) as [number, number, number])
  }
  let box: Box | undefined
  if (kept !== undefined) {
    const position = kept.listPrimitives()[0]?.getAttribute('POSITION')
    const array = position?.getArray()
    if (array === null || array === undefined) throw new Error(`${model.id}: no positions`)
    box = fittedBounds(bounds(Float32Array.from(array, (v) => v * scale)))
  }
  return { doc, bounds: box, emissive, counts }
}

async function finishTier(doc: Document, model: Model): Promise<BuiltTier> {
  const keepLeaves = model.kind !== 'static'
  await doc.transform(
    dedup(),
    prune({ keepLeaves }),
    ...(model.kind === 'rig' ? [resample()] : [weld()]),
    quantize({ pattern: QUANTIZE_PATTERN }),
    // Rigs have no primitives to reorder.
    ...(model.kind === 'rig' ? [] : [reorder({ encoder: MeshoptEncoder, target: 'size' })]),
    prune({ keepLeaves }),
  )
  for (const extension of doc.getRoot().listExtensionsUsed()) {
    if (!KEPT_EXTENSIONS.has(extension.extensionName)) extension.dispose()
  }
  if (doc.getRoot().listTextures().length > 0) throw new Error(`${model.id}: textures survived`)
  doc
    .createExtension(EXTMeshoptCompression)
    .setRequired(true)
    .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE })
  const io = new NodeIO()
    .registerExtensions([EXTMeshoptCompression, KHRMeshQuantization])
    .registerDependencies({ 'meshopt.encoder': encoderV0 })
    .setLogger(doc.getLogger())
  const bytes = await io.writeBinary(doc)
  let triangles = 0
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) triangles += (prim.getIndices()?.getCount() ?? 0) / 3
  }
  return { bytes, triangles }
}

export async function buildModel(model: Model, pack: Pack, ctx: BuildContext): Promise<BuiltModel> {
  await Promise.all([MeshoptEncoder.ready, MeshoptSimplifier.ready])
  const logger = new CollectingLogger()
  const tiers = {} as Record<ModelTier, BuiltTier>
  let built:
    | { doc: Document; bounds: Box | undefined; emissive: boolean; counts: Map<string, number> }
    | undefined
  // Each tier starts from a fresh build so simplification never compounds across tiers.
  for (const tier of MODEL_TIERS) {
    built =
      model.kind === 'static'
        ? await buildStatic(model, pack, ctx, logger, tier)
        : await buildSkinned(model, pack, ctx, logger, tier)
    tiers[tier] = await finishTier(built.doc, model)
  }
  if (built === undefined) throw new Error(`${model.id}: no tiers`)
  return {
    model,
    tiers,
    bounds: built.bounds,
    emissive: built.emissive,
    colours: built.counts,
    warnings: [...new Set(logger.warnings)],
  }
}
