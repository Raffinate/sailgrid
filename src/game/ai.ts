import { CELLS_PER_KNOT, idealSail, MAX_SAIL, type Plan, simulate, twaOf } from "./boat.ts"
import { bearing, clamp, cross, type Pt, pointSegment, samePt, segmentCross, sub } from "./geom.ts"
import { type GameMap, inBounds, landHit } from "./map.ts"
import type { Polar } from "./polar.ts"
import { type Boat, CONTACT, crossGatesPath, type Difficulty, pathApproach, type RaceState, racing, rightOfWay } from "./race.ts"
import { hash, mulberry32 } from "./rng.ts"
import { windAt, windField } from "./wind.ts"

/**
 * Time to finish, in turns, from every intersection and for every "next gate", assuming the boat
 * sails at polar speed in this turn's wind. A backward Dijkstra over (intersection, gates done):
 * an edge that crosses the next gate the right way moves on to the next layer; one that crosses it
 * the wrong way isn't allowed.
 */
export interface Route {
  turn: number
  n: number
  layers: number
  time: Float64Array
}

// Every grid step whose larger coordinate is at most 3 and that doesn't skip over an intersection.
const OFFSETS: Pt[] = (() => {
  const out: Pt[] = []
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b))
  for (let dy = -3; dy <= 3; dy++)
    for (let dx = -3; dx <= 3; dx++) if ((dx || dy) && gcd(Math.abs(dx), Math.abs(dy)) === 1) out.push({ x: dx, y: dy })
  return out
})()
const OFFSET_LEN = OFFSETS.map((o) => Math.hypot(o.x, o.y))
const OFFSET_BEARING = OFFSETS.map((o) => bearing({ x: 0, y: 0 }, o))

/** Which steps from each intersection stay in water: one bit per offset. */
const edgeCache = new WeakMap<GameMap, Uint32Array>()
function waterEdges(m: GameMap): Uint32Array {
  let e = edgeCache.get(m)
  if (e) return e
  e = new Uint32Array(m.width * m.height)
  for (let y = 0; y < m.height; y++)
    for (let x = 0; x < m.width; x++) {
      const i = y * m.width + x
      if (m.h[i] > 0) continue
      let bits = 0
      for (let k = 0; k < OFFSETS.length; k++) {
        const tx = x + OFFSETS[k].x
        const ty = y + OFFSETS[k].y
        if (!inBounds(m, tx, ty) || m.h[ty * m.width + tx] > 0) continue
        if (landHit(m, { x, y }, { x: tx, y: ty }) === null) bits |= 1 << k
      }
      e[i] = bits
    }
  edgeCache.set(m, e)
  return e
}

class Heap {
  private keys: number[] = []
  private vals: number[] = []
  get size() {
    return this.keys.length
  }
  push(k: number, v: number) {
    const keys = this.keys
    const vals = this.vals
    let i = keys.length
    keys.push(k)
    vals.push(v)
    while (i > 0) {
      const p = (i - 1) >> 1
      if (keys[p] <= k) break
      keys[i] = keys[p]
      vals[i] = vals[p]
      i = p
    }
    keys[i] = k
    vals[i] = v
  }
  pop(): [number, number] {
    const keys = this.keys
    const vals = this.vals
    const top: [number, number] = [keys[0], vals[0]]
    const k = keys.pop()!
    const v = vals.pop()!
    const n = keys.length
    if (n) {
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        if (l >= n) break
        const r = l + 1
        const c = r < n && keys[r] < keys[l] ? r : l
        if (keys[c] >= k) break
        keys[i] = keys[c]
        vals[i] = vals[c]
        i = c
      }
      keys[i] = k
      vals[i] = v
    }
    return top
  }
}

const routeCache = new WeakMap<GameMap, Map<number, Route>>()

export function route(m: GameMap, turn: number, polar: Polar): Route {
  let perMap = routeCache.get(m)
  if (!perMap) routeCache.set(m, (perMap = new Map()))
  const hit = perMap.get(turn)
  if (hit) return hit
  const r = computeRoute(m, turn, polar)
  perMap.set(turn, r)
  if (perMap.size > 4) perMap.delete(perMap.keys().next().value!)
  return r
}

