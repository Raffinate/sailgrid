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
 * through it. Each piece of coast there follows the surface's own curve across the cell (see `curve`), as
 * the narrowest point of the channel can be anywhere in it, not just in the middle.
 */
export interface Coastline {
  /** Land polygons. */
  land: Pt[][]
  /** Coast segments: where land meets water. */
  coast: [Pt, Pt][]
}

/** Points drawn along each curved piece of coast in a cell where two islands nearly meet. */
const CURVE_POINTS = 8

/**
 * Points along sea level on the bilinear surface of a cell, strictly between two points `from` and `to` on
 * its edges (corner heights a, b, c, d clockwise from the top left at x0, y0). Across a cell each piece of
 * sea level is a branch of a hyperbola, which crosses every row and column of the cell at most once, so
 * it's found exactly at evenly spaced steps along whichever way it runs further.
 */
function curve(x0: number, y0: number, a: number, b: number, c: number, d: number, from: Pt, to: Pt): Pt[] {
  const out: Pt[] = []
  const alongX = Math.abs(to.x - from.x) >= Math.abs(to.y - from.y)
  const clamp = (t: number) => Math.min(1, Math.max(0, t))
  for (let k = 1; k < CURVE_POINTS; k++) {
    const f = k / CURVE_POINTS
    if (alongX) {
      const u = from.x - x0 + (to.x - from.x) * f
      // Down the column at u: h goes from the top edge's height to the bottom edge's.
      const top = a * (1 - u) + b * u
      const bottom = d * (1 - u) + c * u
      if (top === bottom) continue
      out.push({ x: x0 + u, y: y0 + clamp(top / (top - bottom)) })
    } else {
      const v = from.y - y0 + (to.y - from.y) * f
      const left = a * (1 - v) + d * v
      const right = b * (1 - v) + c * v
      if (left === right) continue
      out.push({ x: x0 + clamp(left / (left - right)), y: y0 + v })
    }
  }
  return out
}

/** Coast segments joining a run of points. */
const chain = (pts: Pt[]): [Pt, Pt][] => pts.slice(1).map((p, i) => [pts[i], p])

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
      /** The coast from one edge crossing to another, round the corner between them. */
      const between = (from: Pt, to: Pt): Pt[] => [from, ...curve(x, y, c[0][2], c[1][2], c[2][2], c[3][2], from, to), to]
      const saddle = inside === 2 && wet[0] === wet[2]
      if (saddle) {
        // The bilinear surface in the middle of the cell is the mean of its corners.
        const joined = (c[0][2] + c[1][2] + c[2][2] + c[3][2]) / 4 > 0
        if (joined) {
          // One piece of land across the cell, with each water corner biting into it.
          const poly: Pt[] = []
          for (let i = 0; i < 4; i++) {
            if (wet[i]) {
              const run = between(edge((i + 3) % 4), edge(i))
              poly.push(...run.slice(1))
              coast.push(...chain(run))
            } else poly.push({ x: c[i][0], y: c[i][1] }, edge(i))
          }
          land.push(poly)
        } else {
          // A channel through the middle: each land corner is its own little headland.
          for (let i = 0; i < 4; i++) {
            if (wet[i]) continue
            const run = between(edge(i), edge((i + 3) % 4))
            land.push([{ x: c[i][0], y: c[i][1] }, ...run])
            coast.push(...chain(run))
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
