/** Deterministic randomness: the same seed always gives the same map, wind and AI choices. */

export type Rng = () => number

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Integer hash of a few integers, for seeding sub-generators and lattice noise. */
export function hash(...xs: number[]): number {
  let h = 0x811c9dc5
  for (const x of xs) {
    h ^= x | 0
    h = Math.imul(h, 0x01000193)
    h ^= h >>> 13
    h = Math.imul(h, 0x5bd1e995)
    h ^= h >>> 15
  }
  return h >>> 0
}

/** Integer hash of a piece of text (FNV-1a over its UTF-16 code units). */
export function textHash(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** A fresh map: a random 32-bit generator number, as `seed:<number>` (see mapSeed). */
export const randomSeed = (rnd: () => number = Math.random) => `seed:${Math.floor(rnd() * 2 ** 32)}`

const smooth = (t: number) => t * t * t * (t * (t * 6 - 15) + 10)

/** Value noise in [−1, 1] on an integer lattice, smoothly interpolated. */
export function valueNoise(seed: number, x: number, y: number): number {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const fx = smooth(x - x0)
  const fy = smooth(y - y0)
  const v = (i: number, j: number) => (hash(seed, i, j) / 4294967296) * 2 - 1
  const a = v(x0, y0)
  const b = v(x0 + 1, y0)
  const c = v(x0, y0 + 1)
  const d = v(x0 + 1, y0 + 1)
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy
}

/** Fractal value noise, roughly in [−1, 1]. */
export function fbm(seed: number, x: number, y: number, octaves = 4): number {
  let sum = 0
  let amp = 1
  let norm = 0
  let f = 1
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(seed + o * 101, x * f, y * f)
    norm += amp
    amp *= 0.5
    f *= 2
  }
  return sum / norm
}

/** Value noise in [−1, 1] on an integer lattice in three dimensions (space and time). */
export function valueNoise3(seed: number, x: number, y: number, z: number): number {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const z0 = Math.floor(z)
  const fx = smooth(x - x0)
  const fy = smooth(y - y0)
  const fz = smooth(z - z0)
  const v = (i: number, j: number, k: number) => (hash(seed, i, j, k) / 4294967296) * 2 - 1
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t
  const plane = (k: number) =>
    lerp(lerp(v(x0, y0, k), v(x0 + 1, y0, k), fx), lerp(v(x0, y0 + 1, k), v(x0 + 1, y0 + 1, k), fx), fy)
  return lerp(plane(z0), plane(z0 + 1), fz)
}

/** Fractal 3-D value noise, roughly in [−1, 1]. */
export function fbm3(seed: number, x: number, y: number, z: number, octaves = 2): number {
  let sum = 0
  let amp = 1
  let norm = 0
  let f = 1
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise3(seed + o * 131, x * f, y * f, z * f)
    norm += amp
    amp *= 0.5
    f *= 2
  }
  return sum / norm
}

/** Smooth 1-D noise in [−1, 1]. */
export function noise1(seed: number, t: number): number {
  const t0 = Math.floor(t)
  const f = smooth(t - t0)
  const v = (i: number) => (hash(seed, i) / 4294967296) * 2 - 1
  return v(t0) + (v(t0 + 1) - v(t0)) * f
}
