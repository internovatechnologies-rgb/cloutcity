import { describe, expect, it } from 'vitest'
import { easeInOut, focusPose, mixPose } from './focus'

const current = { target: { x: 0, y: 30, z: 0 }, position: { x: 0, y: 3030, z: 4000 } }

describe('focusPose', () => {
  it('re-centres on the place, keeping the view direction, at most maxDistance away', () => {
    const pose = focusPose(current, { x: 1000, y: 30, z: -500 }, 3000)
    expect(pose.target).toEqual({ x: 1000, y: 30, z: -500 })
    const dx = pose.position.x - pose.target.x
    const dy = pose.position.y - pose.target.y
    const dz = pose.position.z - pose.target.z
    expect(Math.hypot(dx, dy, dz)).toBeCloseTo(3000, 6)
    // Same direction as before (3:4 rise over run).
    expect(dy / dz).toBeCloseTo(3000 / 4000, 6)
    expect(dx).toBeCloseTo(0, 6)
  })

  it('keeps a closer view as it is', () => {
    const near = { target: { x: 0, y: 30, z: 0 }, position: { x: 0, y: 630, z: 800 } }
    const pose = focusPose(near, { x: 50, y: 30, z: 50 }, 3000)
    expect(pose.position).toEqual({ x: 50, y: 630, z: 850 })
  })
})

describe('easeInOut and mixPose', () => {
  it('runs from 0 to 1, clamped, symmetric about the middle', () => {
    expect(easeInOut(0)).toBe(0)
    expect(easeInOut(1)).toBe(1)
    expect(easeInOut(-1)).toBe(0)
    expect(easeInOut(2)).toBe(1)
    expect(easeInOut(0.5)).toBeCloseTo(0.5, 9)
    expect(easeInOut(0.25) + easeInOut(0.75)).toBeCloseTo(1, 9)
  })

  it('mixes target and position linearly', () => {
    const to = focusPose(current, { x: 1000, y: 30, z: 0 }, 1e9)
    expect(mixPose(current, to, 0)).toEqual(current)
    expect(mixPose(current, to, 1)).toEqual(to)
    expect(mixPose(current, to, 0.5).target.x).toBe(500)
  })
})
