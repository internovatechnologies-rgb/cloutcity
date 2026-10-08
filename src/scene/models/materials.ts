/**
 * The shared material every hand-made model draws with (S04h, DEC-26). Colour comes from the
 * baked vertex colours, so one material serves every static model, instanced or not, and every
 * skinned avatar part (three r182 picks the skinning program variant per object). Shading is
 * scene.json `models.shading`: `lit` uses MeshStandardMaterial or the cheaper Lambert per tier
 * (`litMaterial`), `toon` the city's shared toon ramp.
 *
 * Night glow goes through the S04f contract: `patchNightGlow(material, 'attribute', …)` reads
 * each vertex's `_emissive` colour and the shared `uNightGlow` (0 by day, 1 at night). The glow
 * colour is scene.json `models.emissive.nightIntensity` as a grey, so a vertex glows
 * `_emissive × nightIntensity × uNightGlow`; `dayIntensity` must stay 0 (the contract has no day
 * term, and src/scene/models/models.test.ts holds it there).
 */
import {
  Color,
  MeshLambertMaterial,
  MeshStandardMaterial,
  MeshToonMaterial,
  type DataTexture,
  type IUniform,
  type Material,
} from 'three'
import { NIGHT_GLOW_ATTRIBUTE, patchNightGlow } from '../lighting/nightGlow'
import type { ModelsConfig, ModelTier } from './types'

export interface ModelMaterialOptions {
  readonly config: ModelsConfig
  readonly tier: ModelTier
  /** The city's toon ramp (materials.ts createToonRamp), used when shading is `toon`. */
  readonly gradientMap?: DataTexture
  /** The shared `uNightGlow` uniform (useNightGlow); without it the models never glow. */
  readonly nightGlow?: IUniform<number>
}

export function createModelMaterial({
  config,
  tier,
  gradientMap,
  nightGlow,
}: ModelMaterialOptions): Material {
  const material = baseMaterial(config, tier, gradientMap)
  if (nightGlow !== undefined && config.emissive.nightIntensity > 0) {
    const k = config.emissive.nightIntensity
    patchNightGlow(material, 'attribute', { uniform: nightGlow, color: new Color(k, k, k) })
    // Models without `_emissive` (avatars, plain furniture) share this program: three then
    // feeds the attribute a WebGL generic value, which is global state another draw may have
    // left non-zero. A material default pins it to "no glow" (WebGLBindingStates reads it).
    Object.assign(material, { defaultAttributeValues: { [NIGHT_GLOW_ATTRIBUTE]: [0, 0, 0] } })
  }
  return material
}

function baseMaterial(
  config: ModelsConfig,
  tier: ModelTier,
  gradientMap: DataTexture | undefined,
): Material {
  if (config.shading === 'toon') {
    if (gradientMap === undefined) throw new Error('Toon model shading needs the toon ramp')
    return new MeshToonMaterial({ vertexColors: true, gradientMap })
  }
  if (config.litMaterial[tier] === 'lambert') return new MeshLambertMaterial({ vertexColors: true })
  return new MeshStandardMaterial({
    vertexColors: true,
    roughness: config.roughness,
    metalness: config.metalness,
  })
}
