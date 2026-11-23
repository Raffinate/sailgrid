import { add, bearing, clamp, cross, dirVec, dist, len, norm360, type Pt, roundPt, scale, sub } from "./geom.ts"
import { fbm, hash, mulberry32 } from "./rng.ts"

export type MapSize = "small" | "medium" | "large"
export type IslandDensity = "none" | "few" | "many"
export type CourseKind = "windward-leeward" | "triangle" | "islands"
export type Shiftiness = "steady" | "shifty"
/** Chances of a front sweeping across the course partway through the race, percent: the forecast. */
export const FRONT_CHANCES = [0, 25, 50, 75, 100] as const
export type FrontChance = (typeof FRONT_CHANCES)[number]

export interface RaceConfig {
  seed: number
  size: MapSize
  islands: IslandDensity
  course: CourseKind
  /** Laps of a windward-leeward or triangle course. */
  laps: number
  /** Mean true wind speed, knots. */
  windSpeed: number
  shifts: Shiftiness
  /** Whether a front actually comes is rolled from the seed, so every player gets the same weather. */
  frontChance: FrontChance
}

export const defaultConfig = (seed: number): RaceConfig => ({
  seed,
  size: "medium",
  islands: "few",
  course: "windward-leeward",
  laps: 2,
  windSpeed: 12,
  shifts: "shifty",
  frontChance: 0,
})

/** Pick from weighted options. */
function weighted<T>(options: [T, number][], r: number): T {
  let total = 0
  for (const [, w] of options) total += w
  let x = r * total
  for (const [v, w] of options) {
    if ((x -= w) < 0) return v
  }
  return options[options.length - 1][0]
}

/** A random race: course, laps, map, islands, wind strength and shiftiness all rolled at once. */
export function randomConfig(rnd: () => number = Math.random): RaceConfig {
  const course = weighted<CourseKind>(
    [
      ["windward-leeward", 1],
      ["triangle", 1],
      ["islands", 1],
    ],
    rnd(),
  )
  return {
    seed: Math.floor(rnd() * 1_000_000),
    course,
    laps: weighted(
      [
        [1, 5],
        [2, 4],
        [3, 1],
      ],
      rnd(),
    ),
    size: weighted<MapSize>(
      [
        ["small", 3],
        ["medium", 5],
        ["large", 2],
      ],
      rnd(),
    ),
    islands: weighted<IslandDensity>(
      [
        ["none", 2],
        ["few", 5],
        ["many", 3],
      ],
      rnd(),
    ),
    windSpeed: 5 + Math.floor(rnd() * 18),
    shifts: rnd() < 0.4 ? "steady" : "shifty",
    frontChance: weighted<FrontChance>(
      [
        [0, 4],
        [25, 3],
        [50, 2],
        [75, 1],
        [100, 1],
      ],
      rnd(),
    ),
  }
}

const COURSE_LABEL: Record<CourseKind, string> = {
  "windward-leeward": "Windward–leeward",
  triangle: "Triangle",
  islands: "Round the islands",
}

const frontForecast = (chance: FrontChance) =>
  chance === 0 ? "" : chance === 100 ? ", a front coming" : `, ${chance}% chance of a front`

/** One line on what a race will be like: "Triangle · 2 laps · 16 kn, shifty · few islands · medium map". */
export function describeConfig(c: RaceConfig): string {
  return [
    COURSE_LABEL[c.course] + (c.course === "islands" ? "" : ` · ${c.laps} ${c.laps === 1 ? "lap" : "laps"}`),
    `${c.windSpeed} kn, ${c.shifts}` + frontForecast(c.frontChance),
    c.islands === "none" ? "open water" : `${c.islands} islands`,
    `${c.size} map`,
  ].join(" · ")
}

export const MAP_SIZES: Record<MapSize, { width: number; height: number }> = {
  small: { width: 80, height: 56 },
  medium: { width: 110, height: 76 },
  large: { width: 140, height: 96 },
}

export type Side = "port" | "starboard"

/**
 * Something every boat has to cross, in order. A start or finish line is the segment between its ends.
 * A mark is rounded by crossing the ray from the mark outward, away from the course: going the right
 * way around (`side`) crosses it in the required direction.
 */
