import { CELLS_PER_KNOT, type Plan, simulate, twaOf } from "./boat.ts"
import { bearing, clamp, cross, type Pt, pointSegment, samePt, segmentCross, sub } from "./geom.ts"
import { type GameMap, inBounds, landHit, mapSeed } from "./map.ts"
import { type BoatClass, boatClass } from "./fleet.ts"
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

/**
 * Which way each grid step crosses each course gate: per gate, one entry per (intersection, offset):
 * 0 = doesn't cross, 1 = crosses the right way, −1 = the wrong way. Gates don't move, so once per map.
 */
const gateCache = new WeakMap<GameMap, Int8Array[]>()
function gateCrossings(m: GameMap): Int8Array[] {
  let c = gateCache.get(m)
  if (c) return c
  const K = OFFSETS.length
  const edges = waterEdges(m)
  c = m.gates.map((gate) => {
    const t = new Int8Array(m.width * m.height * K)
    const dir = sub(gate.b, gate.a)
    for (let y = 0; y < m.height; y++)
      for (let x = 0; x < m.width; x++) {
        const u = y * m.width + x
        const bits = edges[u]
        if (!bits) continue
        for (let k = 0; k < K; k++) {
          if (!(bits & (1 << k))) continue
          const q = { x: x + OFFSETS[k].x, y: y + OFFSETS[k].y }
          const hit = segmentCross({ x, y }, q, gate.a, gate.b)
          if (!hit || hit.t <= 1e-9) continue
          t[u * K + k] = gate.sign === 0 || Math.sign(cross(dir, OFFSETS[k])) === gate.sign ? 1 : -1
        }
      }
    return t
  })
  gateCache.set(m, c)
  return c
}

const routeCache = new WeakMap<GameMap, Map<string, Route>>()

export function route(m: GameMap, turn: number, cls: BoatClass): Route {
  let perMap = routeCache.get(m)
  if (!perMap) routeCache.set(m, (perMap = new Map()))
  const key = `${cls.id}:${turn}`
  const hit = perMap.get(key)
  if (hit) return hit
  const r = computeRoute(m, turn, cls)
  perMap.set(key, r)
  if (perMap.size > 12) perMap.delete(perMap.keys().next().value!)
  return r
}

function computeRoute(m: GameMap, turn: number, cls: BoatClass): Route {
  const polar = cls.polar
  const field = windField(m, turn)
  const edges = waterEdges(m)
  const gates = gateCrossings(m)
  const N = m.width * m.height
  const G = m.gates.length
  const K = OFFSETS.length
  const W = m.width
  const time = new Float64Array(N * G).fill(Infinity)
  const heap = new Heap()
  // Time for every step in this turn's wind (Infinity where it's land or no-go).
  const steps = new Float64Array(N * K).fill(Infinity)
  for (let u = 0; u < N; u++) {
    const bits = edges[u]
    if (!bits) continue
    for (let k = 0; k < K; k++) {
      if (!(bits & (1 << k))) continue
      const s = polar.speed(OFFSET_BEARING[k] - field.from[u], field.speed[u]) * CELLS_PER_KNOT
      if (s >= 0.2) steps[u * K + k] = OFFSET_LEN[k] / s
    }
  }
  // Seeds: steps that cross the finish line, timed to where they cross it.
  const fin = m.gates[G - 1]
  const finish = gates[G - 1]
  for (let u = 0; u < N; u++)
    for (let k = 0; k < K; k++) {
      if (finish[u * K + k] === 0 || steps[u * K + k] === Infinity) continue
      const x = u % W
      const y = (u - x) / W
      const c = segmentCross({ x, y }, { x: x + OFFSETS[k].x, y: y + OFFSETS[k].y }, fin.a, fin.b)
      const t = steps[u * K + k] * (c?.t ?? 1)
      const s = (G - 1) * N + u
      if (t < time[s]) {
        time[s] = t
        heap.push(t, s)
      }
    }
  while (heap.size) {
    const [d, s] = heap.pop()
    if (d > time[s]) continue
    const layer = Math.floor(s / N)
    const v = s - layer * N
    const vx = v % W
    const vy = (v - vx) / W
    const here = gates[layer]
    const before = layer > 0 ? gates[layer - 1] : null
    // Crossing the ray of the mark just rounded back the wrong way un-rounds it: not a move within this layer.
    const undone = layer > 0 && m.gates[layer - 1].kind === "mark" ? before : null
    for (let k = 0; k < K; k++) {
      const ux = vx - OFFSETS[k].x
      const uy = vy - OFFSETS[k].y
      if (ux < 0 || uy < 0 || ux >= W || uy >= m.height) continue
      const e = (uy * W + ux) * K + k
      const step = steps[e]
      if (step === Infinity) continue
      const u = uy * W + ux
      // Same layer: the step mustn't touch this layer's gate, nor cross the previous mark's ray backwards.
      if (here[e] === 0 && !(undone && undone[e] === -1)) {
        const ps = layer * N + u
        if (d + step < time[ps]) {
          time[ps] = d + step
          heap.push(d + step, ps)
        }
      }
      // Previous layer: the step crosses the previous gate the right way.
      if (before && before[e] === 1) {
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
  /** Look two turns ahead, using the next turn's wind. */
  lookahead: boolean
  /** Chance of paying attention to other boats this turn. */
  rules: number
}

const SKILL: Record<Difficulty, Skill> = {
  easy: { headingStep: 10, headingNoise: 16, lookahead: false, rules: 0.35 },
  medium: { headingStep: 5, headingNoise: 6, lookahead: false, rules: 0.85 },
  hard: { headingStep: 2, headingNoise: 0, lookahead: true, rules: 1 },
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
  cls: BoatClass,
  pos: Pt,
  boat: { heading: number; speed: number; next: number; unwind: number },
  plan: Plan,
): Scored | null {
  const field = windField(m, turn)
  const wind = windAt(field, pos)
  const mv = simulate(pos, boat, plan, (p) => windAt(field, p), cls)
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
    const ref = Math.max(mv.target, cls.polar.speed(45, wind.speed) * 0.85)
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
export function chooseMove(m: GameMap, state: RaceState, boatId: number): Plan {
  const me = state.boats[boatId]
  const cls = boatClass(me.boat)
  const skill = SKILL[me.difficulty ?? "medium"]
  const rnd = mulberry32(hash(mapSeed(m.config), 77, state.turn, boatId))
  const r = route(m, state.turn, cls)
  const field = windField(m, state.turn)
  const wind = windAt(field, me.pos)
  // Where everyone else will be if they hold their course.
  const others = state.boats
    .filter((b) => b.id !== me.id && racing(b))
    .map((b) => ({ b, mv: simulate(b.pos, b, { heading: b.heading }, (p) => windAt(field, p), boatClass(b.boat)) }))

  const candidates: Scored[] = []
  const offset = Math.floor(rnd() * skill.headingStep)
  for (let h = offset; h < 360; h += skill.headingStep) {
    const plan = { heading: h }
    const s = evaluate(m, r, state.turn, cls, me.pos, me, plan)
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
    return { heading: ((heading % 360) + 360) % 360 }
  }

  const r2 = route(m, state.turn + 1, cls)
  let best = candidates[0]
  let bestScore = Infinity
  for (const c of candidates.slice(0, 8)) {
    if (c.next >= m.gates.length) return c.plan
    let second = Infinity
    for (let h = 0; h < 360; h += 5) {
      const plan = { heading: h }
      const s = evaluate(m, r2, state.turn + 1, cls, c.end, { heading: c.heading, speed: c.speed, next: c.next, unwind: 0 }, plan)
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
  return { heading }
}
