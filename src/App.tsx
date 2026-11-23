import { Button } from "@ui-sdk/solid/button"
import { createEffect, createMemo, createSignal, onSettled, Show } from "solid-js"
import { track } from "./analytics.ts"
import { ActionBar } from "./components/ActionBar.tsx"
import { Board } from "./components/Board.tsx"
import { Helm } from "./components/Helm.tsx"
import { HelpDialog } from "./components/HelpDialog.tsx"
import { IncidentLog, Scoreboard } from "./components/Scoreboard.tsx"
import {
  CoursePanel,
  defaultPlayers,
  FleetPanel,
  LobbyPanel,
  PlayersPanel,
  type SetupPlayer,
  StartPanel,
  toEntrants,
} from "./components/Setup.tsx"
import { ThemeToggle } from "./components/ThemeToggle.tsx"
import { buttonClass, Kbd, Panel } from "./components/ui.tsx"
import type { Plan } from "./game/boat.ts"
import { type BoatClassId, DEFAULT_BOAT, FLEET } from "./game/fleet.ts"
import { generateMap, type RaceConfig, randomConfig } from "./game/map.ts"
import { parseJoinId } from "./game/multiplayer.ts"
import { previewPlan, raceTime, racing, standings } from "./game/race.ts"
import { randomSeed } from "./game/rng.ts"
import { IDLE_SNAPSHOT, Session, type Snapshot } from "./game/session.ts"
import { windAt, windField } from "./game/wind.ts"

const SETUP_KEY = "sailgrid:setup"

function loadSetup(): { config: RaceConfig; players: SetupPlayer[] } {
  const fallback = { config: randomConfig(), players: defaultPlayers() }
  try {
    const raw = localStorage.getItem(SETUP_KEY)
    if (!raw) return fallback
    const saved = JSON.parse(raw) as { config?: Partial<RaceConfig>; players?: SetupPlayer[] }
    const players = (Array.isArray(saved.players) && saved.players.length ? saved.players : fallback.players).map((p) => ({
      ...p,
      // Setups saved before there was a choice of boats.
      boat: FLEET.some((c) => c.id === p.boat) ? p.boat : DEFAULT_BOAT,
    }))
    return { config: { ...fallback.config, ...saved.config }, players }
  } catch {
    return fallback
  }
}

function saveSetup(config: RaceConfig, players: SetupPlayer[]) {
  try {
    localStorage.setItem(SETUP_KEY, JSON.stringify({ config, players }))
  } catch {
    // Storage can be blocked; the setup just won't be remembered.
  }
}

const joinParam = parseJoinId(new URLSearchParams(location.search).get("join") ?? "")

