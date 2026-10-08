/**
 * Seeded randomness. The engine never calls Math.random (lint-enforced); anything random takes
 * an `Rng` built from a seed the caller owns, so the same seed always gives the same game.
 *
 * mulberry32: a 32-bit generator with a full 2^32 period, plenty for picking events. Its whole
 * state is one uint32, which the save keeps so a reload cannot re-roll an outcome.
 */

export interface Rng {
  /** A number in [0, 1). */
  next(): number
  /** The current uint32 state; `createRng(state)` continues the same sequence. */
  readonly state: number
}

const UINT32 = 4_294_967_296

export function createRng(seed: number): Rng {
  if (!Number.isFinite(seed)) throw new RangeError(`seed must be a finite number: ${seed}`)
  let state = seed >>> 0
  return {
    next() {
      state = (state + 0x6d2b79f5) >>> 0
      let t = state
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / UINT32
    },
    get state() {
      return state
    },
  }
}

/** Combines two integers into one well-spread uint32 seed (a murmur3-style finaliser). */
export function mixSeed(a: number, b: number): number {
  let h = (a ^ Math.imul(b >>> 0, 0x9e3779b1)) >>> 0
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return (h ^ (h >>> 16)) >>> 0
}

/** A whole number in [min, max], from one draw. */
export function rollInt(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng.next() * (max - min + 1))
}
