/**
 * Boat speed from a polar: for each wind speed, speeds at a set of true wind angles. Between measured
 * angles speeds follow a monotone cubic (no invented peaks); between wind speeds, linear. Closer to the
 * wind than the first angle of a curve is the no-go zone: no drive at all.
 */

export interface PolarCurve {
  /** True wind speed, knots. */
  tws: number
  /** True wind angles, ascending, degrees. */
  twa: number[]
  /** Boat speed at each angle, knots. */
  bsp: number[]
}

export interface Polar {
  /** Boat speed (knots) at a true wind angle (either side) and true wind speed; 0 in the no-go zone. */
  speed(twa: number, tws: number): number
  /** Closest sailable angle to the wind at this wind speed. */
  minTwa(tws: number): number
}

// Fritsch–Carlson monotone cubic slopes.
function pchipSlopes(x: number[], y: number[]): number[] {
  const n = x.length
  const h: number[] = []
  const d: number[] = []
  for (let i = 0; i < n - 1; i++) {
    h.push(x[i + 1] - x[i])
    d.push((y[i + 1] - y[i]) / h[i])
  }
  const m = new Array<number>(n).fill(0)
  if (n === 2) {
    m[0] = m[1] = d[0]
    return m
  }
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) continue
    const w1 = 2 * h[i] + h[i - 1]
    const w2 = h[i] + 2 * h[i - 1]
    m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i])
  }
  const end = (h0: number, h1: number, d0: number, d1: number) => {
    let s = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1)
    if (Math.sign(s) !== Math.sign(d0)) s = 0
    else if (Math.sign(d0) !== Math.sign(d1) && Math.abs(s) > Math.abs(3 * d0)) s = 3 * d0
    return s
  }
  m[0] = end(h[0], h[1], d[0], d[1])
  m[n - 1] = end(h[n - 2], h[n - 3], d[n - 2], d[n - 3])
  return m
}

function interpolator(x: number[], y: number[]) {
  const n = x.length
  const m = pchipSlopes(x, y)
  return (a: number): number => {
    if (a < x[0] - 1e-9) return 0
    if (a >= x[n - 1]) return y[n - 1]
    let lo = 0
    let hi = n - 1
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (x[mid] <= a) lo = mid
      else hi = mid
    }
    const h = x[hi] - x[lo]
    const t = Math.min(1, Math.max(0, (a - x[lo]) / h))
    const t2 = t * t
    const t3 = t2 * t
    const v =
      (2 * t3 - 3 * t2 + 1) * y[lo] + (t3 - 2 * t2 + t) * h * m[lo] + (-2 * t3 + 3 * t2) * y[hi] + (t3 - t2) * h * m[hi]
    return Math.max(0, v)
  }
}

const MAX_TWS = 40

export function makePolar(input: PolarCurve[]): Polar {
  const curves = [...input].sort((a, b) => a.tws - b.tws)
  const fns = curves.map((c) => interpolator(c.twa, c.bsp))
  const tws = curves.map((c) => c.tws)
  const first = tws[0]
  const last = tws[tws.length - 1]
  const minAt = (w: number) => {
    if (w <= first) return curves[0].twa[0]
    if (w >= last) return curves[curves.length - 1].twa[0]
    let j = 0
    while (tws[j + 1] < w) j++
    const f = (w - tws[j]) / (tws[j + 1] - tws[j])
    return curves[j].twa[0] + (curves[j + 1].twa[0] - curves[j].twa[0]) * f
  }
  const raw = (a: number, w: number): number => {
    if (w <= 0 || a < minAt(w) - 1e-9) return 0
    // Below the lightest measured wind, speed falls off in proportion; above the strongest, it holds.
    if (w < first) return fns[0](a) * (w / first)
    if (w >= last) return fns[fns.length - 1](a)
    let j = 0
    while (tws[j + 1] < w) j++
    const f = (w - tws[j]) / (tws[j + 1] - tws[j])
    return fns[j](a) * (1 - f) + fns[j + 1](a) * f
  }
  // Speeds are looked up a lot (AI routing): cache on a 1° × 0.5 kn lattice and interpolate.
  const K = 2 * MAX_TWS + 1
  const cache = new Float32Array(181 * K)
  for (let a = 0; a <= 180; a++) for (let k = 0; k < K; k++) cache[a * K + k] = raw(a, k / 2)
  const at = (a: number, k: number) => cache[a * K + Math.min(K - 1, k)]
  return {
    minTwa: minAt,
    speed(twa, w) {
      let a = Math.abs(twa) % 360
      if (a > 180) a = 360 - a
      const fw = Math.min(MAX_TWS, Math.max(0, w)) * 2
      const k0 = Math.floor(fw)
      const tk = fw - k0
      if (a < minAt(w)) return 0
      const a0 = Math.floor(a)
      const ta = a - a0
      const a1 = Math.min(180, a0 + 1)
      const lo = (at(a0, k0) + (at(a0, k0 + 1) - at(a0, k0)) * tk) * (1 - ta)
      const hi = (at(a1, k0) + (at(a1, k0 + 1) - at(a1, k0)) * tk) * ta
      // Just past the no-go edge the lattice point below it is 0; use the exact value there.
      if (at(a0, k0) === 0 || at(a0, k0 + 1) === 0) return raw(a, w)
      return lo + hi
    },
  }
}