export interface Gate {
  kind: "start" | "mark" | "finish"
  a: Pt
  b: Pt
  /** Required sign of cross(b − a, move); 0 accepts either direction. */
  sign: -1 | 0 | 1
  label: string
  mark?: Pt
  side?: Side
}

export interface GameMap {
  config: RaceConfig
  width: number
  height: number
  /** Land height at each intersection (index y * width + x); above 0 is land. */
  h: Float32Array
  /** Distance (cells) from each intersection to the nearest land, capped. */
  coast: Float32Array
  /** Wind direction (from) and mean speed before any shifts. */
  windFrom: number
  windSpeed: number
  gates: Gate[]
  /** Distinct mark positions (cell centers), for drawing and touch checks. */
  marks: Pt[]
  startLine: [Pt, Pt]
  finishLine: [Pt, Pt]
}

export const idx = (m: GameMap, x: number, y: number) => y * m.width + x

export const inBounds = (m: GameMap, x: number, y: number) => x >= 0 && y >= 0 && x <= m.width - 1 && y <= m.height - 1

/** Land height anywhere on the map, bilinear between intersections; off the map counts as land. */
export function heightAt(m: GameMap, x: number, y: number): number {
  if (!inBounds(m, x, y)) return 1
  const x0 = Math.min(m.width - 2, Math.floor(x))
  const y0 = Math.min(m.height - 2, Math.floor(y))
  const fx = x - x0
  const fy = y - y0
  const h = m.h
  const i = y0 * m.width + x0
  const a = h[i]
  const b = h[i + 1]
  const c = h[i + m.width]
  const d = h[i + m.width + 1]
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy
}

export const isWater = (m: GameMap, p: Pt) =>
  Number.isInteger(p.x) && Number.isInteger(p.y) && inBounds(m, p.x, p.y) && m.h[idx(m, p.x, p.y)] <= 0

const STEP = 0.2

/** Fraction along a→b where the path first touches land (or leaves the map), or null if it stays in water. */
export function landHit(m: GameMap, a: Pt, b: Pt): number | null {
  const n = Math.max(1, Math.ceil(dist(a, b) / STEP))
  for (let i = 1; i <= n; i++) {
    const t = i / n
    if (heightAt(m, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t) > 0) return t
  }
  return null
}

/** Chamfer distance transform to the nearest land intersection. */
function coastDistance(width: number, height: number, h: Float32Array): Float32Array {
  const INF = 1e6
  const d = new Float32Array(width * height)
  for (let i = 0; i < d.length; i++) d[i] = h[i] > 0 ? 0 : INF
  const D = Math.SQRT2
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      if (x > 0) d[i] = Math.min(d[i], d[i - 1] + 1)
      if (y > 0) {
        d[i] = Math.min(d[i], d[i - width] + 1)
        if (x > 0) d[i] = Math.min(d[i], d[i - width - 1] + D)
        if (x < width - 1) d[i] = Math.min(d[i], d[i - width + 1] + D)
      }
    }
  for (let y = height - 1; y >= 0; y--)
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x
      if (x < width - 1) d[i] = Math.min(d[i], d[i + 1] + 1)
      if (y < height - 1) {
        d[i] = Math.min(d[i], d[i + width] + 1)
        if (x < width - 1) d[i] = Math.min(d[i], d[i + width + 1] + D)
        if (x > 0) d[i] = Math.min(d[i], d[i + width - 1] + D)
      }
    }
  for (let i = 0; i < d.length; i++) d[i] = Math.min(d[i], 30)
  return d
}

/** Water intersections reachable from `from` (4-connected). */
function reachable(width: number, height: number, h: Float32Array, from: Pt): Uint8Array {
  const seen = new Uint8Array(width * height)
  const start = from.y * width + from.x
  if (h[start] > 0) return seen
  const queue = [start]
  seen[start] = 1
  while (queue.length) {
    const i = queue.pop()!
    const x = i % width
    const y = (i - x) / width
    const nb = [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, y > 0 ? i - width : -1, y < height - 1 ? i + width : -1]
    for (const j of nb) {
      if (j < 0 || seen[j] || h[j] > 0) continue
      seen[j] = 1
      queue.push(j)
    }
  }
  return seen
}

