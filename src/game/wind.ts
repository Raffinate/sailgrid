import { bearing, clamp, dirVec, dot, type Pt } from "./geom.ts"
import type { GameMap } from "./map.ts"
import { fbm3, hash, mulberry32, noise1, valueNoise } from "./rng.ts"
import { CELLS_PER_KNOT } from "./units.ts"

/**
 * The true wind at every intersection for one turn. It's a pure function of the map (seed) and the turn
 * number, so every client and the AI agree on it, and the AI can look ahead.
 *
 * What goes into it, roughly the way wind behaves on the water:
 * - The breeze oscillates and wanders, and the shifts travel downwind with the air: a boat further
 *   upwind gets each shift first.
 * - Puffs and lulls are carried downwind at about 70% of the wind speed. They're stretched along the
 *   wind, they grow and fade over a few minutes, and puffs veer while lulls back (northern hemisphere).
 * - A slow, large-scale bias makes one part of the course a little windier or more lifted than another.
 * - Eddies: small whirls of air, a few hundred metres across, that form, drift downwind with the breeze
 *   for several minutes, and fade. On one side of an eddy the wind is stronger and on the other lighter,
 *   and it swings in direction round it.
 * - Wind lines: a new breeze filling in. A band of changed wind moves down the course; behind its leading
 *   edge the wind has shifted 10–25° either way and is usually stronger (sometimes lighter), and it stays
 *   that way for several turns before the old breeze returns. A few come through every race.
 * - A front (when the race has one): a line that sweeps across the course partway through. Ahead of it
 *   the wind backs and eases a little; on the line there's a gusty squall; then a kilometre or two of rough,
 *   chaotic air, full of eddies, where the direction jumps and gusts come and go every turn; and behind
 *   that the wind has settled, veered a long way, stronger and gustier.
 * - Islands cast wind shadow downwind (longer behind higher land, and gusty inside), the wind speeds
 *   up between islands and round headlands, and wind blowing onto a shore bends along it.
 */
export interface WindField {
  turn: number
  width: number
  height: number
  /** Direction the wind comes from, degrees. */
  from: Float32Array
  /** Speed, knots. */
  speed: Float32Array
  /** Wind as a vector toward where it comes from, times its speed: for interpolation. */
  vx: Float32Array
  vy: Float32Array
  /** The breeze at the middle of the map this turn, before puffs and islands. */
  baseFrom: number
  baseSpeed: number
}

/** A small whirl of air drifting with the breeze. */
export interface Eddy {
  /** Where its centre is this turn. */
  x: number
  y: number
  /** Cells to where it turns fastest. */
  radius: number
  /** 1: turning clockwise on the chart; −1: anticlockwise. */
  spin: 1 | -1
  /** How fast the air turns round it at `radius`, knots (already faded in or out by its age). */
  strength: number
}

/** A front: a straight line moving across the map, with different wind behind it. */
export interface Front {
  /** Turn at which the line crosses the middle of the map (fractional). */
  arrival: number
  /** Compass direction the line moves toward. */
  toward: number
  /** How fast it moves, cells per turn. */
  speed: number
  /** How far the wind veers behind it, degrees. */
  shift: number
  /** Wind strength behind it, as a share of the wind ahead. */
  gain: number
  /** How deep the rough, chaotic air behind it reaches, cells (about 1.7–3 km: several turns of it). */
  depth: number
}

export interface Wind {
  from: number
  speed: number
}

/** Puffs and shifts travel downwind at this share of the wind speed. */
export const CARRY = 0.7

interface Params {
  amp: number
  amp2: number
  period: number
  period2: number
  periodS: number
  phase: [number, number, number]
  wander: number
  drift: number
  pressure: number
  puff: number
  veer: number
  puffVeerNoise: number
  biasSpeed: number
  biasDir: number
}

function params(m: GameMap): Params {
  const r = mulberry32(hash(m.config.seed, 3))
  const shifty = m.config.shifts === "shifty"
  return {
    amp: shifty ? 9 : 3.5,
    amp2: shifty ? 3.5 : 1.5,
    period: 14 + r() * 10,
    period2: 5 + r() * 3,
    periodS: 18 + r() * 12,
    phase: [r() * 2 * Math.PI, r() * 2 * Math.PI, r() * 2 * Math.PI],
    wander: shifty ? 5 : 2,
    drift: (r() - 0.5) * (shifty ? 0.4 : 0.12),
    pressure: shifty ? 0.08 : 0.05,
    puff: shifty ? 0.3 : 0.15,
    veer: 25,
    puffVeerNoise: shifty ? 5 : 2,
    biasSpeed: shifty ? 0.08 : 0.05,
    biasDir: shifty ? 5 : 2,
  }
}

