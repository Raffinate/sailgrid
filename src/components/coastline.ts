import type { Pt } from "../game/geom.ts"
import type { GameMap } from "../game/map.ts"

/**
 * The land as polygons and the coastline as segments, in grid units, by marching squares over the height
 * field. It follows the same surface the boats sail on (`heightAt`: bilinear between intersections), so
 * what's drawn as water can be sailed and what's drawn as land can't.
 *
 * The one case that needs care is a cell with land on two opposite corners and water on the other two.
 * Whether the two pieces of land meet depends on the height in the middle of the cell: above sea level
 * they join and close the channel; at or below it there's a channel between them, and boats sail
 * through it. Each piece of coast there also bends in toward the middle, so a point on the diagonal is
 * added where the surface crosses sea level.
 */
export interface Coastline {
  /** Land polygons. */
  land: Pt[][]
  /** Coast segments: where land meets water. */
  coast: [Pt, Pt][]
}

/** Where h goes from 0 at one end of a diagonal: the root of the bilinear surface along it, nearest `from`. */
function diagonalZero(from: number, to: number, side1: number, side2: number): number {
  // Along the diagonal, h(t) = from·(1−t)² + to·t² + (side1 + side2)·t·(1−t).
  const A = from + to - side1 - side2
  const B = side1 + side2 - 2 * from
  const C = from
  if (Math.abs(A) < 1e-12) return Math.min(1, Math.max(0, -C / B))
  const disc = Math.max(0, B * B - 4 * A * C)
  const s = Math.sqrt(disc)
  const roots = [(-B - s) / (2 * A), (-B + s) / (2 * A)].filter((t) => t >= 0 && t <= 1)
  return roots.length ? Math.min(...roots) : 0.5
}

export function coastline(m: GameMap): Coastline {
  const land: Pt[][] = []
  const coast: [Pt, Pt][] = []
  const W = m.width
  for (let y = 0; y < m.height - 1; y++)
    for (let x = 0; x < W - 1; x++) {
      // Corners clockwise from the top left.
      const c: [number, number, number][] = [
        [x, y, m.h[y * W + x]],
        [x + 1, y, m.h[y * W + x + 1]],
        [x + 1, y + 1, m.h[(y + 1) * W + x + 1]],
        [x, y + 1, m.h[(y + 1) * W + x]],
      ]
      const wet = c.map((k) => k[2] <= 0)
      const inside = wet.filter((w) => !w).length
      if (inside === 0) continue
      if (inside === 4) {
        land.push([
          { x, y },
          { x: x + 1, y },
          { x: x + 1, y: y + 1 },
          { x, y: y + 1 },
        ])
        continue
      }
      /** Where the coast crosses the edge from corner i to the next. */
      const edge = (i: number): Pt => {
        const a = c[i]
        const b = c[(i + 1) % 4]
        const t = a[2] / (a[2] - b[2])
        return { x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t }
      }
      /** Where the coast crosses the diagonal from corner i (toward the opposite corner). */
      const diagonal = (i: number): Pt => {
        const o = (i + 2) % 4
        const t = diagonalZero(c[i][2], c[o][2], c[(i + 1) % 4][2], c[(i + 3) % 4][2])
        return { x: c[i][0] + (c[o][0] - c[i][0]) * t, y: c[i][1] + (c[o][1] - c[i][1]) * t }
      }
      const saddle = inside === 2 && wet[0] === wet[2]
      if (saddle) {
        // The bilinear surface in the middle of the cell is the mean of its corners.
        const joined = (c[0][2] + c[1][2] + c[2][2] + c[3][2]) / 4 > 0
        if (joined) {
          // One piece of land across the cell, with each water corner biting into it.
          const poly: Pt[] = []
          for (let i = 0; i < 4; i++) {
            if (wet[i]) {
              const q = diagonal(i)
              poly.push(q, edge(i))
              coast.push([edge((i + 3) % 4), q], [q, edge(i)])
            } else poly.push({ x: c[i][0], y: c[i][1] }, edge(i))
          }
          land.push(poly)
        } else {
          // A channel through the middle: each land corner is its own little headland.
          for (let i = 0; i < 4; i++) {
            if (wet[i]) continue
            const [a, q, b] = [edge(i), diagonal(i), edge((i + 3) % 4)]
            land.push([{ x: c[i][0], y: c[i][1] }, a, q, b])
            coast.push([a, q], [q, b])
          }
        }
        continue
      }
      const poly: Pt[] = []
      const crossings: Pt[] = []
      for (let i = 0; i < 4; i++) {
        if (!wet[i]) poly.push({ x: c[i][0], y: c[i][1] })
        if (wet[i] !== wet[(i + 1) % 4]) {
          const p = edge(i)
          poly.push(p)
          crossings.push(p)
        }
      }
      land.push(poly)
      if (crossings.length === 2) coast.push([crossings[0], crossings[1]])
    }
  return { land, coast }
}