/** Outward rounding ray direction at mark M, coming from P and leaving toward N. */
function roundingRay(P: Pt, M: Pt, N: Pt, side: Side): Pt {
  const unit = (v: Pt) => scale(v, 1 / (len(v) || 1))
  const inA = unit(sub(P, M))
  const outB = unit(sub(N, M))
  const bis = scale(add(inA, outB), -1)
  if (len(bis) > 0.25) return unit(bis)
  // Nearly straight through: the ray points to the side the boat passes on.
  const travel = unit(sub(N, P))
  return side === "port" ? { x: -travel.y, y: travel.x } : { x: travel.y, y: -travel.x }
}

/** Port rounding (mark on your left) goes counter-clockwise around it: cross(ray, move) < 0 on screen. */
const sideSign = (side: Side): -1 | 1 => (side === "port" ? -1 : 1)

interface Layout {
  start: [Pt, Pt]
  marks: { pos: Pt; side: Side | null }[]
}

function upwindExtent(width: number, height: number, u: Pt, margin: number) {
  const ax = Math.abs(u.x) < 1e-6 ? Infinity : (width / 2 - margin) / Math.abs(u.x)
  const ay = Math.abs(u.y) < 1e-6 ? Infinity : (height / 2 - margin) / Math.abs(u.y)
  return Math.min(ax, ay)
}

const clampToMap = (p: Pt, width: number, height: number, m: number): Pt => ({
  x: clamp(p.x, m, width - 1 - m),
  y: clamp(p.y, m, height - 1 - m),
})

const cellCenter = (p: Pt): Pt => ({ x: Math.floor(p.x) + 0.5, y: Math.floor(p.y) + 0.5 })

function startLine(center: Pt, windFrom: number, width: number, height: number): [Pt, Pt] {
  const perp = dirVec(windFrom + 90)
  const half = 11
  return [
    roundPt(clampToMap(add(center, scale(perp, -half)), width, height, 2)),
    roundPt(clampToMap(add(center, scale(perp, half)), width, height, 2)),
  ]
}

function windwardLeeward(cfg: RaceConfig, width: number, height: number, windFrom: number, rnd: () => number): Layout {
  const u = dirVec(windFrom)
  const perp = dirVec(windFrom + 90)
  const C = { x: (width - 1) / 2, y: (height - 1) / 2 }
  const E = upwindExtent(width, height, u, 7)
  const S = add(C, scale(u, -E * 0.62))
  const W = cellCenter(add(add(C, scale(u, E * 0.78)), scale(perp, (rnd() - 0.5) * 8)))
  const L = cellCenter(add(S, scale(u, -5)))
  const marks: Layout["marks"] = []
  for (let lap = 0; lap < cfg.laps; lap++) {
    marks.push({ pos: W, side: "port" })
    if (lap < cfg.laps - 1) marks.push({ pos: L, side: "port" })
  }
  return { start: startLine(S, windFrom, width, height), marks }
}

/** Sides for marks visited in order along `path` (start, marks…, finish): a right turn leaves the mark to starboard. */
function sidesAlong(path: Pt[]): Side[] {
  return path.slice(1, -1).map((pos, i) => (cross(sub(pos, path[i]), sub(path[i + 2], pos)) > 0 ? "starboard" : "port"))
}

/**
 * The classic triangle: beat to the windward mark, reach out to the wing mark, reach back down to the
 * leeward mark, and repeat; then a short beat to the finish. Mostly reaching.
 */
function triangle(cfg: RaceConfig, width: number, height: number, windFrom: number, rnd: () => number): Layout {
  const u = dirVec(windFrom)
  const C = { x: (width - 1) / 2, y: (height - 1) / 2 }
  const E = upwindExtent(width, height, u, 7)
  const S = add(C, scale(u, -E * 0.62))
  const W = cellCenter(add(C, scale(u, E * 0.78)))
  const L = cellCenter(add(S, scale(u, -5)))
  // The wing mark sits out to one side, halfway down: reaches of about 125° to the wind.
  const mid = scale(add(W, L), 0.5)
  const leg = len(sub(W, L))
  const sides = [dirVec(windFrom + 90), dirVec(windFrom - 90)]
  const room = (d: Pt) => {
    let k = 0
    while (k < leg * 0.7 && inside(add(mid, scale(d, k + 1)), width, height, 8)) k++
    return k
  }
  const pick = rnd() < 0.5 ? 0 : 1
  const side = room(sides[pick]) >= room(sides[1 - pick]) ? sides[pick] : sides[1 - pick]
  const Wing = cellCenter(add(mid, scale(side, Math.max(8, room(side)))))
  const marks: Pt[] = []
  for (let lap = 0; lap < cfg.laps; lap++) marks.push(W, Wing, L)
  const start = startLine(S, windFrom, width, height)
  const center = scale(add(start[0], start[1]), 0.5)
  const turns = sidesAlong([center, ...marks, center])
  return { start, marks: marks.map((pos, i) => ({ pos, side: turns[i] })) }
}