const TAU = 2 * Math.PI

/** Cells per turn the air (and the puffs, shifts and eddies in it) travels. */
const carryOf = (m: GameMap) => Math.max(1, CARRY * m.windSpeed * CELLS_PER_KNOT)

const smoothstep = (t: number) => {
  const u = clamp(t, 0, 1)
  return u * u * (3 - 2 * u)
}

// ---- Front -------------------------------------------------------------------------------------

/** Width of the change across the front line, cells (a couple of hundred metres). */
const FRONT_WIDTH = 6

const frontCache = new WeakMap<GameMap, Front | null>()

/**
 * The race's front, if it has one. It arrives partway through the race: when depends on a rough guess at
 * how long the course takes to sail, so it lands mid-race on a short course and a long one alike. Like a
 * cold front in the northern hemisphere, the wind veers behind it, 35–70°, and is a fifth to half stronger.
 */
export function frontOf(m: GameMap): Front | null {
  const hit = frontCache.get(m)
  if (hit !== undefined) return hit
  // The forecast gives the chance; the seed decides whether it comes.
  const comes = mulberry32(hash(m.config.seed, 32))() * 100 < m.config.frontChance
  if (!comes) {
    frontCache.set(m, null)
    return null
  }
  const r = mulberry32(hash(m.config.seed, 31))
  const shift = 35 + r() * 35
  const gain = 1.2 + r() * 0.3
  // It comes from roughly where the new wind does, and moves about as fast as that wind.
  const toward = norm(m.windFrom + shift + 180 + (r() - 0.5) * 30)
  const speed = Math.max(4, (0.8 + r() * 0.4) * m.windSpeed * gain * CELLS_PER_KNOT)
  // How long the race might take: the course, with some extra for beating, at a typical boat speed.
  const center = { x: (m.width - 1) / 2, y: (m.height - 1) / 2 }
  const start = { x: (m.startLine[0].x + m.startLine[1].x) / 2, y: (m.startLine[0].y + m.startLine[1].y) / 2 }
  const legs = [start, ...m.gates.filter((g) => g.mark).map((g) => g.mark!), start]
  let length = 0
  for (let i = 1; i < legs.length; i++) length += Math.hypot(legs[i].x - legs[i - 1].x, legs[i].y - legs[i - 1].y)
  const boatSpeed = Math.min(7, 0.55 * m.windSpeed) * CELLS_PER_KNOT
  const raceTurns = (1.3 * length) / boatSpeed
  // Never already on the map at the start: it's seen coming.
  const reach = Math.hypot(center.x, center.y)
  const arrival = Math.max(reach / speed + 3, (0.3 + r() * 0.35) * raceTurns)
  const depth = 45 + r() * 35
  const front = { arrival, toward, speed, shift, gain, depth }
  frontCache.set(m, front)
  return front
}

/**
 * How rough the air is at a point `d` cells behind the front line, 0–1. It comes on within a few cells of
 * the line, stays fully rough for the first 40% of the zone, then fades into the new breeze.
 */
export function frontRoughness(f: Front, d: number): number {
  if (d <= 0) return 0
  return smoothstep(d / 3) * Math.exp(-Math.max(0, d - 0.4 * f.depth) / (0.35 * f.depth))
}

/** How far behind the front line a point is this turn, cells: negative ahead of it, positive once it has passed. */
export function behindFront(m: GameMap, f: Front, turn: number, p: Pt): number {
  const n = dirVec(f.toward)
  const center = { x: (m.width - 1) / 2, y: (m.height - 1) / 2 }
  return f.speed * (turn - f.arrival) - ((p.x - center.x) * n.x + (p.y - center.y) * n.y)
}

// ---- Wind lines --------------------------------------------------------------------------------

/** A band of changed wind moving down the course: a new breeze filling in, for a while. */
export interface WindLine {
  /** Turn at which its leading edge crosses the middle of the map (fractional). */
  center: number
  /** Compass direction it moves toward. */
  toward: number
  /** Cells per turn. */
  speed: number
  /** How far the wind shifts inside it, degrees: positive veers, negative backs. */
  shift: number
  /** Wind strength inside it, as a share of the wind outside. */
  gain: number
  /** How deep the band is, cells: a boat that stays put is in it for `depth / speed` turns. */
  depth: number
}

