import { add, angleDiff, clamp, DEG, dirVec, dist, type Pt, roundPt, scale } from "./geom.ts"
import type { Polar } from "./polar.ts"
import { CELLS_PER_KNOT, TURN_SECONDS } from "./units.ts"
import type { Wind } from "./wind.ts"

export { CELLS_PER_KNOT } from "./units.ts"

/** What a player decides each turn. */
export interface Plan {
  /** Compass heading, degrees. */
  heading: number
  /** Sheet setting: the boom's angle off the centerline, 0 (sheeted hard in) to 90 (fully eased). */
  sail: number
}

export const MAX_SAIL = 90

export interface BoatMotion {
  heading: number
  speed: number
}

export type Tack = "starboard" | "port"

/** Signed true wind angle: positive when the wind comes over starboard. */
export const twaOf = (heading: number, windFrom: number) => angleDiff(windFrom, heading)

export const tackOf = (heading: number, windFrom: number): Tack =>
  twaOf(heading, windFrom) >= 0 ? "starboard" : "port"

/**
 * The sheet setting that gives the most drive at a true wind angle: nearly centered close-hauled,
 * about 35° on a beam reach, square out on a run.
 */
export const idealSail = (twa: number) => clamp(Math.round((Math.abs(twa) - 25) * 0.55), 0, 85)

/**
 * Share of the polar speed the sail delivers. Eased past the ideal it luffs and loses drive fast;
 * over-sheeted it stalls, which costs less.
 */
export function trimEfficiency(sail: number, ideal: number): number {
  const d = sail - ideal
  const k = d > 0 ? d / 22 : d / 40
  return clamp(1 - k * k, 0, 1)
}

export interface Maneuver {
  /** Size of the turn, degrees. */
  turn: number
  tacked: boolean
  gybed: boolean
}

/** Turning by the shortest way from `from` to `to`: does the bow pass through the wind (tack) or the stern (gybe)? */
export function maneuver(from: number, to: number, windFrom: number): Maneuver {
  const delta = angleDiff(to, from)
  const r0 = angleDiff(from, windFrom)
  const r1 = r0 + delta
  const lo = Math.min(r0, r1)
  const hi = Math.max(r0, r1)
  const crosses = (k: number) => lo < k && k < hi
  return {
    turn: Math.abs(delta),
    tacked: crosses(0) || crosses(360) || crosses(-360),
    gybed: crosses(180) || crosses(-180),
  }
}

// ---- Boat handling, per second ------------------------------------------------------------------

/** Rate of turn, degrees per second: a boat steers with water flowing past the rudder. */
export const turnRate = (knots: number) => 3 + 9 * Math.min(1, knots / 5)
/** Speed lost to rudder drag, per radian turned. */
const RUDDER_DRAG = 0.08
/** Time constants (seconds) for speed to close on its target: picking up, slowing down, and stopping in irons. */
const TAU_UP = 20
const TAU_DOWN = 25
const TAU_IRONS = 9
/** A gybe: the boom slams across and the boat wobbles. */
const GYBE_LOSS = 0.94
/** Wind is sampled along the way every this many seconds; the path is recorded at the same interval. */
const SAMPLE = 5

export interface Move extends Maneuver {
  from: Pt
  /** Where the move ends, snapped to an intersection (before checking for land or other boats). */
  to: Pt
  /** The track sailed, every few seconds; the last point is `to`. */
  path: Pt[]
  heading: number
  sail: number
  /** Signed true wind angle at the end of the turn. */
  twa: number
  idealSail: number
  efficiency: number
  /** Polar speed × trim at the end of the turn: where the speed is heading. */
  target: number
  /** Lowest speed during the turn (a tack or a hard turn dips it). */
  carried: number
  /** Speed at the end of the turn. */
  speed: number
  /** Distance sailed through the water, cells. */
  distance: number
  /** Seconds spent turning onto the new heading. */
  turnSeconds: number
}

