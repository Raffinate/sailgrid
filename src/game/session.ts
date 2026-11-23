import { chooseMove } from "./ai.ts"
import type { Plan } from "./boat.ts"
import { type BoatClassId, boatClass } from "./fleet.ts"
import { type GameMap, generateMap, type RaceConfig } from "./map.ts"
import { type GuestLink, type HostLink, host, inviteUrl, join } from "./multiplayer.ts"
import { type Entrant, newRace, type RaceState, racing, resolveTurn, retire } from "./race.ts"

/**
 * Runs a race for this device: local (solo, hot-seat, AI-only), hosting an online race, or joining one.
 *
 * Every boat moves at once, so a turn waits for a plan from every human still racing: local players
 * one after another (with a hand-over screen between them, so nobody sees the others' plans), and
 * remote players over the network. Then the AI boats choose and the turn is resolved. Online, the host
 * owns the race; guests send their own plans and render the state the host sends back.
 */

export type Mode = "local" | "host" | "guest"
export type Phase = "setup" | "lobby" | "racing"

export type Message =
  | { type: "hello"; name: string; boat: BoatClassId }
  /** A guest in the lobby changes their name or boat, or says they're ready (or not, to change again). */
  | { type: "sailor"; name: string; boat: BoatClassId; ready: boolean }
  | { type: "lobby"; config: RaceConfig; entrants: Entrant[]; you: number }
  | { type: "race"; config: RaceConfig; state: RaceState; you: number; planned: number[] }
  | { type: "plan"; turn: number; plan: Plan }

export interface Snapshot {
  mode: Mode
  phase: Phase
  config: RaceConfig | null
  map: GameMap | null
  state: RaceState | null
  /** The state before the last turn, to animate the moves. */
  prev: RaceState | null
  entrants: Entrant[]
  /** Boats steered from this device. */
  mine: number[]
  /** The boat whose helm is up now. */
  active: number | null
  /** Hot-seat: the next player has to take the helm before their controls show. */
  handoff: boolean
  /** Boats whose plan for this turn is in (never what the plan is). */
  planned: number[]
  resolving: boolean
  /** With no humans left to wait for, turns run by themselves. */
  autoplay: boolean
  inviteUrl: string | null
  status: string
  error: string | null
}

export const BOAT_COLORS = ["#e11d48", "#2563eb", "#16a34a", "#d97706", "#7c3aed", "#0891b2", "#db2777", "#57534e"]
export const MAX_BOATS = BOAT_COLORS.length
export const MAX_NAME = 20

const cleanName = (name: string) => name.trim().slice(0, MAX_NAME) || "Guest"

/** Online sailors who haven't said they're ready yet; the host can start once there are none. */
export const notReady = (entrants: Entrant[]) => entrants.filter((e) => e.controller === "remote" && !e.ready)

export const IDLE_SNAPSHOT: Snapshot = {
  mode: "local",
  phase: "setup",
  config: null,
  map: null,
  state: null,
  prev: null,
  entrants: [],
  mine: [],
  active: null,
  handoff: false,
  planned: [],
  resolving: false,
  autoplay: true,
  inviteUrl: null,
  status: "",
  error: null,
}

const AUTOPLAY_MS = 450

export class Session {
  private snap: Snapshot = IDLE_SNAPSHOT
  private plans = new Map<number, Plan>()
  private hostLink: HostLink | null = null
  private guestLink: GuestLink | null = null
  /** Host: which boat each connected guest steers. */
  private peerBoat = new Map<string, number>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private generation = 0

  constructor(private readonly onChange: (s: Snapshot) => void) {}

  get snapshot() {
    return this.snap
  }

  private emit(patch: Partial<Snapshot>) {
    this.snap = { ...this.snap, ...patch }
    this.onChange(this.snap)
  }

  private clearTimer() {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }

  /** Back to setup, dropping any connection. */
  stop() {
    this.generation++
    this.clearTimer()
    this.hostLink?.close()
    this.guestLink?.close()
    this.hostLink = null
    this.guestLink = null
    this.peerBoat.clear()
    this.plans.clear()
    this.snap = IDLE_SNAPSHOT
    this.onChange(this.snap)
  }

  // ---- Local races -------------------------------------------------------------------------------

  startLocal(config: RaceConfig, entrants: Entrant[]) {
    this.stop()
    this.begin("local", config, entrants)
  }

  private begin(mode: Mode, config: RaceConfig, lobby: Entrant[]) {
    const entrants = lobby.map(({ ready: _, ...e }) => e)
    const map = generateMap(config)
    const state = newRace(map, entrants)
    this.emit({
      mode,
      phase: "racing",
      config,
      map,
      state,
      prev: null,
      entrants,
      mine: state.boats.filter((b) => b.controller === "human").map((b) => b.id),
      error: null,
      status: "",
    })
    this.beginTurn()
  }

  private waitingFor(state: RaceState) {
    return state.boats.filter((b) => racing(b) && (b.controller === "human" || b.controller === "remote")).map((b) => b.id)
  }

  private localTurnOrder(state: RaceState) {
    return state.boats.filter((b) => racing(b) && b.controller === "human").map((b) => b.id)
  }

