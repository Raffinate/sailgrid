import { chooseMove } from "./ai.ts"
import type { Plan } from "./boat.ts"
import { type BoatClassId, boatClass } from "./fleet.ts"
import { type GameMap, generateMap, type RaceConfig } from "./map.ts"
import { type GuestLink, type HostLink, host, inviteUrl, join } from "./multiplayer.ts"
import { type Entrant, newRace, type RaceState, racing, resolveTurn, retire, setAway } from "./race.ts"

/**
 * Runs a race for this device: local (solo, hot-seat, AI-only), hosting an online race, or joining one.
 *
 * Every boat moves at once, so a turn waits for a plan from every human still racing: local players
 * one after another (with a hand-over screen between them, so nobody sees the others' plans), and
 * remote players over the network. Then the AI boats choose and the turn is resolved. Online, the host
 * owns the race; guests send their own plans and render the state the host sends back.
 *
 * A guest whose connection drops (or who keeps everyone waiting, if the host says so) is "away": the AI
 * sails their boat until they reconnect, which they do with a seat key they sent when they joined.
 */

export type Mode = "local" | "host" | "guest"
export type Phase = "setup" | "lobby" | "racing"

export type Message =
  /** A guest arrives, or comes back mid-race: `seat` is this device's key to its boat in this race. */
  | { type: "hello"; name: string; boat: BoatClassId; seat?: string }
  /** A guest leaves the race for good: the host retires their boat. */
  | { type: "leave" }
  /** The race has started without this guest. */
  | { type: "late" }
  /** A guest in the lobby changes their name or boat, or says they're ready (or not, to change again). */
  | { type: "sailor"; name: string; boat: BoatClassId; ready: boolean }
  | { type: "lobby"; config: RaceConfig; entrants: Entrant[]; you: number }
  /** The host took this guest out of the lobby. */
  | { type: "removed" }
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
  /** Host: lost the PeerJS server (reconnecting). The race goes on; nobody new can join meanwhile. */
  serverLost: boolean
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
  serverLost: false,
}

const AUTOPLAY_MS = 450
/** Guest: tries to get back to the host after the connection drops, waiting 1, 2, 4… seconds between them. */
const RECONNECT_TRIES = 5

/** This device's key to its boat in the race hosted at `hostId`: kept, so reopening the invite link gets the boat back. */
function seatFor(hostId: string) {
  const key = `sailgrid-seat:${hostId}`
  try {
    const seat = localStorage.getItem(key) ?? crypto.randomUUID()
    localStorage.setItem(key, seat)
    return seat
  } catch {
    return crypto.randomUUID()
  }
}

export class Session {
  private snap: Snapshot = IDLE_SNAPSHOT
  private plans = new Map<number, Plan>()
  private hostLink: HostLink | null = null
  private guestLink: GuestLink | null = null
  /** Host: which boat each connected guest steers. */
  private peerBoat = new Map<string, number>()
  /** Host: connections taken out of the lobby, ignored from then on. */
  private removed = new Set<string>()
  /** Host: each guest's seat key, by connection in the lobby and then by boat. */
  private peerSeat = new Map<string, string>()
  private seats = new Map<number, string>()
  /** Guest: who to reconnect to, and with which seat. */
  private hostId: string | null = null
  private seat = ""
  private retries = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  /** Guest: counts connections to the host, so a replaced one's late events are ignored. */
  private linkGen = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private generation = 0
  /**
   * Every turn of the race so far, for the replay: kept light, without the boats' tracks (the final state
   * has those) or the incidents (likewise). Each device keeps its own, so each player replays on their own.
   */
  private history: RaceState[] = []
  private replays = new Map<number, RaceState>()

  constructor(private readonly onChange: (s: Snapshot) => void) {}

  get snapshot() {
    return this.snap
  }

  private emit(patch: Partial<Snapshot>) {
    if (patch.state) this.record(patch.state)
    this.snap = { ...this.snap, ...patch }
    this.onChange(this.snap)
  }

  private record(state: RaceState) {
    const light = { ...state, incidents: [], boats: state.boats.map((b) => ({ ...b, track: [] })) }
    const last = this.history.at(-1)
    // A boat retiring mid-turn changes the state without a new turn: that turn's entry is replaced.
    if (last && last.turn === state.turn) this.history[this.history.length - 1] = light
    else if (!last || state.turn > last.turn) this.history.push(light)
    this.replays.clear()
  }