/** Width of the leading edge, where the change comes in, cells. */
const LINE_EDGE = 5

/** Probe this many turns either side for lines whose band could be on the map. */
const LINE_WINDOW = 45

const lineCache = new WeakMap<GameMap, Map<number, WindLine | null>>()

/** The wind line whose leading edge crosses the middle of the map in turn slot `k`, if there is one. */
function lineFor(m: GameMap, k: number): WindLine | null {
  let perMap = lineCache.get(m)
  if (!perMap) lineCache.set(m, (perMap = new Map()))
  const hit = perMap.get(k)
  if (hit !== undefined) return hit
  const r = mulberry32(hash(m.config.seed, 41, k + 1000))
  // On average one every 10 turns on shifty days, every 16 on steady ones.
  const rate = m.config.shifts === "shifty" ? 1 / 10 : 1 / 16
  let line: WindLine | null = null
  if (r() < rate) {
    const speed = Math.max(3, (0.6 + r() * 0.3) * m.windSpeed * CELLS_PER_KNOT)
    const stronger = r() < 0.75
    line = {
      center: k + r(),
      toward: norm(m.windFrom + 180 + (r() - 0.5) * 40),
      speed,
      shift: (r() < 0.55 ? 1 : -1) * (10 + r() * 15),
      gain: stronger ? 1.15 + r() * 0.25 : 0.75 + r() * 0.15,
      depth: (3 + r() * 5) * speed,
    }
  }
  perMap.set(k, line)
  return line
}

/** The wind lines that are on the map this turn (or about to come on). */
export function windLinesAt(m: GameMap, turn: number): WindLine[] {
  const reach = Math.hypot(m.width, m.height) / 2
  const out: WindLine[] = []
  for (let k = Math.floor(turn - LINE_WINDOW); k <= Math.ceil(turn + LINE_WINDOW); k++) {
    const l = lineFor(m, k)
    if (!l) continue
    const lead = l.speed * (turn - l.center)
    if (lead + LINE_EDGE > -reach && lead - l.depth * 1.2 < reach) out.push(l)
  }
  return out
}

/**
 * How much of a wind line's change a point gets, 0–1, `d` cells behind its leading edge: it comes in over
 * a few cells at the edge, holds through the band, and fades out gently at the back.
 */
export function windLineWeight(l: WindLine, d: number): number {
  const into = smoothstep(0.5 + d / LINE_EDGE)
  const trail = 0.3 * l.depth
  return into * (1 - smoothstep(0.5 + (d - l.depth) / trail))
}

/** How far behind a wind line's leading edge a point is this turn, cells. */
export function behindLine(m: GameMap, l: WindLine, turn: number, p: Pt): number {
  const n = dirVec(l.toward)
  return l.speed * (turn - l.center) - ((p.x - (m.width - 1) / 2) * n.x + (p.y - (m.height - 1) / 2) * n.y)
}

// ---- Eddies ------------------------------------------------------------------------------------

const EDDY_MAX_LIFE = 14

/**
 * The eddies on the map this turn. Each is born at a random place and time, drifts downwind with the air
 * (along the wind it was born in, so behind a front they drift the new way), turns up and dies away over
 * 6–14 turns. Shifty days have more of them, and stronger.
 */
export function eddiesAt(m: GameMap, turn: number): Eddy[] {
  const shifty = m.config.shifts === "shifty"
  const rate = ((m.width * m.height) / 21000) * (shifty ? 1.3 : 1)
  const carry = carryOf(m)
  const front = frontOf(m)
  const out: Eddy[] = []
  for (let k = Math.floor(turn - EDDY_MAX_LIFE); k <= turn; k++) {
    const r = mulberry32(hash(m.config.seed, 21, k + 1000))
    const count = Math.floor(rate + r())
    for (let j = 0; j < count; j++) {
      const birth = k + r()
      const life = 6 + r() * (EDDY_MAX_LIFE - 6)
      const x0 = r() * (m.width - 1)
      const y0 = r() * (m.height - 1)
      const radius = 4 + r() * 6
      const spin: 1 | -1 = r() < 0.5 ? 1 : -1
      const strength = m.windSpeed * (shifty ? 0.18 + r() * 0.14 : 0.12 + r() * 0.1)
      const age = turn - birth
      if (age < 0 || age > life) continue
      const veer = front ? front.shift * smoothstep(0.5 + behindFront(m, front, birth, { x: x0, y: y0 }) / FRONT_WIDTH) : 0
      const down = dirVec(m.windFrom + veer + 180)
      out.push({
        x: x0 + down.x * carry * age,
        y: y0 + down.y * carry * age,
        radius,
        spin,
        strength: strength * Math.sin((Math.PI * age) / life),
      })
    }
  }
  if (front) out.push(...frontEddies(m, front, turn))
  return out
}

