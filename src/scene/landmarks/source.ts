/**
 * Where each landmark's model comes from (DEC-25). Every landmark uses the code-built kit
 * (buildLandmark) today; the Blender-made glTF models (S07c, through S04h's pipeline) replace
 * them one landmark at a time by joining GLB_LANDMARKS, and the kit stays the fallback for any
 * landmark without one.
 */
export type LandmarkSource = 'kit' | 'glb'

/** Landmarks whose Blender model has landed (none yet). */
const GLB_LANDMARKS: ReadonlySet<string> = new Set<string>()

export function landmarkSource(id: string): LandmarkSource {
  return GLB_LANDMARKS.has(id) ? 'glb' : 'kit'
}
