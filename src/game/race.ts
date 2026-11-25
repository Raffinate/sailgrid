import { type Move, type Plan, pathAt, simulate, tackOf } from "./boat.ts"
import { closestApproach, cross, dirVec, dist, dot, lerp, pointSegment, type Pt, roundPt, samePt, segmentCross, sub } from "./geom.ts"
import { type GameMap, isWater, landHit, startingPositions } from "./map.ts"
import { type BoatClassId, boatClass } from "./fleet.ts"
import { type Rng } from "./rng.ts"
import { windAt, windField } from "./wind.ts"

export type Controller = "human" | "ai" | "remote"
export type Difficulty = "easy" | "medium" | "hard"

export interface Entrant {
  name: string
  color: string
  controller: Controller
  difficulty?: Difficulty
  /** Which kind of boat. */
  boat: BoatClassId
  /** Remote players: the connection that steers this boat. */
  peer?: string
  /** Online lobby: a remote player has settled on a name and boat and is ready to start. */
  ready?: boolean
}

export interface Boat extends Entrant {
  id: number
  pos: Pt
  heading: number
  speed: number
  /** Position at the end of every turn so far, starting position first. */
  track: Pt[]
  /** Index of the next gate (start, marks, finish) to cross. */
  next: number
  /** Wrong-way crossings of the next gate still to undo before it counts. */
  unwind: number
  /** Elapsed time when crossing the finish, in turns (fractional); null while racing. */
  finish: number | null
  /** Accumulated time penalties, turns. */
  penalty: number
  /** The path sailed last turn (a curve when the boat turned), for drawing the move. */
  wake?: Pt[]
}

/** Racing Rules of Sailing references, simplified. */
export type Rule = "10" | "11" | "12" | "13" | "31" | "aground"

export const RULE_TEXT: Record<Rule, string> = {
  "10": "Port tack keeps clear of starboard tack",
  "11": "Windward boat keeps clear (overlapped, same tack)",
  "12": "Boat clear astern keeps clear",
  "13": "A tacking boat keeps clear",
  "31": "Touched a mark",
  aground: "Ran aground",
}

/** Time penalties, in turns: the two-turns penalty for a right-of-way foul, one turn for a mark or the shore. */
export const PENALTY: Record<Rule, number> = { "10": 2, "11": 2, "12": 2, "13": 2, "31": 1, aground: 1 }

export interface Incident {
  turn: number
  boat: number
  other?: number
  rule: Rule
  penalty: number
}

export interface RaceState {
  turn: number
  boats: Boat[]
  incidents: Incident[]
  over: boolean
  maxTurns: number
}

/** Boats closer than this (cells) during a turn have collided, or at least come too close. */
export const CONTACT = 0.8
const MARK_TOUCH = 0.35
const OVERLAP = 0.8

/** A new race, with the boats lined up along the start line in a random order (`rnd` picks it). */
export function newRace(map: GameMap, entrants: Entrant[], maxTurns = 400, rnd: Rng = Math.random): RaceState {
  const spots = startingPositions(map, entrants.length)
  for (let i = spots.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1))
    ;[spots[i], spots[j]] = [spots[j], spots[i]]
  }
  return {
    turn: 0,
    maxTurns,
    over: false,
    incidents: [],
    boats: entrants.map((e, id) => {
      return {
        ...e,
        id,
        pos: spots[id].pos,
        heading: spots[id].heading,
        speed: map.windSpeed * 0.25,
        track: [spots[id].pos],
        next: 0,
        unwind: 0,
        finish: null,
        penalty: 0,
      }
    }),
  }
}

export const racing = (b: Boat) => b.finish === null && b.next >= 0

export interface Progress {
  next: number
  unwind: number
  /** Fraction of the move at which the boat finished, if it did. */
  finishedAt: number | null
}

/**
 * Advance through the course gates crossed by the move from → to. A mark counts once the boat crosses its
 * rounding ray the right way; crossing the ray of the mark just rounded back the wrong way un-rounds it,
 * so a boat can't touch the ray and turn back.
 */
export function crossGates(map: GameMap, next: number, unwind: number, from: Pt, to: Pt): Progress {
  let t0 = 0
  const move = sub(to, from)
  for (let guard = 0; guard < 8 && next < map.gates.length; guard++) {
    const p0 = lerp(from, to, t0)
    const g = map.gates[next]
    const s = Math.sign(cross(sub(g.b, g.a), move))
    const c = segmentCross(p0, to, g.a, g.b)
    const back = next > 0 && unwind === 0 ? map.gates[next - 1] : null
    const cb =
      back?.kind === "mark" && Math.sign(cross(sub(back.b, back.a), move)) !== back.sign
        ? segmentCross(p0, to, back.a, back.b)
        : null
    const undo = cb !== null && (c === null || cb.t < c.t)
    const hit = undo ? cb : c
    if (!hit) break
    const tAbs = t0 + (1 - t0) * hit.t
    if (tAbs <= 1e-9) {
      t0 = 1e-6
      continue
    }
    if (undo) next--
    else if (g.sign === 0 || s === g.sign) {
      if (unwind > 0) unwind--
      else {
        next++
        if (g.kind === "finish") return { next, unwind: 0, finishedAt: tAbs }
      }
    } else if (g.kind !== "start") unwind++
    // Back over the start line the wrong way is a boat that slipped round its end returning to the
    // pre-start side, where it belongs: nothing to undo, its next crossing starts it.
    t0 = tAbs + 1e-6
    if (t0 >= 1) break
  }
  return { next, unwind, finishedAt: null }
}