export function App() {
  const initial = loadSetup()
  const [config, setConfig] = createSignal<RaceConfig>(initial.config)
  const [players, setPlayers] = createSignal<SetupPlayer[]>(initial.players)
  const [snap, setSnap] = createSignal<Snapshot>(IDLE_SNAPSHOT)
  const [helpOpen, setHelpOpen] = createSignal(false)
  const [showWind, setShowWind] = createSignal(true)
  const session = new Session((s) => setSnap(s))

  createEffect(
    () => ({ config: config(), players: players() }),
    (s) => saveSetup(s.config, s.players),
  )

  // Host: the lobby follows the settings. Called from the handlers, not an effect: updating the lobby
  // changes the session snapshot, which an effect reading it would then relay back.
  const editConfig = (c: RaceConfig) => {
    setConfig(c)
    session.updateLobby(c, toEntrants(players()))
  }
  const editPlayers = (p: SetupPlayer[]) => {
    setPlayers(p)
    session.updateLobby(config(), toEntrants(p))
  }

  const previewMap = createMemo(() => {
    try {
      return generateMap(config())
    } catch {
      return null
    }
  })
  // Guests in the lobby see the host's course. Keyed on the settings so the map isn't rebuilt on every lobby update.
  const guestConfig = createMemo(() => {
    const s = snap()
    return s.mode === "guest" && s.phase === "lobby" && s.config ? JSON.stringify(s.config) : null
  })
  const guestMap = createMemo(() => {
    const c = guestConfig()
    if (!c) return null
    try {
      return generateMap(JSON.parse(c) as RaceConfig)
    } catch {
      return null
    }
  })
  const map = createMemo(() => (snap().phase === "racing" ? snap().map : snap().mode === "guest" ? guestMap() : previewMap()))
  const state = () => snap().state
  const activeBoat = createMemo(() => {
    const s = snap()
    return s.active !== null && s.state && !s.handoff && !s.resolving ? s.state.boats[s.active] : null
  })

  // The plan being set up for the active boat: starts from its current heading and sheet each turn.
  const basePlan = createMemo(() => {
    const b = activeBoat()
    return b ? { heading: b.heading, key: `${snap().state?.turn}:${b.id}` } : null
  })
  const [plan, setPlan] = createSignal<Plan>(() => {
    const b = basePlan()
    return { heading: b?.heading ?? 0 }
  })

  const preview = createMemo(() => {
    const s = snap()
    const b = activeBoat()
    if (!b || !s.map || !s.state) return null
    return previewPlan(s.map, s.state, b.id, plan())
  })
  const windHere = createMemo(() => {
    const s = snap()
    const b = activeBoat()
    if (!b || !s.map || !s.state) return null
    return windAt(windField(s.map, s.state.turn), b.pos)
  })

  const submit = () => {
    const b = activeBoat()
    if (b) session.submit(b.id, plan())
  }

  const start = () => {
    session.startLocal(config(), toEntrants(players()))
    track("race_started", { mode: "local", boats: players().length, humans: players().filter((p) => p.kind === "human").length })
  }
  const hostOnline = () => {
    void session.hostLobby(config(), toEntrants(players()))
    track("race_hosted")
  }
  const joinOnline = (id: string) => {
    const me = players().find((p) => p.kind === "human")
    void session.join(id, me?.name ?? "Guest", me?.boat ?? DEFAULT_BOAT)
    track("race_joined")
  }
  // A guest's name and boat go to the host, and are remembered as this device's first sailor for next time.
  const setSailor = (name: string, boat: BoatClassId, ready: boolean) => {
    session.setSailor(name, boat, ready)
    const ps = players()
    const i = ps.findIndex((p) => p.kind === "human")
    if (i >= 0 && name.trim()) setPlayers(ps.map((p, j) => (j === i ? { ...p, name: name.trim(), boat } : p)))
  }

  let reported = false
  createEffect(
    () => snap().state?.over ?? false,
    (over) => {
      if (!over) {
        reported = false
        return
      }
      if (reported) return
      reported = true
      const s = snap()
      const top = s.state ? standings(s.state)[0] : null
      track("race_finished", { mode: s.mode, won: top ? s.mine.includes(top.id) : false, turns: s.state?.turn ?? 0 })
    },
  )

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey || helpOpen()) return
    const target = e.target as HTMLElement | null
    if (target?.closest("input, textarea, [contenteditable], [role=listbox], [role=slider], [data-slot=select-content]")) return
    if (!activeBoat()) {
      if (snap().handoff && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault()
        session.takeHelm()
      }
      return
    }
    const p = plan()
    const big = e.shiftKey ? 10 : 1
    if (e.key === "ArrowLeft") setPlan({ heading: (p.heading - big + 360) % 360 })
    else if (e.key === "ArrowRight") setPlan({ heading: (p.heading + big) % 360 })
    else if (e.key === "Enter") submit()
    else return
    e.preventDefault()
  }

  onSettled(() => {
    document.addEventListener("keydown", onKeyDown)
    if (joinParam) joinOnline(joinParam)
    return () => {
      document.removeEventListener("keydown", onKeyDown)
      session.stop()
    }
  })

  const localHumansRacing = () => snap().state?.boats.some((b) => racing(b) && b.controller === "human") ?? false
  const spectating = () => snap().phase === "racing" && snap().mode !== "guest" && !localHumansRacing() && !snap().state?.over
  const waitingText = () => {
    const s = snap()
    if (!s.state || s.state.over) return ""
    if (s.resolving) return "Sailing…"
    const waiting = s.state.boats.filter((b) => racing(b) && b.controller !== "ai" && !s.planned.includes(b.id))
    if (s.mode === "guest") {
      if (s.active === null && s.mine.some((id) => s.planned.includes(id)))
        return waiting.length ? `Waiting for ${waiting.map((b) => b.name).join(", ")}.` : "Waiting for the host."
    }
    return waiting.length && !activeBoat() ? `Waiting for ${waiting.map((b) => b.name).join(", ")}.` : ""
  }
  const handoffBoat = () => {
    const s = snap()
    return s.handoff && s.active !== null && s.state ? s.state.boats[s.active] : null
  }
  const winner = () => {
    const s = snap()
    if (!s.state?.over) return null
    return standings(s.state)[0] ?? null
  }

  return (
    <div class="mx-auto max-w-7xl px-4 py-6 sm:py-8">
      <header class="mb-5">
        <div class="-my-1.5 flex items-center justify-between gap-4">
          <nav aria-label="Breadcrumb">
            <ol class="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <li>
                <a
                  href="https://raffinate.github.io/"
                  class="inline-flex items-center gap-1.5 rounded-sm outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/40"
                  data-ph-capture-attribute-action="home"
                >
                  <svg
                    viewBox="0 0 24 24"
                    class="size-3.5"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8" />
                    <path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                  </svg>
                  Home
                </a>
              </li>
              <li aria-hidden="true">
                <svg viewBox="0 0 24 24" class="size-3.5 opacity-60" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="m9 18 6-6-6-6" />
                </svg>
              </li>
              <li aria-current="page" class="text-foreground">
                Sailgrid
              </li>
            </ol>
          </nav>
          <div class="flex items-center gap-1">
            <Button class={buttonClass.ghost} onClick={() => setHelpOpen(true)} data-ph-capture-attribute-action="help">
              How to sail
            </Button>
            <ThemeToggle />
          </div>
        </div>
        <h1 class="text-2xl font-semibold tracking-tight">Sailgrid</h1>
        <p class="mt-1 text-sm text-muted-foreground">
          A turn-based regatta on grid paper. Pick your boat, set your heading, play the wind shifts and round the marks.
        </p>
      </header>

      <div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div class="min-w-0 space-y-3">
          <Panel flush class="relative overflow-hidden p-2">
            <Show
              when={map()}
              fallback={<div class="grid aspect-[3/2] place-items-center text-sm text-muted-foreground">{snap().status || "…"}</div>}
            >
              {(m) => (
                <Board
                  map={m()}
                  state={state()}
                  prev={snap().prev}
                  active={activeBoat()?.id ?? null}
                  focus={activeBoat()?.id ?? snap().mine[0] ?? null}
                  preview={preview() ? { move: preview()!.move, stop: preview()!.stop, aground: preview()!.aground } : null}
                  showWind={showWind()}
                  onAim={(heading) => setPlan({ heading })}
                />
              )}
            </Show>
            <Show when={handoffBoat()}>
              {(b) => (
                <div class="absolute inset-0 grid place-items-center bg-background/80 backdrop-blur-sm">
                  <div class="text-center">
                    <div class="mb-1 flex items-center justify-center gap-2 text-lg font-semibold">
                      <span class="inline-block size-3.5 rounded-full" style={{ background: b().color }} />
                      {b().name}'s turn
                    </div>
                    <p class="mb-4 text-sm text-muted-foreground">Pass the screen over. Plans stay hidden until everyone has sailed.</p>
                    <Button class={buttonClass.primary} onClick={() => session.takeHelm()}>
                      Take the helm
                      <Kbd>Enter</Kbd>
                    </Button>
                  </div>
                </div>
              )}
            </Show>
            <Show when={winner()}>
              {(w) => (
                <div class="absolute top-3 left-1/2 -translate-x-1/2 rounded-lg border border-border bg-card/95 px-4 py-2 text-center shadow-lg">
                  <div class="flex items-center justify-center gap-2 text-sm font-semibold">
                    <span class="inline-block size-3 rounded-full" style={{ background: w().color }} />
                    {raceTime(w()) === null ? "Race over" : `${w().name} wins`}
                  </div>
                  <Show when={raceTime(w()) !== null}>
                    <div class="text-xs text-muted-foreground tabular-nums">race time {raceTime(w())!.toFixed(2)} turns</div>
                  </Show>
                </div>
              )}
            </Show>
          </Panel>
          <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-1 text-xs text-muted-foreground">
            <div class="flex flex-wrap items-center gap-x-4 gap-y-1">
              <label class="inline-flex cursor-pointer items-center gap-1.5">
                <input type="checkbox" checked={showWind()} onChange={(e) => setShowWind(e.currentTarget.checked)} class="accent-current" />
                Show wind
              </label>
              <span>Darker water: puffs. Lighter: lulls.</span>
              <Show when={snap().state}>
                {(s) => (
                  <span class="tabular-nums">
                    Turn {s().turn + 1} · base wind {Math.round(windField(snap().map!, s().turn).baseSpeed)} kn from{" "}
                    {Math.round(windField(snap().map!, s().turn).baseFrom)}°
                  </span>
                )}
              </Show>
            </div>
            <span aria-live="polite">{waitingText()}</span>
          </div>
        </div>

        <aside class="space-y-4">
          <Show when={snap().phase === "setup"}>
            <CoursePanel config={config()} onChange={editConfig} />
            <PlayersPanel players={players()} onChange={editPlayers} />
            <StartPanel defaultJoin="" onStart={start} onHost={hostOnline} onJoin={joinOnline} />
            <FleetPanel windSpeed={config().windSpeed} />
          </Show>

          <Show when={snap().phase === "lobby"}>
            <LobbyPanel
              host={snap().mode === "host"}
              inviteUrl={snap().inviteUrl}
              config={snap().config}
              entrants={snap().entrants}
              you={snap().mode === "guest" ? (snap().mine[0] ?? null) : null}
              status={snap().status}
              error={snap().error}
              onStart={() => {
                session.startHosted()
                track("race_started", { mode: "host", boats: snap().entrants.length })
              }}
              onLeave={() => session.stop()}
              onSailor={setSailor}
              onRemove={(peer) => session.removeGuest(peer)}
            />
            <Show when={snap().mode === "host"}>
              <PlayersPanel players={players()} onChange={editPlayers} />
              <CoursePanel config={config()} onChange={editConfig} />
            </Show>
            <FleetPanel windSpeed={snap().config?.windSpeed ?? config().windSpeed} />
          </Show>

          <Show when={snap().phase === "racing" && snap().map && snap().state}>
            <Show when={activeBoat() && preview() && windHere()}>
              <Helm
                map={snap().map!}
                boat={activeBoat()!}
                turn={snap().state!.turn}
                plan={plan()}
                preview={preview()!}
                windFrom={windHere()!.from}
                windSpeed={windHere()!.speed}
                disabled={snap().resolving}
                onPlan={setPlan}
                onSubmit={submit}
              />
            </Show>
            <Show when={spectating()}>
              <Panel title="Watching" class="space-y-3">
                <p class="text-sm text-muted-foreground">
                  {snap().state!.boats.some((b) => b.controller === "human")
                    ? "You're across the line. The rest of the fleet sails on."
                    : "The AI boats race on their own."}
                </p>
                <div class="flex gap-2">
                  <Button class={buttonClass.outline} onClick={() => session.setAutoplay(!snap().autoplay)}>
                    {snap().autoplay ? "Pause" : "Play"}
                  </Button>
                  <Button class={buttonClass.ghost} disabled={snap().autoplay || snap().resolving} onClick={() => session.step()}>
                    Step one turn
                  </Button>
                </div>
              </Panel>
            </Show>
            <Show when={snap().error}>{(e) => <Panel><p class="text-sm text-danger">{e()}</p></Panel>}</Show>
            <Scoreboard
              map={snap().map!}
              state={snap().state!}
              mine={snap().mine}
              planned={snap().planned}
              showPlanned={!snap().state!.over}
            />
            <IncidentLog state={snap().state!} />
            <div class="flex flex-wrap gap-2">
              <Show when={snap().mode === "local" && snap().state!.over}>
                <Button class={buttonClass.primary} onClick={start}>
                  Sail it again
                </Button>
              </Show>
              <Button
                class={buttonClass.outline}
                onClick={() => {
                  const fresh = snap().mode !== "guest" && snap().state!.over
                  session.stop()
                  if (fresh) setConfig({ ...config(), seed: randomSeed() })
                }}
              >
                {snap().mode === "guest" ? "Leave race" : snap().state!.over ? "New race" : "Abandon race"}
              </Button>
            </div>
          </Show>
        </aside>
      </div>

      <Show when={activeBoat() && preview() && windHere()}>
        <ActionBar
          boat={activeBoat()!}
          plan={plan()}
          preview={preview()!}
          windSpeed={windHere()!.speed}
          disabled={snap().resolving}
          onPlan={setPlan}
          onSubmit={submit}
        />
      </Show>

      <HelpDialog open={helpOpen()} onOpenChange={setHelpOpen} />
    </div>
  )
}
