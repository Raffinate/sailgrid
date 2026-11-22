import { describe, expect, it } from "vitest"
import { defaultConfig } from "./map.ts"
import type { Entrant } from "./race.ts"
import { Session, type Snapshot } from "./session.ts"

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
      { name: "Ana", color: "#f00", controller: "human" },
      { name: "Bo", color: "#00f", controller: "human" },
      { name: "Tern", color: "#0f0", controller: "ai", difficulty: "easy" },
    ]
    s.startLocal(cfg, entrants)
    expect(snap.active).toBe(0)
    expect(snap.handoff).toBe(false)
    const b0 = snap.state!.boats[0]
    s.submit(0, { heading: b0.heading, sail: 10 })
    // Bo's plan is next, behind the hand-over screen; nothing has moved yet.
    expect(snap.active).toBe(1)
    expect(snap.handoff).toBe(true)
    expect(snap.state!.turn).toBe(0)
    s.takeHelm()
    s.submit(1, { heading: b0.heading, sail: 10 })
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
    s.startLocal(cfg, [{ name: "Tern", color: "#0f0", controller: "ai", difficulty: "medium" }])
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
})
