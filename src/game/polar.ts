/**
 * Boat speed from a polar table, interpolated the same way as boatpolarsolver: monotone cubic between
 * measured angles (no invented peaks), linear between wind speeds. Angles inside the no-go zone have
 * no speed at all.
 */

export interface PolarTable {
  name: string
  tws: number[]
  twa: number[]
  /** bsp[i][j]: boat speed at twa[i] and tws[j], knots. */
  bsp: number[][]
}

/** Beneteau First 40.7 (OpenCPN Weather Routing polar): a well-known club racer. */
export const FIRST_40_7: PolarTable = {
  name: "Beneteau First 40.7",
  tws: [4, 6, 8, 10, 12, 14, 16, 20, 25, 30],
  twa: [33, 36, 39, 42, 45, 50, 60, 70, 80, 90, 100, 110, 120, 130, 135, 140, 150, 160, 170, 180],
  bsp: [
    [2.4, 3.6, 4.5, 5.2, 5.6, 5.9, 6.1, 6.1, 5.7, 4.7],
    [2.7, 4, 5, 5.7, 6.1, 6.4, 6.5, 6.6, 6.3, 5.8],
    [3, 4.4, 5.4, 6.1, 6.5, 6.7, 6.8, 6.9, 6.8, 6.4],
    [3.2, 4.7, 5.8, 6.4, 6.8, 7, 7.1, 7.2, 7.1, 6.9],
    [3.5, 5, 6.1, 6.7, 7, 7.2, 7.3, 7.4, 7.4, 7.2],
    [3.8, 5.4, 6.4, 7, 7.3, 7.4, 7.5, 7.6, 7.7, 7.6],
    [4.3, 5.9, 6.9, 7.4, 7.7, 7.8, 8, 8.1, 8.2, 8.2],
    [4.6, 6.2, 7.2, 7.7, 8, 8.2, 8.3, 8.5, 8.6, 8.7],
    [4.7, 6.4, 7.2, 7.8, 8.1, 8.4, 8.6, 8.8, 9, 9.2],
    [4.7, 6.3, 7.2, 7.8, 8.2, 8.5, 8.8, 9.2, 9.5, 9.7],
    [4.5, 6.2, 7.3, 7.9, 8.2, 8.5, 8.8, 9.5, 9.9, 10.2],
    [4.4, 6.1, 7.2, 7.8, 8.3, 8.6, 8.9, 9.4, 10.3, 10.9],
    [4.2, 5.9, 7, 7.7, 8.2, 8.6, 9, 9.6, 10.3, 11.4],
    [3.8, 5.4, 6.7, 7.4, 8, 8.5, 8.9, 9.8, 11, 12],
    [3.5, 5.2, 6.5, 7.3, 7.9, 8.3, 8.8, 9.7, 11.2, 12.6],
    [3.3, 4.9, 6.2, 7.1, 7.7, 8.2, 8.6, 9.5, 11.1, 13],
    [2.8, 4.3, 5.5, 6.6, 7.3, 7.8, 8.2, 9.1, 10.4, 12.3],
    [2.4, 3.6, 4.8, 5.9, 6.7, 7.4, 7.9, 8.7, 9.8, 11.4],
    [2.2, 3.3, 4.4, 5.4, 6.3, 7, 7.6, 8.4, 9.4, 10.7],
    [2, 3.1, 4.1, 5.1, 6, 6.7, 7.3, 8.2, 9.1, 10.2],
  ],
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

function curve(x: number[], y: number[]) {
  const n = x.length
  const m = pchipSlopes(x, y)
  return (a: number): number | null => {
    if (a < x[0] - 1e-9 || a > x[n - 1] + 1e-9) return null
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

export interface Polar {
  name: string
  /** Smallest sailable true wind angle. */
  minTwa: number
  /** Boat speed (knots) at a true wind angle (either side) and true wind speed; 0 in the no-go zone. */
  speed(twa: number, tws: number): number
}

export function makePolar(table: PolarTable): Polar {
  const curves = table.tws.map((_, j) =>
    curve(
      table.twa,
      table.bsp.map((row) => row[j]),
    ),
  )
  const tws = table.tws
  // Speeds are looked up a lot (AI routing): cache on a 1° × 0.5 kn lattice and interpolate linearly.
  const raw = (a: number, w: number): number => {
    if (w <= 0) return 0
    if (w < tws[0]) return (curves[0](a) ?? 0) * (w / tws[0])
    if (w >= tws[tws.length - 1]) return curves[tws.length - 1](a) ?? 0
    let j = 0
    while (tws[j + 1] < w) j++
    const v0 = curves[j](a)
    const v1 = curves[j + 1](a)
    if (v0 === null || v1 === null) return 0
    return v0 + ((v1 - v0) * (w - tws[j])) / (tws[j + 1] - tws[j])
  }
  const W_STEPS = 2 * tws[tws.length - 1] + 1
  const cache = new Float32Array(181 * W_STEPS)
  for (let a = 0; a <= 180; a++) for (let k = 0; k < W_STEPS; k++) cache[a * W_STEPS + k] = raw(a, k / 2)
  const at = (a: number, k: number) => cache[a * W_STEPS + Math.min(W_STEPS - 1, k)]
  return {
    name: table.name,
    minTwa: table.twa[0],
    speed(twa, w) {
      let a = Math.abs(twa) % 360
      if (a > 180) a = 360 - a
      if (a < table.twa[0]) return 0
      const fw = Math.max(0, w * 2)
      const a0 = Math.floor(a)
      const k0 = Math.floor(fw)
      const ta = a - a0
      const tk = fw - k0
      const a1 = Math.min(180, a0 + 1)
      const v00 = at(a0, k0)
      const v01 = at(a0, k0 + 1)
      const v10 = at(a1, k0)
      const v11 = at(a1, k0 + 1)
      // The cached lattice point just below minTwa is 0; don't let it bleed into sailable angles.
      if (a0 < table.twa[0]) return v10 + (v11 - v10) * tk
      return (v00 + (v01 - v00) * tk) * (1 - ta) + (v10 + (v11 - v10) * tk) * ta
    },
  }
}

export const defaultPolar = makePolar(FIRST_40_7)