  /** The race as it stood after `turn` turns, for the replay; null if this device didn't see that turn. */
  replay(turn: number): RaceState | null {
    const final = this.snap.state
    if (!final) return null
    const hit = this.replays.get(turn)
    if (hit) return hit
    const h = this.history.find((s) => s.turn === turn)
    if (!h) return null
    const state: RaceState = {
      ...h,
      incidents: final.incidents.filter((i) => i.turn < turn),
      boats: h.boats.map((b, i) => ({ ...b, track: final.boats[i].track.slice(0, turn + 1) })),
    }
    this.replays.set(turn, state)
    return state
  }

  /**
   * Debugging: the race so far as JSON — settings, entrants, the current state with tracks and incidents, and
   * every turn this device saw. From the browser console: `copy(sailgrid.trace())`.
   */
  trace(): string {
    const { mode, phase, config, entrants, state } = this.snap
    return JSON.stringify({ mode, phase, config, entrants, state, history: this.history })
  }

  private clearTimer() {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }

  /** Back to setup, dropping any connection. */
  stop() {
    this.generation++
    this.clearTimer()
    this.clearRetry()
    this.hostLink?.close()
    const g = this.guestLink
    if (g && this.snap.mode === "guest" && this.snap.phase === "racing" && !this.snap.state?.over) {
      // Leaving for good: the host retires the boat rather than keep it for this guest. Hung up a moment
      // later, so the message gets out first.
      g.send({ type: "leave" })
      setTimeout(() => g.close(), 300)
    } else g?.close()
    this.hostLink = null
    this.guestLink = null
    this.peerBoat.clear()
    this.removed.clear()
    this.peerSeat.clear()
    this.seats.clear()
    this.hostId = null
    this.retries = 0
    this.plans.clear()
    this.history = []
    this.replays.clear()
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
    this.history = []
    this.seats.clear()
    for (const [peer, id] of this.peerBoat) {
      const seat = this.peerSeat.get(peer)
      if (seat) this.seats.set(id, seat)
    }
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
    return state.boats.filter((b) => racing(b) && !b.away && (b.controller === "human" || b.controller === "remote")).map((b) => b.id)
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
      // The AI boats, and any online boat that's away (or came back too late for this turn).
      for (const b of state.boats) if (racing(b) && !this.plans.has(b.id)) this.plans.set(b.id, chooseMove(map, state, b.id))
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
        onId: (id) => {
          if (gen !== this.generation) return
          const first = this.snap.inviteUrl === null
          this.emit({ inviteUrl: inviteUrl(id), serverLost: false, ...(first ? { status: "Waiting for sailors to join." } : {}) })
        },
        onServerLost: () => gen === this.generation && this.emit({ serverLost: true }),
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

  /** Host, in the lobby: take a guest out (say, one who never gets ready). They're told, and can't come back on that connection. */
  removeGuest(peer: string) {
    const s = this.snap
    if (s.mode !== "host" || s.phase !== "lobby" || !s.config || !this.peerBoat.has(peer)) return
    this.removed.add(peer)
    this.hostLink?.sendTo(peer, { type: "removed" })
    this.setEntrants(
      s.config,
      s.entrants.filter((e) => e.peer !== peer),
    )
  }

  private hostReceive(peer: string, msg: Message) {
    const s = this.snap
    if (this.removed.has(peer)) return
    if (msg.type === "hello") {
      if (s.phase === "racing") return this.reclaim(peer, msg.seat)
      if (s.phase !== "lobby" || !s.config) return
      if (s.entrants.length >= MAX_BOATS) return
      if (msg.seat) this.peerSeat.set(peer, msg.seat)
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
    if (msg.type === "leave") {
      const id = this.peerBoat.get(peer)
      if (id === undefined || s.phase !== "racing" || !s.state) return
      this.peerBoat.delete(peer)
      this.seats.delete(id)
      this.emit({ state: retire(s.state, id), status: `${s.state.boats[id].name} left the race.` })
      this.broadcastRace()
      this.maybeResolve()
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
      // Dropped, not left: the AI sails until they reconnect.
      this.peerBoat.delete(peer)
      const b = s.state.boats[id]
      if (!racing(b) || b.away) return
      this.emit({ state: setAway(s.state, id, true), status: `${b.name} lost the connection. The AI sails for them until they're back.` })
      this.broadcastRace()
      this.maybeResolve()
    }
  }

  /** Host: stop waiting for an online sailor. The AI sails their boat until they reconnect. */
  sailForGuest(id: number) {
    const s = this.snap
    const b = s.state?.boats[id]
    if (s.mode !== "host" || s.phase !== "racing" || !s.state || s.resolving || !b) return
    if (b.controller !== "remote" || !racing(b) || b.away || this.plans.has(id)) return
    this.emit({ state: setAway(s.state, id, true), status: `The AI sails for ${b.name} until they reconnect.` })
    this.broadcastRace()
    this.maybeResolve()
  }

  /** Host: a guest reconnecting mid-race gets their boat back, on this new connection. */
  private reclaim(peer: string, seat: string | undefined) {
    const s = this.snap
    const id = seat ? [...this.seats].find(([, k]) => k === seat)?.[0] : undefined
    if (id === undefined || !s.state) {
      this.hostLink?.sendTo(peer, { type: "late" })
      return
    }
    // Whatever connection had this boat is finished with: anything it still sends, or its closing, is ignored.
    for (const [p, b] of this.peerBoat) if (b === id) this.peerBoat.delete(p)
    this.peerBoat.set(peer, id)
    const b = s.state.boats[id]
    if (b.away) this.emit({ state: setAway(s.state, id, false), status: `${b.name} is back.` })
    this.broadcastRace()
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
    this.hostId = hostId
    this.seat = seatFor(hostId)
    this.emit({ mode: "guest", phase: "lobby", status: "Connecting to the host…" })
    await this.connect(name, boat)
  }

  /** Guest, mid-race: connect to the host afresh and take this device's boat back (from the AI, if it's away). */
  rejoin() {
    const s = this.snap
    if (s.mode !== "guest" || s.phase !== "racing" || !this.hostId || s.state?.over) return
    this.clearRetry()
    this.retries = 0
    this.reconnect()
  }

  private reconnect() {
    this.linkGen++
    this.guestLink?.close()
    this.guestLink = null
    this.emit({ status: "Reconnecting to the host…", error: null, active: null })
    const me = this.snap.state?.boats[this.snap.mine[0]]
    void this.connect(me?.name ?? "Guest", me?.boat ?? "j-35")
  }

  private clearRetry() {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer)
    this.retryTimer = null
  }

  /** Guest, mid-race: the connection to the host dropped. Try again a few times before giving up. */
  private lostHost(why: string) {
    const s = this.snap
    if (s.phase !== "racing" || !s.state || s.state.over || this.retries >= RECONNECT_TRIES) {
      this.emit({ error: why, status: "", active: null })
      return
    }
    const wait = 1000 * 2 ** this.retries++
    this.emit({ status: "Lost the host. Reconnecting…", error: null, active: null })
    this.clearRetry()
    this.retryTimer = setTimeout(() => ((this.retryTimer = null), this.reconnect()), wait)
  }

  private async connect(name: string, boat: BoatClassId) {
    const gen = this.generation
    const lg = ++this.linkGen
    const live = () => gen === this.generation && lg === this.linkGen
    const seat = this.seat
    // A failing connection can report both an error and its closing: only the first counts.
    const fail = (why: string) => {
      if (!live()) return
      this.linkGen++
      this.lostHost(why)
    }
    try {
      const link = await join(this.hostId!, {
        onOpen: () => {
          if (!live()) return
          this.guestLink?.send({ type: "hello", name, boat, seat })
          if (this.snap.phase === "lobby") this.emit({ status: "" })
        },
        onMessage: (msg) => live() && this.guestReceive(msg),
        onClose: () => fail("The host left the race."),
        // Mid-race, the host may only be away from the PeerJS server for a moment: that's tried again too.
        onError: (e) =>
          fail(e !== "peer-unavailable" ? `Connection problem (${e}).` : this.snap.phase === "racing" ? "The host left the race." : "That race isn't open any more."),
      })
      if (!live()) return link.close()
      this.guestLink = link
    } catch {
      fail("Couldn't connect. Check the link and try again.")
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
    if (msg.type === "late") {
      this.linkGen++
      this.guestLink?.close()
      this.guestLink = null
      this.emit({ status: "", active: null, error: s.phase === "racing" ? "The host doesn't have your boat in this race." : "That race has already started." })
      return
    }
    if (msg.type === "removed") {
      // Hang up first, so the closing connection doesn't read as the host leaving.
      this.guestLink?.close()
      this.guestLink = null
      this.emit({ entrants: [], mine: [], status: "", error: "The host removed you from the race." })
      return
    }
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
    this.retries = 0
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
      active: me && racing(me) && !me.away && !msg.state.over && !planned.includes(msg.you) ? msg.you : null,
      status: "",
      error: null,
    })
  }
}
