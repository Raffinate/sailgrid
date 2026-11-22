import { describe, expect, it } from "vitest"
import { chooseMove, route, timeToFinish } from "./ai.ts"
import { idealSail, maneuver, simulate, tackOf, trimEfficiency } from "./boat.ts"
import { angleDiff, bearing, closestApproach, dirVec, segmentCross } from "./geom.ts"
import { defaultConfig, type GameMap, generateMap, isWater, MAP_SIZES, type RaceConfig, startingPositions } from "./map.ts"
import { defaultPolar } from "./polar.ts"
import { crossGates, type Entrant, newRace, type RaceState, resolveTurn, rightOfWay, standings } from "./race.ts"
import { BOAT_LENGTH_METERS, CELL_METERS, CELLS_PER_KNOT } from "./units.ts"
import { CARRY, windAt, windField } from "./wind.ts"

const polar = defaultPolar

describe("geometry", () => {
  it("uses compass bearings with y pointing south", () => {
    expect(bearing({ x: 0, y: 0 }, { x: 0, y: -5 })).toBeCloseTo(0)
    expect(bearing({ x: 0, y: 0 }, { x: 5, y: 0 })).toBeCloseTo(90)
    expect(dirVec(180).y).toBeCloseTo(1)
    expect(angleDiff(10, 350)).toBe(20)
  })

  it("finds segment crossings and closest approach", () => {
    expect(segmentCross({ x: 0, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }, { x: 2, y: 0 })?.t).toBeCloseTo(0.5)
    expect(segmentCross({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 })).toBeNull()
    // Two boats swapping places head-on meet in the middle.
    expect(closestApproach({ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 0 }, { x: 0, y: 0 }).d).toBeCloseTo(0)
  })
})

describe("polar and sail", () => {
  it("has no speed in the no-go zone and more on a reach", () => {
    expect(polar.speed(20, 12)).toBe(0)
    expect(polar.speed(90, 12)).toBeGreaterThan(polar.speed(45, 12))
    expect(polar.speed(-90, 12)).toBe(polar.speed(90, 12))
  })

  it("trims best at the ideal sheet setting", () => {
    expect(trimEfficiency(idealSail(90), idealSail(90))).toBe(1)
    expect(trimEfficiency(idealSail(45) + 20, idealSail(45))).toBeLessThan(0.3)
    expect(trimEfficiency(idealSail(150) - 20, idealSail(150))).toBeGreaterThan(0.6)
  })

  it("recognises tacks and gybes", () => {
    // Wind from north: starboard tack close-hauled is heading 315, port tack 45.
    expect(tackOf(315, 0)).toBe("starboard")
    expect(maneuver(315, 45, 0)).toMatchObject({ tacked: true, gybed: false })
    expect(maneuver(135, 225, 0)).toMatchObject({ tacked: false, gybed: true })
    expect(maneuver(45, 90, 0)).toMatchObject({ tacked: false, gybed: false })
  })

  it("carries momentum and loses speed tacking", () => {
    const wind = () => ({ from: 0, speed: 12 })
    const pos = { x: 50, y: 50 }
    const straight = simulate(pos, { heading: 315, speed: 6 }, { heading: 315, sail: idealSail(45) }, wind, polar)
    const tack = simulate(pos, { heading: 315, speed: 6 }, { heading: 45, sail: idealSail(45) }, wind, polar)
    expect(tack.speed).toBeLessThan(straight.speed)
    const fromRest = simulate(pos, { heading: 90, speed: 0 }, { heading: 90, sail: idealSail(90) }, wind, polar)
    expect(fromRest.speed).toBeLessThan(fromRest.target)
    expect(fromRest.to.x).toBeGreaterThan(pos.x)
  })
})