function computeRoute(m: GameMap, turn: number, polar: Polar): Route {
  const field = windField(m, turn)
  const edges = waterEdges(m)
  const N = m.width * m.height
  const G = m.gates.length
  const time = new Float64Array(N * G).fill(Infinity)
  const heap = new Heap()
  const W = m.width
  const stepTime = (u: number, k: number) => {
    const s = polar.speed(OFFSET_BEARING[k] - field.from[u], field.speed[u]) * CELLS_PER_KNOT
    return s < 0.2 ? Infinity : OFFSET_LEN[k] / s
  }
  // Seeds: steps that cross the finish line.
  const fin = m.gates[G - 1]
  const lo = { x: Math.min(fin.a.x, fin.b.x) - 4, y: Math.min(fin.a.y, fin.b.y) - 4 }
  const hi = { x: Math.max(fin.a.x, fin.b.x) + 4, y: Math.max(fin.a.y, fin.b.y) + 4 }
  for (let y = Math.max(0, lo.y); y <= Math.min(m.height - 1, hi.y); y++)
    for (let x = Math.max(0, lo.x); x <= Math.min(W - 1, hi.x); x++) {
      const u = y * W + x
      const bits = edges[u]
      if (!bits) continue
      for (let k = 0; k < OFFSETS.length; k++) {
        if (!(bits & (1 << k))) continue
        const p = { x, y }
        const q = { x: x + OFFSETS[k].x, y: y + OFFSETS[k].y }
        const c = segmentCross(p, q, fin.a, fin.b)
        if (!c || c.t <= 1e-9) continue
        const t = stepTime(u, k) * c.t
        const s = (G - 1) * N + u
        if (t < time[s]) {
          time[s] = t
          heap.push(t, s)
        }
      }
    }
  // Does the step u→v cross gate g, and which way? 0 = no, 1 = the right way, −1 = the wrong way.
  const crossing = (g: number, ux: number, uy: number, vx: number, vy: number) => {
    const gate = m.gates[g]
    const p = { x: ux, y: uy }
    const q = { x: vx, y: vy }
    const c = segmentCross(p, q, gate.a, gate.b)
    if (!c || c.t <= 1e-9) return 0
    if (gate.sign === 0) return 1
    return Math.sign(cross(sub(gate.b, gate.a), sub(q, p))) === gate.sign ? 1 : -1
  }
  while (heap.size) {
    const [d, s] = heap.pop()
    if (d > time[s]) continue
    const layer = Math.floor(s / N)
    const v = s - layer * N
    const vx = v % W
    const vy = (v - vx) / W
    for (let k = 0; k < OFFSETS.length; k++) {
      const ux = vx - OFFSETS[k].x
      const uy = vy - OFFSETS[k].y
      if (ux < 0 || uy < 0 || ux >= W || uy >= m.height) continue
      const u = uy * W + ux
      if (!(edges[u] & (1 << k))) continue
      const step = stepTime(u, k)
      if (step === Infinity) continue
      // Same layer: the step mustn't touch this layer's gate.
      if (crossing(layer, ux, uy, vx, vy) === 0) {
        const ps = layer * N + u
        if (d + step < time[ps]) {
          time[ps] = d + step
          heap.push(d + step, ps)
        }
      }
      // Previous layer: the step crosses the previous gate the right way.
      if (layer > 0 && crossing(layer - 1, ux, uy, vx, vy) === 1) {
        const ps = (layer - 1) * N + u
        if (d + step < time[ps]) {
          time[ps] = d + step
          heap.push(d + step, ps)
        }
      }
    }
  }
  return { turn, n: N, layers: G, time }
}

export const timeToFinish = (r: Route, m: GameMap, next: number, p: Pt) =>
  next >= r.layers ? 0 : r.time[next * r.n + p.y * m.width + p.x]

interface Skill {
  headingStep: number
  /** Helming error: the chosen heading is off by up to this much, degrees. */
  headingNoise: number
  /** Trimming error, degrees of sheet. */
  sailNoise: number
  /** Look two turns ahead, using the next turn's wind. */
  lookahead: boolean
  /** Chance of paying attention to other boats this turn. */
  rules: number
}

const SKILL: Record<Difficulty, Skill> = {
  easy: { headingStep: 10, headingNoise: 12, sailNoise: 20, lookahead: false, rules: 0.35 },
  medium: { headingStep: 5, headingNoise: 4, sailNoise: 7, lookahead: false, rules: 0.85 },
  hard: { headingStep: 2, headingNoise: 0, sailNoise: 0, lookahead: true, rules: 1 },
}

interface Scored {
  plan: Plan
  score: number
  /** The part of the score that isn't route time: speed deficit, mark and traffic risk. */
  extra: number
  end: Pt
  path: Pt[]
  tacked: boolean
  next: number
  heading: number
  speed: number
}

