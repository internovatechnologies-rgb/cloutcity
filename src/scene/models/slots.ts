/**
 * `_SLOT` recolour (S04h): the asset build tags each vertex of a recolourable region (skin,
 * hair, top, a car body, a facade) with `_slot` = slot index + 1 (0 = fixed colour). A variant
 * gets a geometry that shares every attribute with the cached original except its own copy of
 * `color`, so a recoloured car or outfit costs one colour buffer, not a second model.
 */
import { BufferAttribute, BufferGeometry, Color } from 'three'

/** Slot name → sRGB hex; slots left out keep their baked colour. */
export type SlotColors = Readonly<Record<string, string>>

/** A stable key for a recolour, for caching variants ('' = no recolour). */
export function slotColorsKey(colors: SlotColors | undefined): string {
  if (colors === undefined) return ''
  return Object.keys(colors)
    .sort()
    .map((slot) => `${slot}=${colors[slot]}`)
    .join(';')
}

/**
 * The geometry recoloured, or the geometry itself when nothing applies. Unknown slot names
 * throw: a typo in config must not silently leave a model unrecoloured.
 */
export function recolorGeometry(
  geometry: BufferGeometry,
  slots: readonly string[],
  colors: SlotColors | undefined,
): BufferGeometry {
  if (colors === undefined || Object.keys(colors).length === 0) return geometry
  const linear: (Color | undefined)[] = slots.map((slot) => {
    const hex = colors[slot]
    // Color.set() converts sRGB hex into three's linear working space, matching the baked
    // (linear) vertex colours.
    return hex === undefined ? undefined : new Color(hex)
  })
  for (const slot of Object.keys(colors)) {
    if (!slots.includes(slot)) throw new Error(`Unknown recolour slot "${slot}"`)
  }
  const slotAttribute = geometry.getAttribute('_slot')
  const source = geometry.getAttribute('color')
  if (slotAttribute === undefined || source === undefined) {
    throw new Error('Recolour needs `_slot` and `color` attributes')
  }
  const color = (source as BufferAttribute).clone()
  for (let i = 0; i < slotAttribute.count; i++) {
    const target = linear[slotAttribute.getX(i) - 1]
    if (target !== undefined) color.setXYZ(i, target.r, target.g, target.b)
  }
  const recolored = new BufferGeometry()
  recolored.setIndex(geometry.index)
  for (const [name, attribute] of Object.entries(geometry.attributes)) {
    recolored.setAttribute(name, name === 'color' ? color : attribute)
  }
  recolored.boundingBox = geometry.boundingBox
  recolored.boundingSphere = geometry.boundingSphere
  return recolored
}

/**
 * Frees a recoloured variant's own colour buffer. three r182's renderer frees the GPU buffer of
 * every attribute on a disposed geometry, so the shared attributes are detached first: freeing
 * them would leave the original's cached vertex-array state pointing at deleted buffers.
 */
export function disposeRecolored(original: BufferGeometry, variant: BufferGeometry): void {
  if (variant === original) return
  variant.setIndex(null)
  for (const name of Object.keys(variant.attributes)) {
    if (variant.getAttribute(name) === original.getAttribute(name)) variant.deleteAttribute(name)
  }
  variant.dispose()
}