const FRONT_EDDY_LIFE = 9

/**
 * The rough air behind a front is full of eddies: smaller, stronger and shorter-lived than the usual ones.
 * They're born across the rough zone as the front passes and drift away with the new wind.
 */
function frontEddies(m: GameMap, f: Front, turn: number): Eddy[] {
  const carry = carryOf(m)
  const n = dirVec(f.toward)
  const along = { x: -n.y, y: n.x }
  const center = { x: (m.width - 1) / 2, y: (m.height - 1) / 2 }
  const span = Math.hypot(m.width, m.height)
  const down = dirVec(m.windFrom + f.shift + 180)
  const out: Eddy[] = []
  for (let k = Math.floor(turn - FRONT_EDDY_LIFE); k <= turn; k++) {
    const r = mulberry32(hash(m.config.seed, 23, k + 1000))
    const count = Math.floor(span / 30 + r())
    for (let j = 0; j < count; j++) {
      const birth = k + r()
      const life = 4 + r() * (FRONT_EDDY_LIFE - 4)
      // Somewhere along the line, some way back into the rough zone, where the front was at birth.
      const t = (r() - 0.5) * span
      const u = 2 + r() * 0.6 * f.depth
      const radius = 3 + r() * 4
      const spin: 1 | -1 = r() < 0.5 ? 1 : -1
      const strength = m.windSpeed * f.gain * (0.15 + r() * 0.15)
      const age = turn - birth
      if (age < 0 || age > life) continue
      const back = f.speed * (birth - f.arrival) - u
      const x0 = center.x + n.x * back + along.x * t
      const y0 = center.y + n.y * back + along.y * t
      const x = x0 + down.x * carry * age
      const y = y0 + down.y * carry * age
      if (x < -radius * 3 || y < -radius * 3 || x > m.width + radius * 3 || y > m.height + radius * 3) continue
      out.push({ x, y, radius, spin, strength: strength * Math.sin((Math.PI * age) / life) })
    }
  }
  return out
}

/** The air's own motion round the eddies at a point, knots, as a vector on the chart (x east, y south). */
function eddyFlow(eddies: Eddy[], x: number, y: number): Pt {
  let fx = 0
  let fy = 0
  for (const e of eddies) {
    const dx = x - e.x
    const dy = y - e.y
    const r = Math.hypot(dx, dy)
    if (r < 1e-6 || r > 3 * e.radius) continue
    // Turning like a solid near the middle, fastest at `radius`, dying away outside it.
    const u = r / e.radius
    const v = e.strength * u * Math.exp(0.5 * (1 - u * u))
    // (−dy, dx) turns clockwise on the chart, where y points south.
    fx += (e.spin * -dy * v) / r
    fy += (e.spin * dx * v) / r
  }
  return { x: fx, y: fy }
}

const norm = (a: number) => ((a % 360) + 360) % 360