/** Advance through the gates crossed along a path whose points are evenly spaced in time. */
export function crossGatesPath(map: GameMap, next: number, unwind: number, path: Pt[]): Progress {
  const n = path.length - 1
  for (let i = 0; i < n; i++) {
    const p = crossGates(map, next, unwind, path[i], path[i + 1])
    if (p.finishedAt !== null) return { ...p, finishedAt: (i + p.finishedAt) / n }
    next = p.next
    unwind = p.unwind
  }
  return { next, unwind, finishedAt: null }
}

export interface Sailed {
  /** The path actually sailed: cut short at the shore if the boat ran aground. */
  path: Pt[]
  end: Pt
  aground: boolean
}

/** Follow a move's path; if it runs into land, stop at the last free intersection before the shore. */
export function sail(map: GameMap, path: Pt[]): Sailed {
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i]
    const b = path[i + 1]
    const hit = landHit(map, a, b)
    if (hit === null) continue
    const n = Math.ceil(dist(a, b) * 4)
    for (let k = Math.floor(hit * n); k >= 0; k--) {
      const p = roundPt(lerp(a, b, k / n))
      if (isWater(map, p) && landHit(map, a, p) === null) return { path: [...path.slice(0, i + 1), p], end: p, aground: true }
    }
    // Nothing free on this stretch: back to the last point that was.
    for (let j = i; j >= 0; j--) {
      const p = roundPt(path[j])
      if (isWater(map, p) && (j === 0 || landHit(map, path[j], p) === null)) return { path: [...path.slice(0, j + 1), p], end: p, aground: true }
    }
    return { path: [path[0]], end: path[0], aground: true }
  }
  return { path, end: path[path.length - 1], aground: false }
}

const touchesMark = (map: GameMap, path: Pt[]) =>
  map.marks.some((mk) => path.some((p, i) => i > 0 && pointSegment(mk, path[i - 1], p).d < MARK_TOUCH))

/** Closest approach of two boats sailing their paths at the same time (points every few seconds). */
export function pathApproach(a: Pt[], b: Pt[]): { d: number; t: number } {
  const n = Math.max(a.length, b.length) - 1
  const at = (p: Pt[], i: number) => p[Math.min(i, p.length - 1)]
  let best = { d: Infinity, t: 0 }
  if (n <= 0) return { d: dist(a[0], b[0]), t: 0 }
  for (let i = 0; i < n; i++) {
    const c = closestApproach(at(a, i), at(a, i + 1), at(b, i), at(b, i + 1))
    if (c.d < best.d) best = { d: c.d, t: (i + c.t) / n }
  }
  return best
}

export interface ResolvedMove extends Move {
  boat: number
  /** Where the boat actually ended up (after grounding or giving way). */
  end: Pt
  aground: boolean
}

/** Who has to keep clear when a and b meet. Returns the boats at fault and the rule. */
export function rightOfWay(
  a: { pos: Pt; heading: number; tacked: boolean },
  b: { pos: Pt; heading: number; tacked: boolean },
  windFrom: number,
): { fault: ("a" | "b")[]; rule: Rule } {
  if (a.tacked || b.tacked) return { fault: [...(a.tacked ? ["a" as const] : []), ...(b.tacked ? ["b" as const] : [])], rule: "13" }
  const ta = tackOf(a.heading, windFrom)
  const tb = tackOf(b.heading, windFrom)
  if (ta !== tb) return { fault: [ta === "port" ? "a" : "b"], rule: "10" }
  const aAstern = dot(sub(a.pos, b.pos), dirVec(b.heading)) < -OVERLAP
  const bAstern = dot(sub(b.pos, a.pos), dirVec(a.heading)) < -OVERLAP
  if (aAstern !== bAstern) return { fault: [aAstern ? "a" : "b"], rule: "12" }
  const up = dirVec(windFrom)
  return { fault: [dot(a.pos, up) > dot(b.pos, up) ? "a" : "b"], rule: "11" }
}

