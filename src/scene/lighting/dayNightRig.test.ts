import { describe, expect, it } from 'vitest'
import { Color } from 'three'
import { lightingAt } from '@/lib/dayNight/lightingAt'
import { lightingKey } from '@/lib/dayNight/lightingKey'
import { scene } from '@/lib/data/config'
import { joinSkyColors } from '@/lib/dayNight/joinSky'
import { dayNightModel, skyColors } from '@/lib/theme'
import { applyUniforms } from './DayNightRig'
import { createDayNightUniforms } from './nightGlow'
import { canonicalMinute } from './useDayNightLighting'

const model = dayNightModel()

describe('canonical minute (S04f: redraw only when the lighting changes)', () => {
  it('maps every minute of a hold to the keyframe, so the lighting value stays the same', () => {
    const day = model.keyframes.find((keyframe) => keyframe.id === 'day')
    if (day === undefined) throw new Error('no day keyframe')
    const minutes = [day.atMinute, day.atMinute + 7, day.atMinute + day.holdMinutes]
    expect(new Set(minutes.map((minute) => canonicalMinute(minute, model, false)))).toEqual(
      new Set([day.atMinute]),
    )
  })

  it('keys a blend by its quantised minute, so it redraws once per step', () => {
    // 06:30 blends dawn into morning.
    const a = canonicalMinute(390, model, false)
    const b = canonicalMinute(392, model, false)
    const c = canonicalMinute(395, model, false)
    expect(a).toBe(b)
    expect(c).not.toBe(a)
    expect(lightingKey(lightingAt(a, model))).not.toBe(lightingKey(lightingAt(c, model)))
  })

  it('steps to the keyframe under reduced motion', () => {
    const dawn = model.keyframes.find((keyframe) => keyframe.id === 'dawn')
    expect(canonicalMinute(390, model, true)).toBe(dawn?.atMinute)
  })

  it('gives the same lighting as the minute it stands for', () => {
    for (let minute = 0; minute < 1440; minute += 13) {
      for (const step of [false, true]) {
        const own = lightingAt(minute, model, { step })
        const canonical = lightingAt(canonicalMinute(minute, model, step), model, { step })
        expect({ ...canonical, minute: 0 }).toEqual({ ...own, minute: 0 })
      }
    }
  })
})

describe('the 3D chunk joins the keyframes with the sky colours', () => {
  it('builds the same model the server resolves', () => {
    expect(joinSkyColors(scene.dayNight, skyColors())).toEqual(model)
  })
})

describe('day/night uniforms', () => {
  it('writes the night glow and the unlit tint the materials share', () => {
    const uniforms = createDayNightUniforms()
    const tint = uniforms.unlitTint.value
    const night = lightingAt(23 * 60, model)
    applyUniforms(uniforms, night)
    expect(uniforms.uNightGlow.value).toBe(1)
    // The same Color object: every material holding it follows without a re-render.
    expect(uniforms.unlitTint.value).toBe(tint)
    expect(tint.getHex()).toBe(new Color(night.colors.unlitTint).getHex())
    applyUniforms(uniforms, lightingAt(12 * 60, model))
    expect(uniforms.uNightGlow.value).toBe(0)
  })
})
