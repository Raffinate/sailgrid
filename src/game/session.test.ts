import { describe, expect, it, vi } from "vitest"
import { defaultConfig } from "./map.ts"
import type { GuestHandlers, HostHandlers } from "./multiplayer.ts"
import type { Entrant } from "./race.ts"
import { type Message, Session, type Snapshot } from "./session.ts"

// An in-memory network in place of PeerJS: one host, any number of guests, messages delivered asynchronously
// and copied, as over a data channel.
const net = vi.hoisted(() => ({ host: null as HostHandlers | null, guests: new Map<string, GuestHandlers>(), next: 0 }))
vi.mock("./multiplayer.ts", () => {
  const later = (f: () => void) => setTimeout(f, 1)
  const copy = (m: Message) => JSON.parse(JSON.stringify(m)) as Message
  return {
    host: async (h: HostHandlers) => {
      net.host = h
      later(() => h.onId("HOST"))
      return {
        broadcast: (m: Message) => net.guests.forEach((g) => later(() => g.onMessage(copy(m)))),
        sendTo: (peer: string, m: Message) => later(() => net.guests.get(peer)?.onMessage(copy(m))),
        close: () => (net.host = null),
      }
    },
    join: async (_id: string, g: GuestHandlers) => {
      const peer = `guest-${net.next++}`
      net.guests.set(peer, g)
      later(() => (net.host?.onJoin(peer), g.onOpen()))
      return {
        send: (m: Message) => later(() => net.host?.onMessage(peer, copy(m))),
        close: () => {
          net.guests.delete(peer)
          later(() => net.host?.onLeave(peer))
        },
      }
    },
    inviteUrl: (id: string) => `?join=${id}`,
  }
})

const until = async (get: () => boolean, ms = 5000) => {
  const t0 = Date.now()
  while (!get()) {
    if (Date.now() - t0 > ms) throw new Error("timed out")
    await new Promise((r) => setTimeout(r, 5))
  }
}

const cfg = { ...defaultConfig(3), size: "small" as const, islands: "none" as const, laps: 1 }

describe("Session", () => {
  it("passes the helm between local sailors, then resolves the turn with the AI", async () => {
    let snap!: Snapshot
    const s = new Session((x) => (snap = x))
    const entrants: Entrant[] = [
      { name: "Ana", color: "#f00", controller: "human", boat: "j-35" },
      { name: "Bo", color: "#00f", controller: "human", boat: "j-35" },
      { name: "Tern", color: "#0f0", controller: "ai", difficulty: "easy", boat: "melges-24" },
    ]
    s.startLocal(cfg, entrants)
    expect(snap.active).toBe(0)
    expect(snap.handoff).toBe(false)
    const b0 = snap.state!.boats[0]
    s.submit(0, { heading: b0.heading })
    // Bo's plan is next, behind the hand-over screen; nothing has moved yet.
    expect(snap.active).toBe(1)
    expect(snap.handoff).toBe(true)
    expect(snap.state!.turn).toBe(0)
    s.takeHelm()
    s.submit(1, { heading: b0.heading })
    await until(() => snap.state!.turn === 1 && !snap.resolving)
    expect(snap.prev?.turn).toBe(0)
    expect(snap.state!.boats.every((b) => b.track.length === 2)).toBe(true)
    expect(snap.active).toBe(0)
    s.stop()
    expect(snap.phase).toBe("setup")
  })

  it("runs an AI-only race on its own", async () => {
    let snap!: Snapshot
    const s = new Session((x) => (snap = x))
    s.startLocal(cfg, [{ name: "Tern", color: "#0f0", controller: "ai", difficulty: "medium", boat: "j-109" }])
    expect(snap.active).toBeNull()
    await until(() => snap.state!.turn >= 2, 5000)
    s.setAutoplay(false)
    const t = snap.state!.turn
    await new Promise((r) => setTimeout(r, 700))
    expect(snap.state!.turn).toBe(t)
    s.step()
    await until(() => snap.state!.turn === t + 1)
    s.stop()
  })

  it("lets online guests pick a name and boat in the lobby, and starts only once they're ready", async () => {
    let host!: Snapshot
    let guest!: Snapshot
    const h = new Session((x) => (host = x))
    const g = new Session((x) => (guest = x))
    await h.hostLobby(cfg, [{ name: "Ana", color: "#e11d48", controller: "human", boat: "j-35" }])
    await until(() => host.inviteUrl !== null)
    await g.join("HOST", "You", "j-35")
    await until(() => guest.mine.length === 1 && guest.entrants.length === 2)

    // The guest sees the course and who's in.
    expect(guest.config).toEqual(cfg)
    expect(guest.entrants.map((e) => e.name)).toEqual(["Ana", "You"])
    expect(guest.entrants[guest.mine[0]].ready).toBe(false)

    // Not ready yet: the host can't start.
    h.startHosted()
    expect(host.phase).toBe("lobby")

    g.setSailor("  Bo  ", "melges-24", false)
    await until(() => host.entrants[1].name === "Bo")
    expect(host.entrants[1]).toMatchObject({ boat: "melges-24", ready: false })
    g.setSailor("Bo", "melges-24", true)
    await until(() => guest.entrants[guest.mine[0]].ready === true)
    expect(host.entrants[1].ready).toBe(true)

    // A different race: the guest confirms again.
    h.updateLobby({ ...cfg, windSpeed: 20 }, [{ name: "Ana", color: "#e11d48", controller: "human", boat: "j-35" }])
    expect(host.entrants[1].ready).toBe(false)
    await until(() => guest.config?.windSpeed === 20)
    expect(guest.entrants[guest.mine[0]].ready).toBe(false)
    expect(guest.status).toMatch(/changed the race/)
    h.startHosted()
    expect(host.phase).toBe("lobby")

    g.setSailor("Bo", "melges-24", true)
    await until(() => host.entrants[1].ready === true)
    h.startHosted()
    expect(host.phase).toBe("racing")
    expect(host.state!.boats[1]).toMatchObject({ name: "Bo", boat: "melges-24", controller: "remote" })
    expect(host.state!.boats[1]).not.toHaveProperty("ready")
    await until(() => guest.phase === "racing")
    expect(guest.active).toBe(1)

    // Lobby changes are ignored once racing.
    g.setSailor("Late", "j-109", true)
    await new Promise((r) => setTimeout(r, 20))
    expect(host.state!.boats[1].name).toBe("Bo")
    g.stop()
    h.stop()
  })

  it("lets the host remove a guest who never gets ready", async () => {
    let host!: Snapshot
    let idle!: Snapshot
    const h = new Session((x) => (host = x))
    const g = new Session((x) => (idle = x))
    await h.hostLobby(cfg, [{ name: "Ana", color: "#e11d48", controller: "human", boat: "j-35" }])
    await until(() => host.inviteUrl !== null)
    await g.join("HOST", "Idle", "j-109")
    await until(() => host.entrants.length === 2 && idle.mine.length === 1)
    h.startHosted()
    expect(host.phase).toBe("lobby")

    h.removeGuest(host.entrants[1].peer!)
    expect(host.entrants.map((e) => e.name)).toEqual(["Ana"])
    await until(() => idle.error !== null)
    expect(idle.error).toMatch(/removed you/)
    expect(idle.mine).toEqual([])

    // Nothing more from that connection counts, and the race can start.
    g.setSailor("Idle", "j-109", true)
    await new Promise((r) => setTimeout(r, 20))
    expect(host.entrants).toHaveLength(1)
    h.startHosted()
    expect(host.phase).toBe("racing")
    g.stop()
    h.stop()
  })
})
