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

  it("keeps every turn of the race for the replay", async () => {
    let snap!: Snapshot
    const s = new Session((x) => (snap = x))
    s.startLocal({ ...cfg, size: "small" }, [
      { name: "Tern", color: "#0f0", controller: "ai", difficulty: "easy", boat: "melges-24" },
      { name: "Skua", color: "#00f", controller: "ai", difficulty: "easy", boat: "j-109" },
    ])
    s.setAutoplay(false)
    expect(s.replay(0)?.boats.map((b) => b.pos)).toEqual(snap.state!.boats.map((b) => b.pos))
    while (!snap.state!.over) {
      const t = snap.state!.turn
      s.step()
      await until(() => snap.state!.turn > t && !snap.resolving, 20_000)
    }
    const final = snap.state!
    for (let k = 0; k <= final.turn; k++) {
      const r = s.replay(k)!
      expect(r.turn).toBe(k)
      r.boats.forEach((b, i) => {
        const track = final.boats[i].track
        expect(b.pos).toEqual(track[Math.min(k, track.length - 1)])
        expect(b.track).toEqual(track.slice(0, k + 1))
      })
      expect(r.incidents.every((inc) => inc.turn < k)).toBe(true)
    }
    const end = s.replay(final.turn)!
    expect(end.boats.map((b) => [b.pos, b.finish, b.penalty])).toEqual(final.boats.map((b) => [b.pos, b.finish, b.penalty]))
    expect(end.incidents).toEqual(final.incidents)
    expect(s.replay(3)).toBe(s.replay(3))
    s.stop()
    expect(s.replay(0)).toBeNull()
  }, 60_000)

  describe("online sailors who drop out", () => {
    const ana: Entrant = { name: "Ana", color: "#e11d48", controller: "human", boat: "j-35" }
    // A host with Ana on its own screen, and Bo online: racing, with Bo at the helm.
    const race = async () => {
      const ref = { host: null as unknown as Snapshot, guest: null as unknown as Snapshot }
      const h = new Session((x) => (ref.host = x))
      const g = new Session((x) => (ref.guest = x))
      await h.hostLobby(cfg, [ana])
      await until(() => ref.host.inviteUrl !== null)
      await g.join("HOST", "Bo", "j-35")
      await until(() => ref.guest.mine.length === 1)
      g.setSailor("Bo", "j-35", true)
      await until(() => ref.host.entrants[1]?.ready === true)
      h.startHosted()
      await until(() => ref.guest.active === 1)
      return { h, g, ref }
    }
    const boPeer = () => [...net.guests.keys()].at(-1)!

    it("lets the AI sail for a dropped guest, who gets the boat back by opening the invite link again", async () => {
      const store = new Map<string, string>()
      vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) })
      try {
        const { h, g, ref } = await race()
        // Bo's connection dies without a word.
        const peer = boPeer()
        net.guests.delete(peer)
        net.host!.onLeave(peer)
        expect(ref.host.state!.boats[1].away).toBe(true)
        expect(ref.host.status).toMatch(/Bo lost the connection/)

        // Ana's move is all the turn waits for now.
        h.submit(0, { heading: ref.host.state!.boats[0].heading })
        await until(() => ref.host.state!.turn === 1 && !ref.host.resolving)
        await until(() => ref.host.state!.turn === 2 || ref.host.active === 0)
        expect(ref.host.state!.turn).toBe(1)

        // Bo reloads the page: the same device, so the same seat.
        let back!: Snapshot
        const g2 = new Session((x) => (back = x))
        await g2.join("HOST", "Bo", "j-35")
        await until(() => back.phase === "racing" && back.active === 1)
        expect(back.state!.turn).toBe(1)
        expect(ref.host.state!.boats[1].away).toBe(false)
        expect(ref.host.status).toMatch(/Bo is back/)

        // The turn waits for Bo again, and Bo's moves count.
        h.submit(0, { heading: ref.host.state!.boats[0].heading })
        await new Promise((r) => setTimeout(r, 20))
        expect(ref.host.state!.turn).toBe(1)
        g2.submit(1, { heading: back.state!.boats[1].heading })
        await until(() => ref.host.state!.turn === 2)
        g.stop()
        g2.stop()
        h.stop()
      } finally {
        vi.unstubAllGlobals()
      }
    })

    it("lets the host stop waiting for a guest, who can take the helm back", async () => {
      const { h, g, ref } = await race()
      h.submit(0, { heading: ref.host.state!.boats[0].heading })
      expect(ref.host.state!.turn).toBe(0)
      h.sailForGuest(1)
      await until(() => ref.host.state!.turn === 1 && !ref.host.resolving)
      expect(ref.host.state!.boats[1].away).toBe(true)
      await until(() => ref.guest.state!.boats[1].away === true)
      expect(ref.guest.active).toBeNull()

      g.rejoin()
      await until(() => ref.guest.active === 1 && ref.host.state!.boats[1].away === false)
      expect(ref.guest.error).toBeNull()
      // Only the new connection steers Bo's boat; the old one closed without making Bo away again.
      await new Promise((r) => setTimeout(r, 20))
      expect(ref.host.state!.boats[1].away).toBe(false)
      g.stop()
      h.stop()
    })

    it("retires the boat of a guest who leaves for good", async () => {
      const { h, g, ref } = await race()
      g.stop()
      await until(() => ref.host.state!.boats[1].next === -1)
      expect(ref.host.status).toMatch(/Bo left the race/)
      h.stop()
    })

    it("turns away someone new once the race has started", async () => {
      const { h, g, ref } = await race()
      let late!: Snapshot
      const g2 = new Session((x) => (late = x))
      await g2.join("HOST", "Cy", "j-35")
      await until(() => late.error !== null)
      expect(late.error).toMatch(/already started/)
      expect(ref.host.state!.boats).toHaveLength(2)
      g2.stop()
      g.stop()
      h.stop()
    })
  })
})