describe("boat handling", () => {
  const wind = () => ({ from: 0, speed: 12 })
  const plan = (heading: number) => ({ heading, sail: idealSail(angleDiff(0, heading)) })
  const sailTurns = (start: { heading: number; speed: number }, headings: number[]) => {
    let b = start
    let p = { x: 0, y: 0 }
    let last = null as ReturnType<typeof simulate> | null
    for (const h of headings) {
      last = simulate(p, b, plan(h), wind, polar)
      p = last.path[last.path.length - 2] // the exact end, before snapping to the grid
      b = { heading: last.heading, speed: last.speed }
    }
    return { p, b, last: last! }
  }
  const steady = sailTurns({ heading: 318, speed: 0 }, [318, 318, 318, 318, 318, 318]).b

  it("settles at the polar speed", () => {
    expect(steady.speed).toBeCloseTo(polar.speed(42, 12), 1)
  })

  it("loses two to four boat lengths in a tack", () => {
    const straight = sailTurns(steady, [318, 318, 318]).p
    const tacked = sailTurns(steady, [42, 42, 42]).p
    const lengths = ((-straight.y - -tacked.y) * CELL_METERS) / BOAT_LENGTH_METERS
    expect(lengths).toBeGreaterThan(2)
    expect(lengths).toBeLessThan(4)
  })

  it("bears away without losing speed, and slows gradually heading up", () => {
    expect(sailTurns(steady, [270]).b.speed).toBeGreaterThan(steady.speed)
    const up = sailTurns({ heading: 270, speed: 8.2 }, [318]).last
    expect(up.carried).toBeGreaterThan(6.5)
  })

  it("follows an arc, and turns slowly when it's barely moving", () => {
    const fast = sailTurns({ heading: 90, speed: 8 }, [270]).last
    const slow = sailTurns({ heading: 90, speed: 0 }, [270]).last
    expect(slow.turnSeconds).toBeGreaterThan(fast.turnSeconds)
    // The path bends: its middle isn't on the straight line from start to end.
    const mid = fast.path[3]
    expect(Math.abs(mid.y)).toBeGreaterThan(0.3)
  })

  it("stops in irons", () => {
    expect(sailTurns(steady, [0]).b.speed).toBeLessThan(0.5)
  })
})

describe("rules", () => {
  const close = (heading: number, x: number, y: number) => ({ pos: { x, y }, heading, tacked: false })
  it("port keeps clear of starboard", () => {
    expect(rightOfWay(close(45, 0, 0), close(315, 1, 0), 0)).toEqual({ fault: ["a"], rule: "10" })
  })
  it("windward keeps clear when overlapped on the same tack", () => {
    // Both on starboard (heading west, wind from north): the boat further north is windward.
    expect(rightOfWay(close(270, 0, -1), close(270, 0, 0), 0)).toEqual({ fault: ["a"], rule: "11" })
  })
  it("clear astern keeps clear", () => {
    expect(rightOfWay(close(270, 3, 0), close(270, 0, 0), 0)).toEqual({ fault: ["a"], rule: "12" })
  })
  it("a tacking boat keeps clear", () => {
    expect(rightOfWay({ ...close(45, 0, 0), tacked: true }, close(45, 1, 0), 0).rule).toBe("13")
  })
})

const configs: RaceConfig[] = [
  defaultConfig(1),
  { ...defaultConfig(2), islands: "many", course: "islands" },
  { ...defaultConfig(3), islands: "none", size: "small", laps: 1 },
  { ...defaultConfig(4), islands: "many", size: "large", laps: 3 },
]

