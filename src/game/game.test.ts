import { describe, expect, it } from "vitest"
import { chooseMove, route, timeToFinish } from "./ai.ts"
import { maneuver, moveAt, SAMPLE, simulate, tackOf } from "./boat.ts"
import { boatClass, FLEET, windBand } from "./fleet.ts"
import { angleDiff, bearing, closestApproach, dirVec, segmentCross } from "./geom.ts"
import { defaultConfig, describeConfig, type GameMap, generateMap, isWater, MAP_SIZES, type RaceConfig, randomConfig, startingPositions, TEST_SEED, type Weather } from "./map.ts"
import { mulberry32 } from "./rng.ts"
import { crossGates, crossGatesPath, type Entrant, newRace, type RaceState, resolveTurn, rightOfWay, standings } from "./race.ts"
import { BOAT_LENGTH_METERS, CELL_METERS, CELLS_PER_KNOT, TURN_SECONDS } from "./units.ts"
import { behindFront, behindLine, CARRY, eddiesAt, frontOf, frontRoughness, windAt, windField, windLinesAt, windLineWeight, windSampler, WIND_MAX, WIND_MIN } from "./wind.ts"

const first = boatClass("j-35")
const polar = first.polar

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

describe("fleet", () => {
  it("has four popular boats from real ORC certificates", () => {
    expect(FLEET.map((c) => c.id)).toEqual(["j-35", "j-109", "x-35", "melges-24"])
    for (const c of FLEET) expect(c.certificates).toBeGreaterThanOrEqual(30)
    expect(windBand(6)).toBe("low")
    expect(windBand(12)).toBe("medium")
    expect(windBand(18)).toBe("high")
  })

  it("gives each boat its own conditions, with no boat best everywhere", () => {
    const D = Math.PI / 180
    const vmgUp = (c: (typeof FLEET)[number], w: number) => Math.max(...Array.from({ length: 50 }, (_, i) => c.polar.speed(30 + i, w) * Math.cos((30 + i) * D)))
    const vmgDown = (c: (typeof FLEET)[number], w: number) =>
      Math.max(...Array.from({ length: 80 }, (_, i) => -c.polar.speed(100 + i, w) * Math.cos((100 + i) * D)))
    const best = (f: (c: (typeof FLEET)[number]) => number) => FLEET.reduce((a, b) => (f(b) > f(a) ? b : a)).id
    expect(best((c) => vmgUp(c, 12))).toBe("j-35")
    expect(best((c) => vmgDown(c, 7))).toBe("j-109")
    expect(best((c) => vmgDown(c, 18))).toBe("melges-24")
    // The X-35 leads nowhere, but is never far off in light and medium air.
    const x35 = boatClass("x-35")
    for (const w of [7, 12]) {
      const close = (f: (c: (typeof FLEET)[number]) => number) => f(x35) / Math.max(...FLEET.map(f))
      expect(close((c) => vmgUp(c, w))).toBeGreaterThan(0.95)
      expect(close((c) => vmgDown(c, w))).toBeGreaterThan(0.95)
      expect(close((c) => c.polar.speed(90, w))).toBeGreaterThan(0.95)
    }
  })

  it("has a no-go zone that narrows as the wind builds, and more speed on a reach", () => {
    expect(polar.speed(25, 12)).toBe(0)
    expect(polar.minTwa(6)).toBeGreaterThan(polar.minTwa(16))
    expect(polar.speed(90, 12)).toBeGreaterThan(polar.speed(45, 12))
    expect(polar.speed(-90, 12)).toBe(polar.speed(90, 12))
  })

  it("makes the Melges 24 plane downwind in a breeze", () => {
    const melges = boatClass("melges-24").polar
    expect(melges.speed(145, 20)).toBeGreaterThan(polar.speed(145, 20) * 1.25)
    expect(melges.speed(40, 20)).toBeLessThan(polar.speed(40, 20))
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
    const straight = simulate(pos, { heading: 315, speed: 6 }, { heading: 315 }, wind, first)
    const tack = simulate(pos, { heading: 315, speed: 6 }, { heading: 45 }, wind, first)
    expect(tack.speed).toBeLessThan(straight.speed)
    const fromRest = simulate(pos, { heading: 90, speed: 0 }, { heading: 90 }, wind, first)
    expect(fromRest.speed).toBeLessThan(fromRest.target)
    expect(fromRest.to.x).toBeGreaterThan(pos.x)
  })
})