const inside = (p: Pt, width: number, height: number, m: number) => p.x >= m && p.y >= m && p.x <= width - 1 - m && p.y <= height - 1 - m

function islandsCourse(
  width: number,
  height: number,
  windFrom: number,
  h: Float32Array,
  rnd: () => number,
): Layout | null {
  const u = dirVec(windFrom)
  const C = { x: (width - 1) / 2, y: (height - 1) / 2 }
  const E = upwindExtent(width, height, u, 7)
  const S = add(C, scale(u, -E * 0.7))
  const count = 3 + Math.floor(rnd() * 2)
  const minSep = Math.min(width, height) * 0.3
  const marks: Pt[] = []
  for (let tries = 0; tries < 400 && marks.length < count; tries++) {
    const p = cellCenter({ x: 8 + rnd() * (width - 17), y: 8 + rnd() * (height - 17) })
    if (h[Math.floor(p.y) * width + Math.floor(p.x)] > -0.05) continue
    if (dist(p, S) < minSep) continue
    if (marks.some((m) => dist(m, p) < minSep)) continue
    marks.push(p)
  }
  if (marks.length < 3) return null
  // Visit marks in angular order around their centroid, so the course is a loop, not a zigzag.
  const all = [S, ...marks]
  const c = scale(
    all.reduce((acc, p) => add(acc, p), { x: 0, y: 0 }),
    1 / all.length,
  )
  const dir = rnd() < 0.5 ? 1 : -1
  const ang = (p: Pt) => norm360(dir * (bearing(c, p) - bearing(c, S)))
  marks.sort((a, b) => ang(a) - ang(b))
  const path = [S, ...marks, S]
  return {
    start: startLine(S, windFrom, width, height),
    marks: marks.map((pos, i) => ({ pos, side: sidesAlong(path)[i] })),
  }
}

function islandField(cfg: RaceConfig, width: number, height: number, attempt: number): Float32Array {
  const h = new Float32Array(width * height)
  const threshold = cfg.islands === "many" ? 0.12 : 0.3
  if (cfg.islands === "none") return h.fill(-1)
  const noiseSeed = hash(cfg.seed, 17, attempt)
  const featureScale = 20
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) h[y * width + x] = fbm(noiseSeed, x / featureScale, y / featureScale, 4) - threshold
  return h
}

/** Lower land near the course so marks, the start and the finish always sit in open water. */
function carve(h: Float32Array, width: number, height: number, points: Pt[], radius: number) {
  for (const p of points) {
    const r = Math.ceil(radius)
    for (let y = Math.max(0, Math.floor(p.y - r)); y <= Math.min(height - 1, Math.ceil(p.y + r)); y++)
      for (let x = Math.max(0, Math.floor(p.x - r)); x <= Math.min(width - 1, Math.ceil(p.x + r)); x++) {
        const d = Math.hypot(x - p.x, y - p.y)
        if (d < radius) h[y * width + x] -= 1.2 * (1 - d / radius) ** 0.5
      }
  }
}

function linePoints(a: Pt, b: Pt, step = 2): Pt[] {
  const n = Math.max(1, Math.ceil(dist(a, b) / step))
  return Array.from({ length: n + 1 }, (_, i) => ({ x: a.x + ((b.x - a.x) * i) / n, y: a.y + ((b.y - a.y) * i) / n }))
}

