import { describe, expect, it } from 'vitest'
import { SHOWCASE_TIMES, SHOWCASE_VIEWS } from '@/lib/data/schemas/assets'
import { resolveShowcase, showcase, tokenHex } from './resolve'

describe('resolveShowcase', () => {
  it.each(SHOWCASE_VIEWS.flatMap((view) => SHOWCASE_TIMES.map((time) => [view, time] as const)))(
    '%s at %s resolves every model id and colour token',
    (view, time) => {
      const resolved = resolveShowcase(view, time, 'mid')
      for (const ground of resolved.grounds) expect(ground.color).toMatch(/^#[0-9a-f]{6}$/)
      for (const group of resolved.groups) {
        expect(group.model.kind).toBe('static')
        expect(group.placements.length).toBeGreaterThan(0)
      }
      for (const avatar of resolved.lineup?.avatars ?? []) {
        expect(avatar.head.category).toBe('avatar-head')
        expect(avatar.body.category).toBe('avatar-body')
        for (const slot of Object.keys(avatar.colors.head ?? {})) {
          expect(avatar.head.slots).toContain(slot)
        }
        for (const slot of Object.keys(avatar.colors.body ?? {})) {
          expect(avatar.body.slots).toContain(slot)
        }
      }
    },
  )

  it('groups repeated placements of a model into one instanced draw', () => {
    const street = resolveShowcase('street', 'golden', 'high')
    const ids = street.groups.map((group) => group.model.id)
    expect(new Set(ids).size).toBe(ids.length)
    const lights = street.groups.find((group) => group.model.id === 'streetlight')
    expect(lights?.placements.length).toBe(
      showcase.views.street.placements.filter((p) => p.model === 'streetlight').length,
    )
  })

  it('drives the night-glow uniform at night only', () => {
    expect(resolveShowcase('street', 'night', 'high').nightGlow).toBe(1)
    expect(resolveShowcase('street', 'golden', 'high').nightGlow).toBe(0)
  })

  it('shows the whole static catalog in the catalog view', () => {
    const grid = resolveShowcase('catalog', 'day', 'low').grid
    expect(grid?.models.every((model) => model.kind === 'static')).toBe(true)
    expect(grid?.models.length).toBeGreaterThan(40)
  })

  it('rejects an unknown colour token', () => {
    expect(() => tokenHex('neon-999')).toThrow(/neon-999/)
  })
})