function compute(m: GameMap, turn: number): WindField {
  const p = params(m)
  const { width, height } = m
  const seed = m.config.seed
  const sWander = hash(seed, 6)
  const sPressure = hash(seed, 7)
  const sPuff = hash(seed, 4)
  const sPuffDir = hash(seed, 5)
  const sBias = hash(seed, 8)
  const sSwirl = hash(seed, 9)
  const up = dirVec(m.windFrom)
  const across = { x: -up.y, y: up.x }
  const center = { x: (width - 1) / 2, y: (height - 1) / 2 }
  const carry = carryOf(m)
  const front = frontOf(m)
  const sSquall = hash(seed, 10)
  const sChaos = hash(seed, 11)
  const sGust = hash(seed, 12)
  const eddies = eddiesAt(m, turn)
  const lines = windLinesAt(m, turn)
  const sEdge = hash(seed, 13)

  const baseFromAt = (t: number) =>
    m.windFrom +
    p.amp * Math.sin((TAU * t) / p.period + p.phase[0]) +
    p.amp2 * Math.sin((TAU * t) / p.period2 + p.phase[1]) +
    p.wander * noise1(sWander, t / 7) +
    p.drift * t
  const baseSpeedAt = (t: number) =>
    m.windSpeed * (1 + p.pressure * Math.sin((TAU * t) / p.periodS + p.phase[2]) + 0.06 * noise1(sPressure, t / 9))

  const islands = m.config.islands !== "none"
  const landAt = (x: number, y: number) => {
    // Off the map is open water as far as the wind is concerned.
    if (x < 0 || y < 0 || x > width - 1 || y > height - 1) return -1
    const x0 = Math.min(width - 2, Math.floor(x))
    const y0 = Math.min(height - 2, Math.floor(y))
    const fx = x - x0
    const fy = y - y0
    const i = y0 * width + x0
    const h = m.h
    return h[i] * (1 - fx) * (1 - fy) + h[i + 1] * fx * (1 - fy) + h[i + width] * (1 - fx) * fy + h[i + width + 1] * fx * fy
  }

  // The breeze in the middle of the map, front included: what puffs and lulls are measured against.
  const baseAtCenter = () => {
    let from = baseFromAt(turn)
    let speed = baseSpeedAt(turn)
    if (front) {
      const behind = smoothstep(0.5 + behindFront(m, front, turn, center) / FRONT_WIDTH)
      from += front.shift * behind
      speed *= 1 + (front.gain - 1) * behind
    }
    return { baseFrom: norm(from), baseSpeed: speed }
  }

  const from = new Float32Array(width * height)
  const speed = new Float32Array(width * height)
  const vx = new Float32Array(width * height)
  const vy = new Float32Array(width * height)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      // Upwind of the middle, the air (and the shift it carries) arrives sooner.
      const s = (x - center.x) * up.x + (y - center.y) * up.y
      const tl = turn + s / carry
      let f = baseFromAt(tl)
      let w = baseSpeedAt(tl)

      // The front: backing and easing ahead of the line, a squall on it, the new wind behind it.
      let gusty = 1
      if (front) {
        const d = behindFront(m, front, turn, { x, y })
        const behind = smoothstep(0.5 + d / FRONT_WIDTH)
        const ahead = d < 0 ? Math.exp(d / 12) : 0
        const squall = Math.exp(-((d - 3) ** 2) / 18)
        f += front.shift * behind - 6 * ahead + 14 * squall * fbm3(sSquall, x / 4, y / 4, turn / 2, 1)
        w *= (1 + (front.gain - 1) * behind) * (1 - 0.15 * ahead) * (1 + 0.35 * squall)
        // Behind the line the air is chaotic for a kilometre or two: the direction jumps 25–35° and gusts
        // come and go, a new pattern every turn, before it settles into the new breeze.
        const rough = frontRoughness(front, d)
        if (rough > 0.01) {
          f += clamp(70 * rough * fbm3(sChaos, x / 7, y / 7, turn * 1.1, 2), -35, 35)
          w *= 1 + rough * clamp(1.1 * fbm3(sGust, x / 5, y / 5, turn * 1.3, 2), -0.35, 0.45)
        }
        gusty = 1 + 0.5 * behind
      }

      // Wind lines: inside each band the wind is shifted and stronger (or lighter), with a little
      // gustiness right at the leading edge.
      for (const l of lines) {
        const d = behindLine(m, l, turn, { x, y })
        const k = windLineWeight(l, d)
        if (k < 0.002) continue
        const edge = Math.exp(-((d - 2) ** 2) / 8)
        f += l.shift * k + 6 * edge * fbm3(sEdge, x / 4, y / 4, turn, 1)
        w *= (1 + (l.gain - 1) * k) * (1 + 0.12 * edge)
      }

      // Puffs: a pattern moving downwind with the air, stretched along the wind, slowly changing.
      const qx = x + up.x * carry * turn
      const qy = y + up.y * carry * turn
      const a = (qx * up.x + qy * up.y) / 18
      const c = (qx * across.x + qy * across.y) / 10
      const g = clamp(p.puff * 1.8 * gusty * fbm3(sPuff, a, c, turn / 5, 2), -0.6, 0.6)
      w *= 1 + g
      f += p.veer * g + p.puffVeerNoise * 1.6 * fbm3(sPuffDir, a * 1.3, c * 1.3, turn / 4, 1)

      // Geography: a slow, fixed bias across the course.
      w *= 1 + p.biasSpeed * valueNoise(sBias, x / 55, y / 55)
      f += p.biasDir * valueNoise(sBias + 1, x / 60, y / 60)

      // Eddies: the air turning round each one adds to the wind on one side and takes from it on the other.
      if (eddies.length) {
        const e = eddyFlow(eddies, x, y)
        if (e.x || e.y) {
          const to = dirVec(f + 180)
          const vx = to.x * w + e.x
          const vy = to.y * w + e.y
          w = Math.hypot(vx, vy)
          f = bearing({ x: vx, y: vy }, { x: 0, y: 0 })
        }
      }

      if (islands) {
        const u = dirVec(f)
        // Shadow: land upwind slows the wind; higher land reaches further, and the air behind it is gusty.
        let shadowed = false
        for (let d = 1; d <= 22; d++) {
          if (landAt(x + u.x * d, y + u.y * d) <= 0) continue
          let peak = 0
          for (let e = d; e < d + 8; e++) peak = Math.max(peak, landAt(x + u.x * e, y + u.y * e))
          const reach = clamp(8 + 30 * peak, 8, 22)
          if (d < reach) {
            const k = d / reach
            w *= 0.3 + 0.7 * k * k
            f += (1 - k) * 15 * fbm3(sSwirl, x / 5, y / 5, turn / 2, 1)
            shadowed = true
          }
          break
        }
        const coast = m.coast[i]
        if (!shadowed && coast > 0 && coast < 7) {
          // Squeezed between land on both sides (or round a headland on one), the wind speeds up.
          const side = { x: -u.y, y: u.x }
          let squeeze = 0
          for (const sgn of [1, -1])
            for (let d = 1; d <= 6; d++)
              if (landAt(x + side.x * d * sgn, y + side.y * d * sgn) > 0) {
                squeeze += 1 - (d - 1) / 6
                break
              }
          w *= 1 + 0.08 * squeeze
        }
        // Blowing onto a shore, the wind bends to run along it.
        if (coast > 0 && coast < 4 && x > 0 && y > 0 && x < width - 1 && y < height - 1) {
          const n = { x: m.coast[i + 1] - m.coast[i - 1], y: m.coast[i + width] - m.coast[i - width] }
          const nl = Math.hypot(n.x, n.y)
          if (nl > 1e-6) {
            n.x /= nl
            n.y /= nl
            const to = dirVec(f + 180)
            const into = dot(to, n)
            if (into < 0) {
              const k = 0.85 * (1 - coast / 4)
              f = bearing({ x: to.x - into * n.x * k, y: to.y - into * n.y * k }, { x: 0, y: 0 })
            }
          }
        }
      }
      f = ((f % 360) + 360) % 360
      w = clamp(w, 0.5, 35)
      from[i] = f
      speed[i] = w
      const v = dirVec(f)
      vx[i] = v.x * w
      vy[i] = v.y * w
    }
  return {
    turn,
    width,
    height,
    from,
    speed,
    vx,
    vy,
    ...baseAtCenter(),
  }
}

