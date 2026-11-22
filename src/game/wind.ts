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
  // How far the air (and the puffs and shifts in it) travels in a turn, cells.
  const carry = Math.max(1, CARRY * m.windSpeed * CELLS_PER_KNOT)

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

      // Puffs: a pattern moving downwind with the air, stretched along the wind, slowly changing.
      const qx = x + up.x * carry * turn
      const qy = y + up.y * carry * turn
      const a = (qx * up.x + qy * up.y) / 18
      const c = (qx * across.x + qy * across.y) / 10
      const g = clamp(p.puff * 1.8 * fbm3(sPuff, a, c, turn / 5, 2), -0.6, 0.6)
      w *= 1 + g
      f += p.veer * g + p.puffVeerNoise * 1.6 * fbm3(sPuffDir, a * 1.3, c * 1.3, turn / 4, 1)

      // Geography: a slow, fixed bias across the course.
      w *= 1 + p.biasSpeed * valueNoise(sBias, x / 55, y / 55)
      f += p.biasDir * valueNoise(sBias + 1, x / 60, y / 60)

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
    baseFrom: ((baseFromAt(turn) % 360) + 360) % 360,
    baseSpeed: baseSpeedAt(turn),
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