/** All boats move at once; then fouls, groundings and course progress are scored. */
export function resolveTurn(map: GameMap, state: RaceState, plans: Map<number, Plan>): RaceState {
  const turn = state.turn
  const field = windField(map, turn)
  const incidents: Incident[] = []
  const boats = state.boats.map((b) => ({ ...b, track: [...b.track] }))
  const moves = new Map<number, ResolvedMove>()

  const windHere = (p: Pt) => windAt(field, p)
  for (const b of boats) {
    if (!racing(b)) continue
    const plan = plans.get(b.id) ?? { heading: b.heading }
    const m = simulate(b.pos, b, plan, windHere, boatClass(b.boat))
    const sailed = sail(map, m.path)
    if (sailed.aground) incidents.push({ turn, boat: b.id, rule: "aground", penalty: PENALTY.aground })
    moves.set(b.id, { ...m, path: sailed.path, boat: b.id, end: sailed.end, aground: sailed.aground, speed: sailed.aground ? 0 : m.speed })
  }

  // Marks: passing too close is a touch.
  for (const m of moves.values())
    if (touchesMark(map, m.path)) incidents.push({ turn, boat: m.boat, rule: "31", penalty: PENALTY["31"] })

  // Boat against boat.
  const list = [...moves.values()]
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i]
      const b = list[j]
      const ca = pathApproach(a.path, b.path)
      const sameSpot = samePt(a.end, b.end)
      if (ca.d >= CONTACT && !sameSpot) continue
      const pa = pathAt(a.path, ca.t)
      const pb = pathAt(b.path, ca.t)
      const windFrom = windAt(field, lerp(pa, pb, 0.5)).from
      const r = rightOfWay(
        { pos: pa, heading: a.heading, tacked: a.tacked },
        { pos: pb, heading: b.heading, tacked: b.tacked },
        windFrom,
      )
      for (const f of r.fault) {
        const me = f === "a" ? a : b
        const them = f === "a" ? b : a
        incidents.push({ turn, boat: me.boat, other: them.boat, rule: r.rule, penalty: PENALTY[r.rule] })
      }
      if (sameSpot) {
        // The boat that had to keep clear backs off to the nearest free spot along its own path, losing way.
        const loser = r.fault[0] === "a" ? a : b
        const taken = (p: Pt) => list.some((o) => o !== loser && samePt(o.end, p)) || boats.some((o) => !racing(o) && samePt(o.pos, p))
        const n = Math.ceil(dist(loser.from, loser.end) * 4)
        let spot = loser.from
        for (let k = n - 1; k >= 0; k--) {
          const p = roundPt(lerp(loser.from, loser.end, k / n))
          if (isWater(map, p) && !taken(p)) {
            spot = p
            break
          }
        }
        loser.end = spot
        loser.path = [...loser.path.slice(0, -1), spot]
        loser.speed *= 0.5
      }
    }

  for (const b of boats) {
    const m = moves.get(b.id)
    if (!m) continue
    const prog = crossGatesPath(map, b.next, b.unwind, m.path)
    b.pos = m.end
    b.wake = m.path.map((p) => ({ x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 }))
    b.heading = m.heading
    b.speed = m.speed
    b.next = prog.next
    b.unwind = prog.unwind
    b.track.push(m.end)
    if (prog.finishedAt !== null) b.finish = turn + prog.finishedAt
  }
  for (const inc of incidents) boats[inc.boat].penalty += inc.penalty

  const nextTurn = turn + 1
  return {
    ...state,
    turn: nextTurn,
    boats,
    incidents: [...state.incidents, ...incidents],
    over: boats.every((b) => !racing(b)) || nextTurn >= state.maxTurns,
  }
}

/** Race time: elapsed time plus penalties. No handicap: the boat choice is part of the game. */
export const raceTime = (b: Boat) => (b.finish === null ? null : b.finish + b.penalty)

/** Finishers by race time, then everyone else by progress. */
export function standings(state: RaceState): Boat[] {
  return [...state.boats].sort((a, b) => {
    const ca = raceTime(a)
    const cb = raceTime(b)
    if (ca !== null && cb !== null) return ca - cb
    if (ca !== null) return -1
    if (cb !== null) return 1
    return b.next - a.next || a.penalty - b.penalty
  })
}

/** Drop a boat whose player left: it stops where it is and won't be ranked as a finisher. */
export function retire(state: RaceState, id: number): RaceState {
  const boats = state.boats.map((b) => (b.id === id && racing(b) ? { ...b, next: -1 } : b))
  return { ...state, boats, over: state.over || boats.every((b) => !racing(b)) }
}

export const isRetired = (b: Boat) => b.next < 0

export interface PlanPreview {
  move: Move
  /** Where the boat stops (short of the shore if the move runs aground). */
  stop: Pt
  aground: boolean
  touchesMark: boolean
  /** Gate the boat will be heading for after this move. */
  next: number
  finishes: boolean
}

/** What a plan would do if nobody else were around: the same physics the turn uses. */
export function previewPlan(map: GameMap, state: RaceState, boatId: number, plan: Plan): PlanPreview {
  const b = state.boats[boatId]
  const field = windField(map, state.turn)
  const move = simulate(b.pos, b, plan, (p) => windAt(field, p), boatClass(b.boat))
  const sailed = sail(map, move.path)
  const prog = crossGatesPath(map, b.next, b.unwind, sailed.path)
  return {
    move: { ...move, path: sailed.path },
    stop: sailed.end,
    aground: sailed.aground,
    touchesMark: touchesMark(map, sailed.path),
    next: prog.next,
    finishes: prog.finishedAt !== null,
  }
}
