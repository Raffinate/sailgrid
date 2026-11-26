import { describe, expect, it } from "vitest"
import { defaultConfig, generateMap, WIND_GRADIENT_MAP } from "../game/map.ts"
import { WIND_MAX, WIND_MIN, windField } from "../game/wind.ts"
import { isotachLevels, isotachs } from "./isotachs.ts"

describe("isotachs", () => {
  it("runs straight across the wind gradient dev map, where the wind rises evenly from north to south", () => {
    const m = generateMap(defaultConfig(WIND_GRADIENT_MAP))
    const f = windField(m, 0)
    for (const { level, segments } of isotachs(m, f.speed, [5, 10, 15, 20, 25, 30, 35])) {
      // Where the speed is `level`: WIND_MIN on row 0 rising to WIND_MAX on the last row.
      const row = ((level - WIND_MIN) * (m.height - 1)) / (WIND_MAX - WIND_MIN)
      expect(segments.length, `${level} kn`).toBe(m.width - 1)
      for (const [a, b] of segments) {
        expect(a.y).toBeCloseTo(row, 4)
        expect(b.y).toBeCloseTo(row, 4)
        expect(Math.abs(b.x - a.x)).toBeCloseTo(1, 6)
      }
    }
  })

  it("leaves out squares that touch land", () => {
    const m = generateMap({ ...defaultConfig(12), islands: "many" })
    const f = windField(m, 0)
    for (const { segments } of isotachs(m, f.speed, [8, 10, 12, 14, 16]))
      for (const [a, b] of segments) {
        const x = Math.floor(Math.min(a.x, b.x))
        const y = Math.floor(Math.min(a.y, b.y))
        for (const [dx, dy] of [
          [0, 0],
          [1, 0],
          [0, 1],
          [1, 1],
        ])
          expect(m.h[(y + dy) * m.width + x + dx]).toBeLessThanOrEqual(0)
      }
  })

  it("goes through the 20th, 50th and 80th percentile of the wind, in whole knots", () => {
    const m = generateMap(defaultConfig(WIND_GRADIENT_MAP))
    const f = windField(m, 0)
    // On the wind gradient dev map the wind rises evenly down the rows, so the percentiles are a fifth, half and four
    // fifths of the way from WIND_MIN to WIND_MAX.
    const at = (q: number) => Math.round(WIND_MIN + (WIND_MAX - WIND_MIN) * q)
    expect(isotachLevels(m, f.speed)).toEqual([at(0.2), at(0.5), at(0.8)])
    // Levels that round to the same knot are drawn once.
    expect(isotachLevels(m, new Float32Array(m.width * m.height).fill(12))).toEqual([12])
  })
})