const cache = new WeakMap<GameMap, Map<number, WindField>>()

export function windField(m: GameMap, turn: number): WindField {
  let perMap = cache.get(m)
  if (!perMap) cache.set(m, (perMap = new Map()))
  let f = perMap.get(turn)
  if (!f) {
    f = compute(m, turn)
    perMap.set(turn, f)
    if (perMap.size > 12) perMap.delete(perMap.keys().next().value!)
  }
  return f
}

/** Wind at any point, interpolating the wind vectors of the surrounding intersections. */
export function windAt(f: WindField, p: Pt): Wind {
  const x = clamp(p.x, 0, f.width - 1)
  const y = clamp(p.y, 0, f.height - 1)
  if (Number.isInteger(x) && Number.isInteger(y)) {
    const i = y * f.width + x
    return { from: f.from[i], speed: f.speed[i] }
  }
  const x0 = Math.min(f.width - 2, Math.floor(x))
  const y0 = Math.min(f.height - 2, Math.floor(y))
  const fx = x - x0
  const fy = y - y0
  const i = y0 * f.width + x0
  const W = f.width
  const w00 = (1 - fx) * (1 - fy)
  const w10 = fx * (1 - fy)
  const w01 = (1 - fx) * fy
  const w11 = fx * fy
  const vx = f.vx[i] * w00 + f.vx[i + 1] * w10 + f.vx[i + W] * w01 + f.vx[i + W + 1] * w11
  const vy = f.vy[i] * w00 + f.vy[i + 1] * w10 + f.vy[i + W] * w01 + f.vy[i + W + 1] * w11
  return { from: bearing({ x: 0, y: 0 }, { x: vx, y: vy }), speed: Math.hypot(vx, vy) }
}