  private beginTurn() {
    const state = this.snap.state
    if (!state) return
    this.plans.clear()
    const humans = this.localTurnOrder(state)
    this.emit({ active: state.over ? null : (humans[0] ?? null), handoff: false, planned: [], resolving: false })
    this.broadcastRace()
    this.maybeResolve()
  }

  /** A plan for one of this device's boats. */
  submit(boatId: number, plan: Plan) {
    const s = this.snap
    if (s.phase !== "racing" || !s.state || s.state.over || s.resolving) return
    if (s.mode === "guest") {
      this.guestLink?.send({ type: "plan", turn: s.state.turn, plan })
      this.emit({ planned: [...new Set([...s.planned, boatId])], active: null })
      return
    }
    this.plans.set(boatId, plan)
    const next = this.localTurnOrder(s.state).find((id) => !this.plans.has(id)) ?? null
    this.emit({ planned: [...this.plans.keys()], active: next, handoff: next !== null })
    this.broadcastRace()
    this.maybeResolve()
  }

  /** Hot-seat: the next player is at the screen. */
  takeHelm() {
    this.emit({ handoff: false })
  }

  setAutoplay(on: boolean) {
    this.emit({ autoplay: on })
    this.clearTimer()
    this.maybeResolve()
  }

  /** Spectating: run one turn now. */
  step() {
    const s = this.snap
    if (s.mode === "guest" || !s.state || s.state.over || s.resolving) return
    if (this.waitingFor(s.state).some((id) => !this.plans.has(id))) return
    this.clearTimer()
    this.resolve()
  }

  private maybeResolve() {
    const s = this.snap
    if (s.mode === "guest" || s.phase !== "racing" || !s.state || s.state.over || s.resolving) return
    const waiting = this.waitingFor(s.state)
    if (waiting.some((id) => !this.plans.has(id))) return
    if (waiting.length === 0) {
      // Nobody to wait for: AI-only from here on.
      if (s.autoplay && this.timer === null) this.timer = setTimeout(() => ((this.timer = null), this.resolve()), AUTOPLAY_MS)
      return
    }
    this.resolve()
  }

  private resolve() {
    const s = this.snap
    if (!s.state || !s.map || s.state.over) return
    this.emit({ resolving: true, active: null })
    const gen = this.generation
    // Let the "resolving" state paint before the AI thinks.
    setTimeout(() => {
      if (gen !== this.generation || !this.snap.state || !this.snap.map) return
      const state = this.snap.state
      const map = this.snap.map
      for (const b of state.boats) if (racing(b) && b.controller === "ai") this.plans.set(b.id, chooseMove(map, state, b.id))
      const next = resolveTurn(map, state, this.plans)
      this.emit({ prev: state, state: next, resolving: false })
      this.beginTurn()
    }, 20)
  }

  // ---- Hosting -----------------------------------------------------------------------------------

  private remoteEntrants() {
    return this.snap.entrants.filter((e) => e.controller === "remote")
  }

  /** Open a lobby others can join, with this device's own players already in it. */
  async hostLobby(config: RaceConfig, entrants: Entrant[]) {
    this.stop()
    const gen = this.generation
    this.emit({ mode: "host", phase: "lobby", config, entrants, status: "Setting up the connection…" })
    try {
      const link = await host({
        onId: (id) => this.emit({ inviteUrl: inviteUrl(id), status: "Waiting for sailors to join." }),
        onJoin: () => {},
        onMessage: (peer, msg) => this.hostReceive(peer, msg),
        onLeave: (peer) => this.peerLeft(peer),
        onError: (e) => this.emit({ error: `Connection problem (${e}).` }),
      })
      if (gen !== this.generation) return link.close()
      this.hostLink = link
    } catch {
      if (gen === this.generation) this.emit({ error: "Couldn't start online play. Check your connection and try again." })
    }
  }

  /** Host: change the course or this device's players while still in the lobby. */
  updateLobby(config: RaceConfig, entrants: Entrant[]) {
    if (this.snap.mode !== "host" || this.snap.phase !== "lobby") return
    // A different race may call for a different boat: everyone online confirms again.
    const changed = JSON.stringify(config) !== JSON.stringify(this.snap.config)
    const remote = this.remoteEntrants().map((e) => (changed ? { ...e, ready: false } : e))
    this.setEntrants(config, [...entrants, ...remote])
  }

  private setEntrants(config: RaceConfig, entrants: Entrant[]) {
    // Remote sailors keep their colors distinct from the local ones.
    const used = new Set(entrants.filter((e) => e.controller !== "remote").map((e) => e.color))
    const free = BOAT_COLORS.filter((c) => !used.has(c))
    let k = 0
    const fixed = entrants.map((e) => (e.controller === "remote" ? { ...e, color: free[k++ % free.length] } : e))
    this.peerBoat.clear()
    fixed.forEach((e, i) => e.peer && this.peerBoat.set(e.peer, i))
    this.emit({ config, entrants: fixed })
    for (const [peer, you] of this.peerBoat) this.hostLink?.sendTo(peer, { type: "lobby", config, entrants: fixed, you })
  }

