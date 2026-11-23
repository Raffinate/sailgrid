import { describe, expect, it } from "vitest"
import type { Pt } from "../game/geom.ts"
import { defaultConfig, type GameMap, generateMap, heightAt, landHit, randomConfig } from "../game/map.ts"
import { mulberry32 } from "../game/rng.ts"
import { coastline } from "./coastline.ts"

function inPolygon(p: Pt, poly: Pt[]) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]
    const b = poly[j]
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

const drawnAsLand = (land: Pt[][], p: Pt) => land.some((poly) => inPolygon(p, poly))

/** Cells with land on two opposite corners and water on the other two. */
function saddles(m: GameMap): Pt[] {
  const out: Pt[] = []
  const W = m.width
  for (let y = 0; y < m.height - 1; y++)
    for (let x = 0; x < W - 1; x++) {
      const a = m.h[y * W + x] > 0
      const b = m.h[y * W + x + 1] > 0
      const c = m.h[(y + 1) * W + x + 1] > 0
      const d = m.h[(y + 1) * W + x] > 0
      if (a === c && b === d && a !== b) out.push({ x, y })
    }
  return out
}

describe("coastline", () => {
  it("draws a channel between two islands where boats can sail through it (seed 61707)", () => {
    const m = generateMap({ ...defaultConfig(61707), course: "islands", size: "medium", islands: "few", windSpeed: 6 })
    // Land on the top-right and bottom-left corners of this cell; the water corners are sailable diagonally.
    const x = 86
    const y = 22
    expect(m.h[y * m.width + x + 1]).toBeGreaterThan(0)
    expect(m.h[(y + 1) * m.width + x]).toBeGreaterThan(0)
    expect(landHit(m, { x, y }, { x: x + 1, y: y + 1 })).toBeNull()
    expect(drawnAsLand(coastline(m).land, { x: x + 0.5, y: y + 0.5 })).toBe(false)
  })

  it("draws land where the sailing surface is land, and water where it's water, in cells where islands nearly meet", () => {
    const rnd = mulberry32(5)
    let checked = 0
    for (let k = 0; k < 30; k++) {
      const m = generateMap({ ...randomConfig(rnd), islands: k % 2 ? "many" : "few" })
      const { land } = coastline(m)
      for (const s of saddles(m))
        // Points along both diagonals. The drawing straightens the coast a little, so skip points right at it.
        for (const t of [0.3, 0.4, 0.5, 0.6, 0.7])
          for (const p of [
            { x: s.x + t, y: s.y + t },
            { x: s.x + 1 - t, y: s.y + t },
          ]) {
            const h = heightAt(m, p.x, p.y)
            if (Math.abs(h) < 0.01) continue
            expect(drawnAsLand(land, p), `seed ${m.config.seed} at ${p.x},${p.y}`).toBe(h > 0)
            checked++
          }
    }
    expect(checked).toBeGreaterThan(50)
  })
})