describe("maps", () => {
  it.each(configs)("generates a sailable course (seed $seed)", (cfg) => {
    const m = generateMap(cfg)
    expect(m.width).toBe(MAP_SIZES[cfg.size].width)
    expect(m.gates[0].kind).toBe("start")
    expect(m.gates.at(-1)!.kind).toBe("finish")
    for (const s of startingPositions(m, 8)) expect(isWater(m, s.pos)).toBe(true)
    const r = route(m, 0, polar)
    for (const s of startingPositions(m, 8)) expect(Number.isFinite(timeToFinish(r, m, 0, s.pos))).toBe(true)
  })

  it("is deterministic per seed", () => {
    const a = generateMap(configs[1])
    const b = generateMap(configs[1])
    expect(a.windFrom).toBe(b.windFrom)
    expect(Array.from(a.h.slice(0, 500))).toEqual(Array.from(b.h.slice(0, 500)))
    expect(windField(a, 7).speed[123]).toBe(windField(b, 7).speed[123])
  })

  it("carries puffs downwind at most of the wind speed, and puffs veer", () => {
    const m = generateMap({ ...defaultConfig(31), islands: "none" })
    const a = windField(m, 10)
    const b = windField(m, 11)
    const down = dirVec(m.windFrom + 180)
    const avg = (f: Float32Array) => f.reduce((s, x) => s + x, 0) / f.length
    const corr = (k: number) => {
      const [ma, mb] = [avg(a.speed), avg(b.speed)]
      let sxy = 0
      let sxx = 0
      let syy = 0
      for (let y = 0; y < m.height; y++)
        for (let x = 0; x < m.width; x++) {
          const X = Math.round(x + down.x * k)
          const Y = Math.round(y + down.y * k)
          if (X < 0 || Y < 0 || X >= m.width || Y >= m.height) continue
          const u = a.speed[y * m.width + x] - ma
          const v = b.speed[Y * m.width + X] - mb
          sxy += u * v
          sxx += u * u
          syy += v * v
        }
      return sxy / Math.sqrt(sxx * syy)
    }
    const expected = Math.round(CARRY * m.windSpeed * CELLS_PER_KNOT)
    expect(corr(expected)).toBeGreaterThan(0.9)
    expect(corr(expected)).toBeGreaterThan(corr(0) + 0.15)
    let sxy = 0
    const ms = avg(a.speed)
    for (let i = 0; i < a.speed.length; i++) sxy += (a.speed[i] - ms) * angleDiff(a.from[i], a.baseFrom)
    expect(sxy).toBeGreaterThan(0)
  })

  it("moves the wind around between turns", () => {
    const m = generateMap(configs[0])
    const p = { x: 20, y: 20 }
    expect(windAt(windField(m, 0), p)).not.toEqual(windAt(windField(m, 5), p))
  })
})

describe("course progress", () => {
  const m: GameMap = generateMap({ ...defaultConfig(5), islands: "none", laps: 1 })
  it("counts a windward mark only when rounded to port", () => {
    const g = m.gates[1]
    const mark = g.mark!
    const up = dirVec(m.windFrom)
    const right = dirVec(m.windFrom + 90)
    const at = (u: number, r: number) => ({ x: mark.x + up.x * u + right.x * r, y: mark.y + up.y * u + right.y * r })
    // Facing upwind, leaving the mark to port means passing it on our right and then crossing to the left.
    expect(crossGates(m, 1, 0, at(2, 3), at(2, -3)).next).toBe(2)
    expect(crossGates(m, 1, 0, at(2, -3), at(2, 3))).toMatchObject({ next: 1, unwind: 1 })
  })
})

function runRace(cfg: RaceConfig, entrants: Entrant[]): { state: RaceState; map: GameMap } {
  const map = generateMap(cfg)
  let state = newRace(map, entrants, 250)
  while (!state.over) {
    const plans = new Map(state.boats.map((b) => [b.id, chooseMove(map, state, b.id, polar)]))
    state = resolveTurn(map, state, plans, polar)
  }
  return { state, map }
}

describe("AI race", () => {
  it("finishes a windward-leeward race", () => {
    const { state, map } = runRace({ ...defaultConfig(11), laps: 1 }, [
      { name: "Hard", color: "#000", controller: "ai", difficulty: "hard" },
      { name: "Medium", color: "#111", controller: "ai", difficulty: "medium" },
      { name: "Easy", color: "#222", controller: "ai", difficulty: "easy" },
    ])
    for (const b of state.boats) expect(b.finish, `${b.name} after ${state.turn} turns, next ${b.next}/${map.gates.length}`).not.toBeNull()
    expect(state.turn).toBeLessThan(150)
    expect(standings(state)[0].finish).not.toBeNull()
  }, 60_000)

  it("finishes a race around the islands", () => {
    const { state } = runRace({ ...defaultConfig(12), course: "islands", islands: "many" }, [
      { name: "Hard", color: "#000", controller: "ai", difficulty: "hard" },
      { name: "Medium", color: "#111", controller: "ai", difficulty: "medium" },
    ])
    for (const b of state.boats) expect(b.finish).not.toBeNull()
  }, 60_000)
})