  private hostReceive(peer: string, msg: Message) {
    const s = this.snap
    if (msg.type === "hello") {
      if (s.phase !== "lobby" || !s.config) return
      if (s.entrants.length >= MAX_BOATS) return
      const sailor: Entrant = { name: cleanName(msg.name), color: "", controller: "remote", peer, boat: boatClass(msg.boat).id, ready: false }
      // The lobby list (with who's still choosing) says the rest.
      if (s.status) this.emit({ status: "" })
      this.setEntrants(s.config, [...s.entrants, sailor])
      return
    }
    if (msg.type === "sailor") {
      if (s.phase !== "lobby" || !s.config || !this.peerBoat.has(peer)) return
      const patch = { name: cleanName(msg.name), boat: boatClass(msg.boat).id, ready: msg.ready === true }
      this.setEntrants(
        s.config,
        s.entrants.map((e) => (e.peer === peer ? { ...e, ...patch } : e)),
      )
      return
    }
    if (msg.type === "plan") {
      const id = this.peerBoat.get(peer)
      if (id === undefined || s.phase !== "racing" || !s.state || s.resolving) return
      if (msg.turn !== s.state.turn || !racing(s.state.boats[id])) return
      this.plans.set(id, msg.plan)
      this.emit({ planned: [...this.plans.keys()] })
      this.broadcastRace()
      this.maybeResolve()
    }
  }

  private peerLeft(peer: string) {
    const s = this.snap
    const id = this.peerBoat.get(peer)
    if (id === undefined) return
    if (s.phase === "lobby" && s.config) {
      this.setEntrants(
        s.config,
        s.entrants.filter((e) => e.peer !== peer),
      )
      return
    }
    if (s.state) {
      this.peerBoat.delete(peer)
      this.emit({ state: retire(s.state, id), status: `${s.state.boats[id].name} left the race.` })
      this.broadcastRace()
      this.maybeResolve()
    }
  }

  /** Host: go, once every online sailor is ready. */
  startHosted() {
    const s = this.snap
    if (s.mode !== "host" || s.phase !== "lobby" || !s.config || notReady(s.entrants).length) return
    this.begin("host", s.config, s.entrants)
    this.emit({ status: "" })
  }

  private broadcastRace() {
    const s = this.snap
    if (s.mode !== "host" || !this.hostLink || !s.state || !s.config) return
    for (const [peer, you] of this.peerBoat)
      this.hostLink.sendTo(peer, { type: "race", config: s.config, state: s.state, you, planned: [...this.plans.keys()] })
  }

  // ---- Joining -----------------------------------------------------------------------------------

  async join(hostId: string, name: string, boat: BoatClassId) {
    this.stop()
    const gen = this.generation
    this.emit({ mode: "guest", phase: "lobby", status: "Connecting to the host…" })
    try {
      const link = await join(hostId, {
        onOpen: () => {
          this.guestLink?.send({ type: "hello", name, boat })
          this.emit({ status: "" })
        },
        onMessage: (msg) => this.guestReceive(msg),
        onClose: () => this.emit({ error: "The host left the race.", active: null }),
        onError: (e) =>
          this.emit({ error: e === "peer-unavailable" ? "That race isn't open any more." : `Connection problem (${e}).` }),
      })
      if (gen !== this.generation) return link.close()
      this.guestLink = link
    } catch {
      if (gen === this.generation) this.emit({ error: "Couldn't connect. Check the link and try again." })
    }
  }

  /** Guest, in the lobby: this device's name and boat, and whether it's ready to start. */
  setSailor(name: string, boat: BoatClassId, ready: boolean) {
    const s = this.snap
    if (s.mode !== "guest" || s.phase !== "lobby" || !s.mine.length) return
    this.guestLink?.send({ type: "sailor", name, boat, ready })
    if (s.status) this.emit({ status: "" })
  }

  private guestReceive(msg: Message) {
    const s = this.snap
    if (msg.type === "lobby") {
      const was = s.mine.length ? s.entrants[s.mine[0]] : undefined
      const now = msg.entrants[msg.you]
      const reset = was?.ready && !now?.ready && JSON.stringify(s.config) !== JSON.stringify(msg.config)
      this.emit({
        config: msg.config,
        entrants: msg.entrants,
        mine: [msg.you],
        ...(reset ? { status: "The host changed the race. Check your boat, then confirm again." } : {}),
      })
      return
    }
    if (msg.type !== "race") return
    const sameMap = s.map && s.config && JSON.stringify(s.config) === JSON.stringify(msg.config)
    const map = sameMap ? s.map! : generateMap(msg.config)
    const newTurn = !s.state || s.state.turn !== msg.state.turn
    const me = msg.state.boats[msg.you]
    const planned = msg.planned
    this.emit({
      phase: "racing",
      config: msg.config,
      map,
      state: msg.state,
      prev: newTurn ? s.state : s.prev,
      entrants: msg.state.boats,
      mine: [msg.you],
      planned,
      active: me && racing(me) && !msg.state.over && !planned.includes(msg.you) ? msg.you : null,
      status: "",
    })
  }
}