/**
 * One turn (a minute) of sailing, a second at a time. The boat turns onto the new heading at the rate its
 * speed allows, losing a little to rudder drag, while the crew trims through the turn. Inside the no-go
 * zone the sails give no drive and the boat glides to a stop, so a tack costs what it costs on the water.
 * Once on the new heading the sheet setting decides how much of the polar speed the sail delivers. Speed
 * always closes on its target gradually: boats carry their way.
 */
export function simulate(pos: Pt, boat: BoatMotion, plan: Plan, windAt: (p: Pt) => Wind, polar: Polar): Move {
  const heading = ((Math.round(plan.heading) % 360) + 360) % 360
  const sail = clamp(Math.round(plan.sail), 0, MAX_SAIL)
  const perSecond = CELLS_PER_KNOT / TURN_SECONDS
  let h = boat.heading
  let v = boat.speed
  let remaining = angleDiff(heading, h)
  const turnDir = Math.sign(remaining)
  let x = pos.x
  let y = pos.y
  let wind = windAt(pos)
  let prevTwa = twaOf(h, wind.from)
  let tacked = false
  let gybed = false
  let minV = v
  let distance = 0
  let turnSeconds = 0
  let dir = dirVec(h)
  let target = 0
  let efficiency = 1
  const path: Pt[] = [pos]
  for (let s = 0; s < TURN_SECONDS; s++) {
    if (s > 0 && s % SAMPLE === 0) {
      path.push({ x, y })
      wind = windAt({ x, y })
    }
    const turning = remaining !== 0
    if (turning) {
      const step = Math.min(Math.abs(remaining), turnRate(v))
      h += step * turnDir
      remaining -= step * turnDir
      if (Math.abs(remaining) < 1e-9) remaining = 0
      v *= 1 - RUDDER_DRAG * step * DEG
      dir = dirVec(h)
      turnSeconds++
    }
    const twa = twaOf(h, wind.from)
    if (Math.sign(twa) !== Math.sign(prevTwa) && twa !== 0 && prevTwa !== 0) {
      if (Math.abs(twa) < 90) tacked = true
      else {
        gybed = true
        v *= GYBE_LOSS
      }
    }
    prevTwa = twa
    // Through the turn the crew keeps the sails drawing; after it, the sheet is where the player set it.
    efficiency = turning ? 1 : trimEfficiency(sail, idealSail(twa))
    target = polar.speed(twa, wind.speed) * efficiency
    const tau = target >= v ? TAU_UP : target < 0.05 ? TAU_IRONS : TAU_DOWN
    v += (target - v) * (1 - Math.exp(-1 / tau))
    if (v < minV) minV = v
    x += dir.x * v * perSecond
    y += dir.y * v * perSecond
    distance += v * perSecond
  }
  const end = { x, y }
  const to = roundPt(end)
  path.push(to)
  const twa = twaOf(heading, wind.from)
  return {
    turn: Math.abs(angleDiff(heading, boat.heading)),
    tacked,
    gybed,
    from: pos,
    to,
    path,
    heading,
    sail,
    twa,
    idealSail: idealSail(twa),
    efficiency,
    target,
    carried: minV,
    speed: v,
    distance,
    turnSeconds,
  }
}

/** Length of a path, cells. */
export const pathLength = (path: Pt[]) => path.reduce((sum, p, i) => (i ? sum + dist(path[i - 1], p) : 0), 0)

/** A point along a path, by fraction of its points (they're evenly spaced in time). */
export function pathAt(path: Pt[], t: number): Pt {
  const n = path.length - 1
  if (n <= 0) return path[0]
  const k = clamp(t, 0, 1) * n
  const i = Math.min(n - 1, Math.floor(k))
  const f = k - i
  return add(path[i], scale({ x: path[i + 1].x - path[i].x, y: path[i + 1].y - path[i].y }, f))
}
