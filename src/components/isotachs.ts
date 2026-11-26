import type { Pt } from "../game/geom.ts"
import type { GameMap } from "../game/map.ts"

/** The isotachs go through these percentiles of the wind on the water this turn. */
export const ISOTACH_PERCENTILES = [20, 50, 80]

/**
 * The speeds to draw isotachs at this turn: the 20th, 50th and 80th percentile of the wind over open water,
 * each rounded to a whole knot (fewer when two round to the same knot).
 */
export function isotachLevels(m: GameMap, speed: ArrayLike<number>, percentiles = ISOTACH_PERCENTILES): number[] {
  const water: number[] = []
  for (let i = 0; i < m.width * m.height; i++) if (m.h[i] <= 0) water.push(speed[i])
  if (!water.length) return []
  water.sort((a, b) => a - b)
  const at = (q: number) => water[Math.min(water.length - 1, Math.round((q / 100) * (water.length - 1)))]
  return [...new Set(percentiles.map((q) => Math.round(at(q))))]
}

export interface Isotach {
  /** Wind speed along the line, knots. */
  level: number
  /** Short pieces of the line, in grid coordinates; together they make up every line at this speed. */
  segments: [Pt, Pt][]
}

/**
 * Lines of equal wind speed through the field (marching squares, one grid square at a time), leaving out
 * squares that touch land. A square whose corners are split across the diagonal takes the reading at its
 * centre to decide which way the line runs.
 */
export function isotachs(m: GameMap, speed: ArrayLike<number>, levels: number[]): Isotach[] {
  const W = m.width
  const out: Isotach[] = levels.map((level) => ({ level, segments: [] }))
  for (let y = 0; y < m.height - 1; y++)
    for (let x = 0; x < W - 1; x++) {
      const ia = y * W + x
      const ib = ia + 1
      const id = ia + W
      const ic = id + 1
      if (m.h[ia] > 0 || m.h[ib] > 0 || m.h[ic] > 0 || m.h[id] > 0) continue
      const a = speed[ia]
      const b = speed[ib]
      const c = speed[ic]
      const d = speed[id]
      const lo = Math.min(a, b, c, d)
      const hi = Math.max(a, b, c, d)
      for (const iso of out) {
        const L = iso.level
        if (L < lo || L > hi) continue
        const cut = (u: number, w: number) => (w === u ? 0.5 : Math.min(1, Math.max(0, (L - u) / (w - u))))
        // Where the line crosses each side of the square: top a–b, right b–c, bottom d–c, left a–d.
        const edge = (e: number): Pt =>
          e === 0
            ? { x: x + cut(a, b), y }
            : e === 1
              ? { x: x + 1, y: y + cut(b, c) }
              : e === 2
                ? { x: x + cut(d, c), y: y + 1 }
                : { x, y: y + cut(a, d) }
        const k = (a >= L ? 8 : 0) | (b >= L ? 4 : 0) | (c >= L ? 2 : 0) | (d >= L ? 1 : 0)
        const centreHigh = (a + b + c + d) / 4 >= L
        const pairs: [number, number][] =
          k === 1 || k === 14
            ? [[3, 2]]
            : k === 2 || k === 13
              ? [[2, 1]]
              : k === 3 || k === 12
                ? [[3, 1]]
                : k === 4 || k === 11
                  ? [[0, 1]]
                  : k === 6 || k === 9
                    ? [[0, 2]]
                    : k === 7 || k === 8
                      ? [[3, 0]]
                      : k === 5
                        ? centreHigh
                          ? [
                              [3, 0],
                              [2, 1],
                            ]
                          : [
                              [0, 1],
                              [3, 2],
                            ]
                        : k === 10
                          ? centreHigh
                            ? [
                                [0, 1],
                                [3, 2],
                              ]
                            : [
                                [3, 0],
                                [2, 1],
                              ]
                          : []
        for (const [e0, e1] of pairs) iso.segments.push([edge(e0), edge(e1)])
      }
    }
  return out
}
