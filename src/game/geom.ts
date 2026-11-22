/**
 * Grid coordinates: x grows east, y grows south (row index), one unit per grid cell.
 * Directions are compass degrees: 0 = north (−y), 90 = east (+x).
 */

export interface Pt {
  x: number
  y: number
}

export const DEG = Math.PI / 180

export const norm360 = (a: number) => ((a % 360) + 360) % 360

/** Signed difference a − b in (−180, 180]. */
export const angleDiff = (a: number, b: number) => {
  const d = norm360(a - b)
  return d > 180 ? d - 360 : d
}

/** Unit vector pointing toward compass direction `deg`. */
export const dirVec = (deg: number): Pt => ({ x: Math.sin(deg * DEG), y: -Math.cos(deg * DEG) })

/** Compass bearing from `a` toward `b`. */
export const bearing = (a: Pt, b: Pt) => norm360(Math.atan2(b.x - a.x, -(b.y - a.y)) / DEG)

export const add = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y })
export const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y })
export const scale = (a: Pt, k: number): Pt => ({ x: a.x * k, y: a.y * k })
export const dot = (a: Pt, b: Pt) => a.x * b.x + a.y * b.y
export const cross = (a: Pt, b: Pt) => a.x * b.y - a.y * b.x
export const len = (a: Pt) => Math.hypot(a.x, a.y)
export const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y)
export const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
export const samePt = (a: Pt, b: Pt) => a.x === b.x && a.y === b.y
export const roundPt = (a: Pt): Pt => ({ x: Math.round(a.x), y: Math.round(a.y) })

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/**
 * Where segment p0→p1 crosses segment q0→q1: `t` along p, `u` along q (both in [0, 1]), or null.
 * Touching endpoints count as crossing at the boundary.
 */
export function segmentCross(p0: Pt, p1: Pt, q0: Pt, q1: Pt): { t: number; u: number } | null {
  const r = sub(p1, p0)
  const s = sub(q1, q0)
  const den = cross(r, s)
  if (Math.abs(den) < 1e-12) return null
  const qp = sub(q0, p0)
  const t = cross(qp, s) / den
  const u = cross(qp, r) / den
  if (t < 0 || t > 1 || u < 0 || u > 1) return null
  return { t, u }
}

/** Distance from point `c` to segment a→b, and the parameter of the closest point. */
export function pointSegment(c: Pt, a: Pt, b: Pt): { d: number; t: number } {
  const ab = sub(b, a)
  const l2 = dot(ab, ab)
  const t = l2 === 0 ? 0 : clamp(dot(sub(c, a), ab) / l2, 0, 1)
  return { d: dist(c, lerp(a, b, t)), t }
}

/**
 * Closest approach of two points moving linearly over the same time interval [0, 1]:
 * a goes a0→a1 while b goes b0→b1.
 */
export function closestApproach(a0: Pt, a1: Pt, b0: Pt, b1: Pt): { d: number; t: number } {
  const p = sub(a0, b0)
  const v = sub(sub(a1, a0), sub(b1, b0))
  const vv = dot(v, v)
  const t = vv === 0 ? 0 : clamp(-dot(p, v) / vv, 0, 1)
  return { d: len(add(p, scale(v, t))), t }
}