describe("boat handling", () => {
  const wind = () => ({ from: 0, speed: 12 })
  const plan = (heading: number) => ({ heading })
  const sailTurns = (start: { heading: number; speed: number }, headings: number[], cls = first) => {
    let b = start
    let p = { x: 0, y: 0 }
    let last = null as ReturnType<typeof simulate> | null
    for (const h of headings) {
      last = simulate(p, b, plan(h), wind, cls)
      p = last.path[last.path.length - 2] // the exact end, before snapping to the grid
      b = { heading: last.heading, speed: last.speed }
    }
    return { p, b, last: last! }
  }
  const steady = sailTurns({ heading: 320, speed: 0 }, [320, 320, 320, 320, 320, 320]).b

  it("settles at the polar speed", () => {
    expect(steady.speed).toBeCloseTo(polar.speed(40, 12), 1)
  })

  it("loses two to four boat lengths in a tack", () => {
    const straight = sailTurns(steady, [320, 320, 320]).p
    const tacked = sailTurns(steady, [40, 40, 40]).p
    const lengths = ((-straight.y - -tacked.y) * CELL_METERS) / BOAT_LENGTH_METERS
    expect(lengths).toBeGreaterThan(2)
    expect(lengths).toBeLessThan(4)
  })

  it("loses less in a tack on a light, nimble boat", () => {
    const melges = boatClass("melges-24")
    const loss = (cls: typeof first) => {
      const s0 = sailTurns({ heading: 320, speed: 0 }, [320, 320, 320, 320, 320], cls).b
      return (-sailTurns(s0, [320, 320], cls).p.y - -sailTurns(s0, [40, 40], cls).p.y) / s0.speed
    }
    expect(loss(melges)).toBeLessThan(loss(first))
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
  it("when both tack, only the one to port keeps clear", () => {
    // Wind from north: facing it, the boat further west is on the other's port side.
    const tacking = (heading: number, x: number, y: number) => ({ ...close(heading, x, y), tacked: true })
    expect(rightOfWay(tacking(315, 0, 0), tacking(45, 1, 0), 0)).toEqual({ fault: ["a"], rule: "13" })
    expect(rightOfWay(tacking(45, 1, 0), tacking(315, 0, 0), 0)).toEqual({ fault: ["b"], rule: "13" })
  })
  it("when both tack, the one astern keeps clear", () => {
    // Wind from north: the boat further south is astern, even if it's also to starboard.
    const tacking = (heading: number, x: number, y: number) => ({ ...close(heading, x, y), tacked: true })
    expect(rightOfWay(tacking(315, 0, 0), tacking(45, 1, 2), 0)).toEqual({ fault: ["b"], rule: "13" })
  })
  it("knows how a boat was pointing, and whether it was tacking, at any moment of its move", () => {
    const wind = () => ({ from: 0, speed: 12 })
    const tack = simulate({ x: 50, y: 50 }, { heading: 315, speed: 6 }, { heading: 45 }, wind, first)
    const { from, to } = tack.tacking!
    // Tacking only from head to wind until close-hauled on the new tack, well inside the minute.
    expect(from).toBeGreaterThan(0)
    expect(to).toBeLessThan(TURN_SECONDS)
    const start = moveAt(tack, 0)
    expect(start.heading).toBeCloseTo(315)
    expect(start.tacked).toBe(false)
    expect(moveAt(tack, (from + to) / 2 / SAMPLE).tacked).toBe(true)
    const end = moveAt(tack, tack.path.length - 1)
    expect(end.heading).toBeCloseTo(45)
    expect(end.tacked).toBe(false)
    expect(end.pos).toEqual(tack.to)
  })
})

const configs: RaceConfig[] = [
  defaultConfig(1),
  { ...defaultConfig(2), islands: "many", course: "islands" },
  { ...defaultConfig(3), islands: "none", size: "small", laps: 1 },
  { ...defaultConfig(6), course: "triangle", laps: 2 },
  { ...defaultConfig(4), islands: "many", size: "large", laps: 3 },
]

describe("maps", () => {
  it.each(configs)("generates a sailable course (seed $seed)", (cfg) => {
    const m = generateMap(cfg)
    expect(m.width).toBe(MAP_SIZES[cfg.size].width)
    expect(m.gates[0].kind).toBe("start")
    expect(m.gates.at(-1)!.kind).toBe("finish")
    for (const s of startingPositions(m, 8)) expect(isWater(m, s.pos)).toBe(true)
    const r = route(m, 0, first)
    for (const s of startingPositions(m, 8)) expect(Number.isFinite(timeToFinish(r, m, 0, s.pos))).toBe(true)
  })

  it("rolls random races that can always be sailed", () => {
    const rnd = mulberry32(99)
    const kinds = new Set<string>()
    for (let i = 0; i < 24; i++) {
      const cfg = randomConfig(rnd)
      kinds.add(cfg.course)
      expect(cfg.windSpeed).toBeGreaterThanOrEqual(5)
      expect(cfg.windSpeed).toBeLessThanOrEqual(25)
      expect(describeConfig(cfg)).toContain(`${cfg.windSpeed} kn`)
      const m = generateMap(cfg)
      const r = route(m, 0, first)
      for (const s of startingPositions(m, 4)) expect(Number.isFinite(timeToFinish(r, m, 0, s.pos))).toBe(true)
    }
    expect(kinds.size).toBe(3)
  }, 60_000)

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

describe("eddies", () => {
  const m = generateMap({ ...defaultConfig(41), islands: "none", weather: "unsettled" })

  it("drift downwind with the air", () => {
    const now = eddiesAt(m, 20)
    const next = eddiesAt(m, 21)
    expect(now.length).toBeGreaterThan(0)
    const carry = CARRY * m.windSpeed * CELLS_PER_KNOT
    const down = dirVec(m.windFrom + 180)
    // The same eddy a turn later: same size and spin, one turn's drift further downwind.
    const moved = now.filter((e) =>
      next.some(
        (n) => n.radius === e.radius && n.spin === e.spin && Math.hypot(n.x - (e.x + down.x * carry), n.y - (e.y + down.y * carry)) < 1e-6,
      ),
    )
    expect(moved.length).toBeGreaterThan(0)
  })

  it("turn the wind round them, the way they spin", () => {
    let checked = 0
    for (const turn of [20, 30, 40, 50]) {
      const field = windField(m, turn)
      const e = eddiesAt(m, turn)
        .filter((e) => e.strength > 2 && e.x > 12 && e.y > 12 && e.x < m.width - 12 && e.y < m.height - 12)
        .sort((a, b) => b.strength - a.strength)[0]
      if (!e) continue
      // Circulation: the wind's flow summed round a circle at the eddy's radius.
      const n = 48
      let circ = 0
      for (let k = 0; k < n; k++) {
        const th = (2 * Math.PI * k) / n
        const p = { x: e.x + e.radius * Math.cos(th), y: e.y + e.radius * Math.sin(th) }
        const w = windAt(field, p)
        const flow = dirVec(w.from + 180)
        circ += (flow.x * -Math.sin(th) + flow.y * Math.cos(th)) * w.speed * ((2 * Math.PI * e.radius) / n)
      }
      const expected = 2 * Math.PI * e.radius * e.strength
      expect(Math.sign(circ)).toBe(e.spin)
      expect(Math.abs(circ)).toBeGreaterThan(expected * 0.5)
      checked++
    }
    expect(checked).toBeGreaterThan(1)
  })
})

describe("front", () => {
  const settled = generateMap({ ...defaultConfig(52), islands: "none", weather: "settled" })
  const m = generateMap({ ...settled.config, front: true })
  const f = frontOf(m)!
  const mean = (turn: number, g: (a: number, b: number) => number, pick: "from" | "speed") => {
    const a = windField(m, turn)[pick]
    const b = windField(settled, turn)[pick]
    let sum = 0
    for (let i = 0; i < a.length; i++) sum += g(a[i], b[i])
    return sum / a.length
  }

  it("arrives partway through the race, not already on the course at the start", () => {
    expect(frontOf(settled)).toBeNull()
    expect(f.shift).toBeGreaterThanOrEqual(35)
    expect(f.shift).toBeLessThanOrEqual(70)
    const corners = [
      { x: 0, y: 0 },
      { x: m.width - 1, y: 0 },
      { x: 0, y: m.height - 1 },
      { x: m.width - 1, y: m.height - 1 },
    ]
    for (const p of corners) expect(behindFront(m, f, 0, p)).toBeLessThan(0)
    expect(behindFront(m, f, f.arrival, { x: (m.width - 1) / 2, y: (m.height - 1) / 2 })).toBeCloseTo(0)
  })

  it("comes on any day but a settled one, more often the worse the weather", () => {
    const share = (weather: Weather) => {
      let fronts = 0
      for (let seed = 0; seed < 400; seed++) if (frontOf(generateMap({ ...defaultConfig(seed), size: "small", islands: "none", weather }))) fronts++
      return fronts / 400
    }
    expect(share("settled")).toBe(0)
    expect(share("changeable")).toBeGreaterThan(0.01)
    expect(share("changeable")).toBeLessThan(0.1)
    expect(share("unsettled")).toBeGreaterThan(0.13)
    expect(share("unsettled")).toBeLessThan(0.27)
    expect(share("stormy")).toBeGreaterThan(0.37)
    expect(share("stormy")).toBeLessThan(0.53)
  }, 60_000)

  it("leaves the wind as it was ahead of it, and veered and stronger behind it", () => {
    const early = 1
    expect(Math.abs(mean(early, angleDiff, "from"))).toBeLessThan(3)
    expect(mean(early, (a, b) => a / b, "speed")).toBeCloseTo(1, 1)
    const late = Math.ceil(f.arrival + (m.width + m.height) / f.speed) + 2
    expect(mean(late, angleDiff, "from")).toBeGreaterThan(f.shift - 8)
    expect(mean(late, angleDiff, "from")).toBeLessThan(f.shift + 8)
    expect(mean(late, (a, b) => a / b, "speed")).toBeGreaterThan(f.gain - 0.15)
    expect(windField(m, late).baseFrom).toBeCloseTo(((windField(settled, late).baseFrom + f.shift) % 360), -1)
  })
})

describe("wind lines", () => {
  const distinct = (m: GameMap, turns: number) => {
    const seen = new Set<number>()
    for (let t = 0; t < turns; t += 5) for (const l of windLinesAt(m, t)) seen.add(l.center)
    return seen.size
  }

  it("come through every so often, more in worse weather", () => {
    const shifty = generateMap({ ...defaultConfig(61), islands: "none", weather: "unsettled" })
    const steady = generateMap({ ...shifty.config, weather: "settled" })
    // About one every 10 turns when unsettled, every 24 when settled.
    expect(distinct(shifty, 400)).toBeGreaterThan(25)
    expect(distinct(shifty, 400)).toBeLessThan(60)
    expect(distinct(steady, 400)).toBeLessThan(distinct(shifty, 400))
    for (const l of windLinesAt(shifty, 50)) {
      expect(Math.abs(l.shift)).toBeGreaterThanOrEqual(10)
      expect(Math.abs(l.shift)).toBeLessThanOrEqual(25)
      expect(l.depth / l.speed).toBeGreaterThanOrEqual(3)
    }
  })

  it("shift the wind inside the band for several turns, then let it go back", () => {
    let checked = 0
    for (const seed of [61, 62, 63, 64, 65, 66]) {
      const m = generateMap({ ...defaultConfig(seed), islands: "none", weather: "changeable" })
      // A patch in the middle of the map, so puffs and eddies average out.
      const patch: { x: number; y: number }[] = []
      const cx = Math.round((m.width - 1) / 2)
      const cy = Math.round((m.height - 1) / 2)
      for (let y = cy - 10; y <= cy + 10; y += 2) for (let x = cx - 10; x <= cx + 10; x += 2) patch.push({ x, y })
      const seen = new Set<number>()
      for (let t = 20; t < 200; t++)
        for (const l of windLinesAt(m, t)) {
          if (seen.has(l.center)) continue
          seen.add(l.center)
          // Turns when the whole patch is well inside this line, or clear of it, with no other line about.
          const inside: number[] = []
          const outside: number[] = []
          for (let u = Math.floor(l.center - 15); u < l.center + l.depth / l.speed + 15; u++) {
            const others = windLinesAt(m, u).filter((o) => o !== l)
            if (patch.some((p) => others.some((o) => windLineWeight(o, behindLine(m, o, u, p)) > 0.05))) continue
            const k = patch.map((p) => windLineWeight(l, behindLine(m, l, u, p)))
            // Just the patch, not the whole map: this looks at a few hundred turns.
            const w = windSampler(m, u)
            const dev = patch.reduce((sum, p) => sum + angleDiff(w.at(p.x, p.y).from, w.baseFrom), 0) / patch.length
            if (k.every((x) => x > 0.9)) inside.push(dev)
            else if (k.every((x) => x < 0.05)) outside.push(dev)
          }
          if (inside.length < 2 || outside.length < 2) continue
          const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
          expect(mean(inside) - mean(outside), `seed ${seed}, line at ${l.center.toFixed(1)}`).toBeGreaterThan(l.shift - 7)
          expect(mean(inside) - mean(outside), `seed ${seed}, line at ${l.center.toFixed(1)}`).toBeLessThan(l.shift + 7)
          checked++
        }
    }
    expect(checked).toBeGreaterThan(3)
  })
})

describe("behind a front", () => {
  const sd = (xs: number[]) => {
    const mu = xs.reduce((a, b) => a + b, 0) / xs.length
    return Math.sqrt(xs.reduce((a, b) => a + (b - mu) ** 2, 0) / xs.length)
  }
  const corr = (a: number[], b: number[]) => {
    const ma = a.reduce((s, x) => s + x, 0) / a.length
    const mb = b.reduce((s, x) => s + x, 0) / b.length
    let sab = 0
    let saa = 0
    let sbb = 0
    for (let k = 0; k < a.length; k++) {
      sab += (a[k] - ma) * (b[k] - mb)
      saa += (a[k] - ma) ** 2
      sbb += (b[k] - mb) ** 2
    }
    return sab / Math.sqrt(saa * sbb)
  }
  const pct = (xs: number[], q: number) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * q)]

  it.each([52, 7, 19])("is rough for several turns, then settles (seed %i)", (seed) => {
    const settled = generateMap({ ...defaultConfig(seed), islands: "none", weather: "settled" })
    const m = generateMap({ ...settled.config, front: true })
    const f = frontOf(m)!
    // Several turns of it for a boat that stays put.
    expect(f.depth / f.speed).toBeGreaterThan(2.5)
    // How the wind differs from settled weather, beyond the front's own shift and strengthening.
    const dev = (turn: number, i: number) => angleDiff(windField(m, turn).from[i], windField(settled, turn).from[i]) - f.shift
    const gust = (turn: number, i: number) => windField(m, turn).speed[i] / windField(settled, turn).speed[i] / f.gain
    const T = Math.round(f.arrival + 2)
    const now: number[] = []
    const next: number[] = []
    const gusts: number[] = []
    for (let y = 0; y < m.height; y++)
      for (let x = 0; x < m.width; x++) {
        if (frontRoughness(f, behindFront(m, f, T, { x, y })) < 0.5) continue
        if (frontRoughness(f, behindFront(m, f, T + 1, { x, y })) < 0.5) continue
        const i = y * m.width + x
        now.push(dev(T, i))
        next.push(dev(T + 1, i))
        gusts.push(gust(T, i))
      }
    expect(now.length).toBeGreaterThan(500)
    const later = Math.ceil(f.arrival + (3 * f.depth + m.width + m.height) / f.speed)
    const calm = Array.from({ length: m.width * m.height }, (_, i) => dev(later, i))
    // The direction jumps about: far more than once the air has settled.
    expect(sd(now)).toBeGreaterThan(15)
    expect(sd(now)).toBeGreaterThan(4 * sd(calm))
    // A new pattern each turn, not the same one drifting by.
    expect(corr(now, next)).toBeLessThan(0.5)
    // Gusts and lulls, within reason.
    expect(pct(gusts, 0.05)).toBeLessThan(0.8)
    expect(pct(gusts, 0.95)).toBeGreaterThan(1.3)
    expect(pct(gusts, 0.95)).toBeLessThan(2)
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

  it("starts a boat that slipped round the end of the line once it dips back and crosses", () => {
    const [a, b] = m.startLine
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    const up = dirVec(m.windFrom)
    const at = (u: number) => ({ x: mid.x + up.x * u, y: mid.y + up.y * u })
    // From the course side back to the pre-start side: nothing gained, nothing owed.
    expect(crossGates(m, 0, 0, at(3), at(-3))).toMatchObject({ next: 0, unwind: 0 })
    expect(crossGatesPath(m, 0, 0, [at(3), at(-3), at(3)]).next).toBe(1)
  })

  it("takes the rounding back when a boat crosses the ray and turns back", () => {
    const mark = m.gates[1].mark!
    const up = dirVec(m.windFrom)
    const right = dirVec(m.windFrom + 90)
    const at = (u: number, r: number) => ({ x: mark.x + up.x * u + right.x * r, y: mark.y + up.y * u + right.y * r })
    expect(crossGates(m, 1, 0, at(6, 3), at(6, -3)).next).toBe(2)
    expect(crossGates(m, 2, 0, at(6, -3), at(6, 3))).toMatchObject({ next: 1, unwind: 0 })
    // Across and back within one move: still before the mark.
    expect(crossGatesPath(m, 1, 0, [at(6, 3), at(6, -3), at(5, 3)]).next).toBe(1)
  })
})

function runRace(cfg: RaceConfig, entrants: Entrant[]): { state: RaceState; map: GameMap } {
  const map = generateMap(cfg)
  let state = newRace(map, entrants, 250, mulberry32(cfg.seed))
  while (!state.over) {
    const plans = new Map(state.boats.map((b) => [b.id, chooseMove(map, state, b.id)]))
    state = resolveTurn(map, state, plans)
  }
  return { state, map }
}

describe("AI race", () => {
  it("finishes a windward-leeward race", () => {
    const { state, map } = runRace({ ...defaultConfig(11), laps: 1 }, [
      { name: "Hard", color: "#000", controller: "ai", difficulty: "hard", boat: "j-35" },
      { name: "Medium", color: "#111", controller: "ai", difficulty: "medium", boat: "j-109" },
      { name: "Easy", color: "#222", controller: "ai", difficulty: "easy", boat: "x-35" },
    ])
    for (const b of state.boats) expect(b.finish, `${b.name} after ${state.turn} turns, next ${b.next}/${map.gates.length}`).not.toBeNull()
    expect(state.turn).toBeLessThan(150)
    expect(standings(state)[0].finish).not.toBeNull()
  }, 60_000)

  it("finishes a race when a front comes through", () => {
    const cfg: RaceConfig = { ...defaultConfig(13), laps: 1, front: true }
    const { state, map } = runRace(cfg, [
      { name: "Hard", color: "#000", controller: "ai", difficulty: "hard", boat: "j-109" },
      { name: "Easy", color: "#222", controller: "ai", difficulty: "easy", boat: "x-35" },
    ])
    const f = frontOf(map)!
    // The front came through while they were racing.
    expect(f.arrival).toBeLessThan(Math.min(...state.boats.map((b) => b.finish ?? Infinity)))
    for (const b of state.boats) expect(b.finish, `${b.name} after ${state.turn} turns`).not.toBeNull()
  }, 60_000)

  it("goes all the way round a mark rather than touching its ray and turning back", () => {
    // A race where the boats used to cross Mark 1's ray south-east of it and head back north to Mark 2.
    const cfg: RaceConfig = { seed: 682227, course: "triangle", laps: 1, size: "medium", islands: "many", weather: "stormy", windSpeed: 16 }
    const { state } = runRace(cfg, [
      { name: "Hard", color: "#000", controller: "ai", difficulty: "hard", boat: "j-109" },
      { name: "Easy", color: "#222", controller: "ai", difficulty: "easy", boat: "x-35" },
    ])
    for (const b of state.boats) expect(b.finish, `${b.name} after ${state.turn} turns`).not.toBeNull()
  }, 60_000)

  it("finishes a race around the islands", () => {
    const { state } = runRace({ ...defaultConfig(12), course: "islands", islands: "many" }, [
      { name: "Hard", color: "#000", controller: "ai", difficulty: "hard", boat: "melges-24" },
      { name: "Medium", color: "#111", controller: "ai", difficulty: "medium", boat: "j-35" },
    ])
    for (const b of state.boats) expect(b.finish).not.toBeNull()
  }, 60_000)
})

describe("test map", () => {
  it("is open water with an east wind, lightest in the north and strongest in the south", () => {
    for (const course of ["windward-leeward", "triangle", "islands"] as const) {
      const m = generateMap({ ...defaultConfig(TEST_SEED), course, islands: "many", weather: "stormy" })
      expect(m.h.every((v) => v <= 0)).toBe(true)
      for (const turn of [0, 13, 40]) {
        const f = windField(m, turn)
        expect(f.from.every((d) => d === 90)).toBe(true)
        for (let x = 0; x < m.width; x += 17) {
          expect(f.speed[x]).toBeCloseTo(WIND_MIN)
          expect(f.speed[(m.height - 1) * m.width + x]).toBeCloseTo(WIND_MAX)
          for (let y = 1; y < m.height; y++) expect(f.speed[y * m.width + x]).toBeGreaterThan(f.speed[(y - 1) * m.width + x])
        }
      }
    }
  })
})