export function generateMap(cfg: RaceConfig): GameMap {
  const { width, height } = MAP_SIZES[cfg.size]
  const rnd = mulberry32(hash(cfg.seed, 1))
  const windFrom = Math.round(rnd() * 360) % 360
  for (let attempt = 0; attempt < 16; attempt++) {
    const density = attempt < 15 ? cfg.islands : "none"
    const h = islandField({ ...cfg, islands: density }, width, height, attempt)
    const layout =
      cfg.course === "islands"
        ? islandsCourse(width, height, windFrom, h, mulberry32(hash(cfg.seed, 2, attempt)))
        : cfg.course === "triangle"
          ? triangle(cfg, width, height, windFrom, mulberry32(hash(cfg.seed, 2)))
          : windwardLeeward(cfg, width, height, windFrom, mulberry32(hash(cfg.seed, 2)))
    if (!layout) continue
    const [la, lb] = layout.start
    const startCenter = scale(add(la, lb), 0.5)
    const downwind = dirVec(windFrom + 180)
    const startBox = linePoints(add(la, scale(downwind, 3)), add(lb, scale(downwind, 3)))
    carve(h, width, height, [...linePoints(la, lb), ...startBox], 6)
    carve(
      h,
      width,
      height,
      layout.marks.map((m) => m.pos),
      7,
    )
    const from = roundPt(add(startCenter, scale(downwind, 2)))
    const wet = reachable(width, height, h, from)
    const ok =
      layout.marks.every((m) => {
        const p = roundPt(m.pos)
        return [0, 90, 180, 270].every((a) => {
          const q = roundPt(add(p, scale(dirVec(a), 3)))
          return q.x >= 0 && q.y >= 0 && q.x < width && q.y < height && wet[q.y * width + q.x] === 1
        })
      }) && linePoints(la, lb, 1).every((p) => wet[Math.round(p.y) * width + Math.round(p.x)] === 1)
    if (!ok) continue
    return buildMap(cfg, width, height, h, windFrom, layout)
  }
  throw new Error("Could not generate a map")
}

function buildMap(
  cfg: RaceConfig,
  width: number,
  height: number,
  h: Float32Array,
  windFrom: number,
  layout: Layout,
): GameMap {
  const [la, lb] = layout.start
  const startCenter = scale(add(la, lb), 0.5)
  const u = dirVec(windFrom)
  const upSign = Math.sign(cross(sub(lb, la), u)) as -1 | 1
  const gates: Gate[] = [{ kind: "start", a: la, b: lb, sign: upSign, label: "Start" }]
  const points = [startCenter, ...layout.marks.map((m) => m.pos), startCenter]
  layout.marks.forEach((m, i) => {
    const side = m.side ?? "port"
    const ray = roundingRay(points[i], m.pos, points[i + 2], side)
    gates.push({
      kind: "mark",
      a: m.pos,
      b: add(m.pos, scale(ray, 1000)),
      sign: sideSign(side),
      label: `Mark ${i + 1}`,
      mark: m.pos,
      side,
    })
  })
  gates.push({ kind: "finish", a: la, b: lb, sign: 0, label: "Finish" })
  const marks: Pt[] = []
  for (const m of layout.marks) if (!marks.some((p) => p.x === m.pos.x && p.y === m.pos.y)) marks.push(m.pos)
  return {
    config: cfg,
    width,
    height,
    h,
    coast: coastDistance(width, height, h),
    windFrom,
    windSpeed: cfg.windSpeed,
    gates,
    marks,
    startLine: [la, lb],
    finishLine: [la, lb],
  }
}

/** Starting spots: just downwind of the line, spread along it, on starboard tack. */
export function startingPositions(m: GameMap, n: number): { pos: Pt; heading: number }[] {
  const [a, b] = m.startLine
  const downwind = dirVec(m.windFrom + 180)
  const heading = norm360(Math.round(m.windFrom - 45))
  const out: { pos: Pt; heading: number }[] = []
  const taken = new Set<string>()
  for (let i = 0; i < n; i++) {
    const t = (i + 1) / (n + 1)
    const base = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
    let pos = roundPt(add(base, scale(downwind, 2.5)))
    for (let k = 0; k < 6 && (!isWater(m, pos) || taken.has(`${pos.x},${pos.y}`)); k++)
      pos = roundPt(add(base, scale(downwind, 3.5 + k)))
    taken.add(`${pos.x},${pos.y}`)
    out.push({ pos, heading })
  }
  return out
}