function evaluate(
  m: GameMap,
  r: Route,
  turn: number,
  polar: Polar,
  pos: Pt,
  boat: { heading: number; speed: number; next: number; unwind: number },
  plan: Plan,
): Scored | null {
  const field = windField(m, turn)
  const wind = windAt(field, pos)
  const mv = simulate(pos, boat, plan, (p) => windAt(field, p), polar)
  for (let i = 1; i < mv.path.length; i++) if (landHit(m, mv.path[i - 1], mv.path[i]) !== null) return null
  const prog = crossGatesPath(m, boat.next, boat.unwind, mv.path)
  let base: number
  let extra = 0
  if (prog.finishedAt !== null) base = prog.finishedAt
  else {
    const t = timeToFinish(r, m, prog.next, mv.to)
    if (!Number.isFinite(t)) return null
    base = 1 + t
    // The route assumes full polar speed; a boat that's slower than it could be needs time to get there.
    // Compared with at least close-hauled speed, so pointing into the wind (no target at all) isn't free.
    const ref = Math.max(mv.target, polar.speed(45, wind.speed) * 0.85)
    if (ref > 0.5) extra += 1.2 * clamp((ref - mv.speed) / ref, 0, 1)
    if (samePt(mv.to, pos)) extra += 2
    if (prog.unwind > 0) extra += 20
  }
  for (const mark of m.marks)
    if (mv.path.some((q, i) => i > 0 && pointSegment(mark, mv.path[i - 1], q).d < 0.6)) {
      extra += 1.5
      break
    }
  return {
    plan,
    score: base + extra,
    extra,
    end: mv.to,
    path: mv.path,
    tacked: mv.tacked,
    next: prog.next,
    heading: mv.heading,
    speed: mv.speed,
  }
}

/** Pick this turn's heading and sheet for an AI boat. */
export function chooseMove(m: GameMap, state: RaceState, boatId: number, polar: Polar): Plan {
  const me = state.boats[boatId]
  const skill = SKILL[me.difficulty ?? "medium"]
  const rnd = mulberry32(hash(m.config.seed, 77, state.turn, boatId))
  const r = route(m, state.turn, polar)
  const field = windField(m, state.turn)
  const wind = windAt(field, me.pos)
  // Where everyone else will be if they hold their course.
  const others = state.boats
    .filter((b) => b.id !== me.id && racing(b))
    .map((b) => ({ b, mv: simulate(b.pos, b, { heading: b.heading, sail: b.sail }, (p) => windAt(field, p), polar) }))
  const sailFor = (heading: number) =>
    clamp(Math.round(idealSail(twaOf(heading, wind.from)) + (rnd() * 2 - 1) * skill.sailNoise), 0, MAX_SAIL)

  const candidates: Scored[] = []
  const offset = Math.floor(rnd() * skill.headingStep)
  for (let h = offset; h < 360; h += skill.headingStep) {
    const plan = { heading: h, sail: sailFor(h) }
    const s = evaluate(m, r, state.turn, polar, me.pos, me, plan)
    if (!s) continue
    if (rnd() < skill.rules) {
      const t = trafficCost(s, others, wind.from)
      s.score += t
      s.extra += t
    }
    candidates.push(s)
  }
  if (!candidates.length) return fallback(m, me, wind.from)
  candidates.sort((a, b) => a.score - b.score)
  if (!skill.lookahead) {
    const p = candidates[0].plan
    const heading = Math.round(p.heading + (rnd() * 2 - 1) * skill.headingNoise)
    return { heading: ((heading % 360) + 360) % 360, sail: p.sail }
  }

  const r2 = route(m, state.turn + 1, polar)
  let best = candidates[0]
  let bestScore = Infinity
  for (const c of candidates.slice(0, 8)) {
    if (c.next >= m.gates.length) return c.plan
    const w2 = windAt(windField(m, state.turn + 1), c.end)
    let second = Infinity
    for (let h = 0; h < 360; h += 5) {
      const plan = { heading: h, sail: idealSail(twaOf(h, w2.from)) }
      const s = evaluate(m, r2, state.turn + 1, polar, c.end, { heading: c.heading, speed: c.speed, next: c.next, unwind: 0 }, plan)
      if (s && s.score < second) second = s.score
    }
    const total = 1 + c.extra + second
    if (total < bestScore) {
      bestScore = total
      best = c
    }
  }
  return best.plan
}

/** Extra cost for a move that would foul another boat (or get too close to one we'd have to keep clear of). */
function trafficCost(s: Scored, others: { b: Boat; mv: { path: Pt[]; heading: number } }[], windFrom: number) {
  let cost = 0
  for (const o of others) {
    const ca = pathApproach(s.path, o.mv.path)
    if (ca.d >= CONTACT + 0.5) continue
    const rw = rightOfWay(
      { pos: s.path[0], heading: s.heading, tacked: s.tacked },
      { pos: o.b.pos, heading: o.mv.heading, tacked: false },
      windFrom,
    )
    cost += rw.fault.includes("a") ? 2.5 : 0.3
  }
  return cost
}

function fallback(m: GameMap, me: Boat, windFrom: number): Plan {
  const g = m.gates[Math.min(me.next, m.gates.length - 1)]
  const target = g.mark ?? { x: (g.a.x + g.b.x) / 2, y: (g.a.y + g.b.y) / 2 }
  let heading = Math.round(bearing(me.pos, target))
  const twa = twaOf(heading, windFrom)
  if (Math.abs(twa) < 45) heading = Math.round(windFrom - Math.sign(twa || 1) * 45)
  heading = ((heading % 360) + 360) % 360
  return { heading, sail: idealSail(twaOf(heading, windFrom)) }
}
