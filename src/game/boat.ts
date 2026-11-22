import { add, angleDiff, clamp, DEG, dirVec, dist, type Pt, roundPt, scale } from "./geom.ts"
import type { BoatClass } from "./fleet.ts"
import { CELLS_PER_KNOT, TURN_SECONDS } from "./units.ts"
import type { Wind } from "./wind.ts"

export { CELLS_PER_KNOT } from "./units.ts"

/** What a player decides each turn: the heading. The crew trims the sails. */
export interface Plan {
  /** Compass heading, degrees. */
  heading: number
}

export interface BoatMotion {
  heading: number
  speed: number
}

export type Tack = "starboard" | "port"

/** Signed true wind angle: positive when the wind comes over starboard. */
export const twaOf = (heading: number, windFrom: number) => angleDiff(windFrom, heading)

export const tackOf = (heading: number, windFrom: number): Tack =>
  twaOf(heading, windFrom) >= 0 ? "starboard" : "port"

/** Where the crew sets the boom for a true wind angle (for drawing): nearly centered close-hauled, squared out on a run. */
export const boomAngle = (twa: number) => clamp(Math.round((Math.abs(twa) - 25) * 0.55), 0, 85)

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
export const turnRate = (knots: number, atSpeed: number) => 3 + (atSpeed - 3) * Math.min(1, knots / 5)
/** Speed lost to rudder drag, per radian turned. */
const RUDDER_DRAG = 0.08
/** A gybe: the boom comes across and the boat wobbles. */
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
  /** Signed true wind angle at the end of the turn. */
  twa: number
  /** Polar speed at the end of the turn: where the speed is heading. */
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
 * speed allows, losing a little to rudder drag; the crew keeps the sails trimmed. Inside the no-go zone
 * the sails give no drive and the boat glides to a stop, so a tack costs what it costs on the water.
 * Speed always closes on the polar speed gradually, at the pace of the boat's class: boats carry their way.
 */
export function simulate(pos: Pt, boat: BoatMotion, plan: Plan, windAt: (p: Pt) => Wind, cls: BoatClass): Move {
  const heading = ((Math.round(plan.heading) % 360) + 360) % 360
  const { polar, handling } = cls
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
  const path: Pt[] = [pos]
  for (let s = 0; s < TURN_SECONDS; s++) {
    if (s > 0 && s % SAMPLE === 0) {
      path.push({ x, y })
      wind = windAt({ x, y })
    }
    const turning = remaining !== 0
    if (turning) {
      const step = Math.min(Math.abs(remaining), turnRate(v, handling.turnRate))
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
    target = polar.speed(twa, wind.speed)
    const tau = target >= v ? handling.tauUp : target < 0.05 ? handling.tauIrons : handling.tauDown
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
    twa,
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
