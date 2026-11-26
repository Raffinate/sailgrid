import { Button } from "@ui-sdk/solid/button"
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@ui-sdk/solid/collapsible"
import { Input } from "@ui-sdk/solid/input"
import { createSignal, For, Show } from "solid-js"
import { type BoatClassId, boatClass, DEFAULT_BOAT, FLEET, WIND_BAND_LABEL, windBand } from "../game/fleet.ts"
import { type CourseKind, describeConfig, type IslandDensity, type MapSize, type RaceConfig, randomConfig, TEST_SEED, type Weather } from "../game/map.ts"
import { parseJoinId } from "../game/multiplayer.ts"
import type { Difficulty, Entrant } from "../game/race.ts"
import { randomSeed } from "../game/rng.ts"
import { BOAT_COLORS, MAX_BOATS, MAX_NAME, notReady } from "../game/session.ts"
import { RangeField } from "./RangeField.tsx"
import { buttonClass, Choice, Panel, Segmented } from "./ui.tsx"

export type PlayerKind = "human" | Difficulty

export interface SetupPlayer {
  name: string
  kind: PlayerKind
  boat: BoatClassId
}

// Short names in the picker; the fleet panel has the full ones.
const BOATS = FLEET.map((c) => [c.id, c.name.replace(/^Beneteau /, "")] as const)

const KINDS = [
  ["human", "Human"],
  ["easy", "AI · easy"],
  ["medium", "AI · medium"],
  ["hard", "AI · hard"],
] as const

const AI_NAMES = ["Tern", "Petrel", "Gannet", "Skua", "Fulmar", "Kittiwake", "Shearwater", "Puffin"]

export const defaultPlayers = (): SetupPlayer[] => [
  { name: "You", kind: "human", boat: "j-35" },
  { name: "Tern", kind: "hard", boat: "melges-24" },
  { name: "Petrel", kind: "medium", boat: "j-109" },
  { name: "Gannet", kind: "easy", boat: "x-35" },
]

export const toEntrants = (players: SetupPlayer[]): Entrant[] =>
  players.map((p, i) => ({
    name: p.name.trim() || (p.kind === "human" ? `Sailor ${i + 1}` : AI_NAMES[i % AI_NAMES.length]),
    color: BOAT_COLORS[i % BOAT_COLORS.length],
    controller: p.kind === "human" ? "human" : "ai",
    boat: FLEET.some((c) => c.id === p.boat) ? p.boat : DEFAULT_BOAT,
    ...(p.kind === "human" ? {} : { difficulty: p.kind }),
  }))

function Setting(props: { label: string; children: import("solid-js").Element }) {
  return (
    <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
      <span class="text-sm font-medium">{props.label}</span>
      {props.children}
    </div>
  )
}

/** The race: roll a random one, or open Customize to set the course, wind and map by hand. */
export function CoursePanel(props: { config: RaceConfig; disabled?: boolean; onChange: (c: RaceConfig) => void }) {
  const set = <K extends keyof RaceConfig>(k: K, v: RaceConfig[K]) => props.onChange({ ...props.config, [k]: v })
  // The map number as typed. The input is controlled and puts back its value after every keystroke unless
  // that value changes, so the text being edited lives here; each whole number picks that map at once.
  const [seedText, setSeedText] = createSignal<string | null>(null)
  const editSeed = (text: string) => {
    setSeedText(text)
    const n = Number(text)
    if (text.trim() !== "" && Number.isInteger(n) && (n >= 0 || n === TEST_SEED)) set("seed", n)
  }
  return (
    <Panel title="Race" class="space-y-3">
      <div class="flex items-start justify-between gap-3">
        <p class="text-sm" aria-live="polite">
          {describeConfig(props.config)}
        </p>
        <Button
          class={`${buttonClass.outline} shrink-0`}
          disabled={props.disabled}
          onClick={() => props.onChange(randomConfig())}
          data-ph-capture-attribute-action="random-race"
        >
          <svg viewBox="0 0 24 24" class="size-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true">
            <rect x="3" y="3" width="18" height="18" rx="3" />
            <circle cx="8" cy="8" r="1.2" fill="currentColor" />
            <circle cx="16" cy="16" r="1.2" fill="currentColor" />
            <circle cx="12" cy="12" r="1.2" fill="currentColor" />
          </svg>
          Random race
        </Button>
      </div>
      <Collapsible>
        <CollapsibleTrigger
          class="group flex w-full items-center justify-between gap-3 rounded-md border-t border-border pt-3 text-left text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/40"
          data-ph-capture-attribute-action="toggle-customize"
        >
          Customize
          <svg
            viewBox="0 0 24 24"
            class="size-4 opacity-60 transition-transform group-data-open:rotate-180"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            aria-hidden="true"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </CollapsibleTrigger>
        <CollapsiblePanel class="space-y-3.5 pt-3.5">
          <Setting label="Course">
            <Choice<CourseKind>
              label="Course"
              value={props.config.course}
              disabled={props.disabled}
              class="w-56"
              options={[
                ["windward-leeward", "Windward–leeward: beats and runs"],
                ["triangle", "Triangle: mostly reaching"],
                ["islands", "Round the islands"],
              ]}
              onChange={(v) => set("course", v)}
            />
          </Setting>
          <Show when={props.config.course !== "islands"}>
            <Setting label="Laps">
              <Segmented
                label="Laps"
                value={String(props.config.laps)}
                disabled={props.disabled}
                options={[
                  ["1", "1"],
                  ["2", "2"],
                  ["3", "3"],
                ]}
                onChange={(v) => set("laps", Number(v))}
              />
            </Setting>
          </Show>
          <Setting label="Map">
            <Segmented<MapSize>
              label="Map size"
              value={props.config.size}
              disabled={props.disabled}
              options={[
                ["small", "Small"],
                ["medium", "Medium"],
                ["large", "Large"],
              ]}
              onChange={(v) => set("size", v)}
            />
          </Setting>
          <Setting label="Islands">
            <Segmented<IslandDensity>
              label="Islands"
              value={props.config.islands}
              disabled={props.disabled}
              options={[
                ["none", "None"],
                ["few", "Few"],
                ["many", "Many"],
              ]}
              onChange={(v) => set("islands", v)}
            />
          </Setting>
          <Setting label="Weather">
            <Segmented<Weather>
              label="Weather"
              value={props.config.weather}
              disabled={props.disabled}
              options={[
                ["settled", "Settled"],
                ["changeable", "Changeable"],
                ["unsettled", "Unsettled"],
                ["stormy", "Stormy"],
              ]}
              onChange={(v) => set("weather", v)}
            />
          </Setting>
          <RangeField
            label="Wind speed"
            unit="kn"
            value={props.config.windSpeed}
            min={5}
            max={25}
            step={1}
            color="var(--wind)"
            onChange={(v) => !props.disabled && set("windSpeed", Math.round(v))}
          />
          <div class="flex items-end gap-2">
            <label class="min-w-0 flex-1">
              <span class="mb-1 block text-sm font-medium">Map number</span>
              <Input
                type="number"
                min={TEST_SEED}
                step={1}
                value={seedText() ?? String(props.config.seed)}
                disabled={props.disabled}
                onValueChange={editSeed}
                onBlur={() => setSeedText(null)}
                class="h-9 w-full rounded-md border border-input bg-card px-3 text-sm tabular-nums shadow-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
              />
            </label>
            <Button
              class={buttonClass.outline}
              disabled={props.disabled}
              onClick={() => set("seed", randomSeed())}
              data-ph-capture-attribute-action="new-map"
            >
              New map
            </Button>
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </Panel>
  )
}

/** Who's racing. */
export function PlayersPanel(props: { players: SetupPlayer[]; disabled?: boolean; onChange: (p: SetupPlayer[]) => void }) {
  const update = (i: number, patch: Partial<SetupPlayer>) =>
    props.onChange(props.players.map((p, j) => (j === i ? { ...p, ...patch } : p)))
  const add = (kind: PlayerKind) => {
    const n = props.players.length
    const name = kind === "human" ? `Sailor ${n + 1}` : (AI_NAMES.find((a) => !props.players.some((p) => p.name === a)) ?? `Boat ${n + 1}`)
    props.onChange([...props.players, { name, kind, boat: FLEET[props.players.length % FLEET.length].id }])
  }
  return (
    <Panel title="Sailors" class="space-y-3">
      <p class="-mt-2 text-xs text-muted-foreground">Name, who sails it, and which boat.</p>
      <ul class="space-y-2.5">
        <For each={props.players} keyed={false}>
          {(p, i) => (
            <li class="space-y-1.5 border-t border-border pt-2.5 first:border-t-0 first:pt-0">
              <div class="flex items-center gap-2">
                <span class="inline-block size-3 shrink-0 rounded-full" style={{ background: BOAT_COLORS[i % BOAT_COLORS.length] }} />
                <Input
                  value={p().name}
                  disabled={props.disabled}
                  aria-label="Name"
                  maxlength={20}
                  onValueChange={(name) => update(i, { name })}
                  class="h-8 min-w-0 flex-1 rounded-md border border-input bg-card px-2.5 text-sm shadow-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
                />
                <button
                  type="button"
                  aria-label={`Remove ${p().name}`}
                  disabled={props.disabled || props.players.length <= 1}
                  onClick={() => props.onChange(props.players.filter((_, j) => j !== i))}
                  class="rounded-md p-1 text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/40 disabled:opacity-40"
                >
                  <svg viewBox="0 0 24 24" class="size-4" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                    <path d="M18 6 6 18" />
                    <path d="m6 6 12 12" />
                  </svg>
                </button>
              </div>
              <div class="grid grid-cols-2 gap-2 pl-5">
                <Choice<PlayerKind>
                  label="Who sails it"
                  value={p().kind}
                  options={KINDS}
                  disabled={props.disabled}
                  class="w-full"
                  onChange={(kind) => update(i, { kind })}
                />
                <Choice<BoatClassId>
                  label="Boat"
                  value={FLEET.some((c) => c.id === p().boat) ? p().boat : DEFAULT_BOAT}
                  options={BOATS}
                  disabled={props.disabled}
                  class="w-full"
                  onChange={(boat) => update(i, { boat })}
                />
              </div>
            </li>
          )}
        </For>
      </ul>
      <div class="flex flex-wrap gap-2">
        <Button class={buttonClass.outline} disabled={props.disabled || props.players.length >= MAX_BOATS} onClick={() => add("human")}>
          + Human
        </Button>
        <Button class={buttonClass.outline} disabled={props.disabled || props.players.length >= MAX_BOATS} onClick={() => add("medium")}>
          + AI boat
        </Button>
      </div>
      <p class="text-xs text-muted-foreground">
        Several humans take turns on this screen. With no humans, sit back and watch the AI race. Up to {MAX_BOATS} boats.
      </p>
    </Panel>
  )
}

/**
 * The four boats. About equally fast overall, each quickest in different conditions, and no handicap:
 * the choice is about which boat suits today's wind and course.
 */
export function FleetPanel(props: { windSpeed: number }) {
  return (
    <Panel title="The fleet" class="space-y-3">
      <p class="-mt-2 text-xs text-muted-foreground">
        Real speeds from ORC certificates, no handicap: first across the line wins. Pick the boat for the conditions:
        this race is {WIND_BAND_LABEL[windBand(props.windSpeed)]} ({props.windSpeed} kn).
      </p>
      <ul class="space-y-2.5">
        <For each={FLEET}>
          {(c) => (
            <li class="text-sm">
              <div class="font-medium">{c.name}</div>
              <p class="text-xs text-muted-foreground">{c.blurb}</p>
              <p class="text-xs">
                <span class="text-good">Best:</span> {c.strengths} <span class="text-danger">Weak:</span> {c.weaknesses}
              </p>
              <p class="text-xs text-muted-foreground tabular-nums">
                {c.loa.toFixed(1)} m · {(c.displacement / 1000).toFixed(1)} t · {c.certificates} certificates
              </p>
            </li>
          )}
        </For>
      </ul>
    </Panel>
  )
}

/** Start buttons, and joining someone else's race. */
export function StartPanel(props: {
  defaultJoin: string
  onStart: () => void
  onHost: () => void
  onJoin: (hostId: string) => void
}) {
  const [joinText, setJoinText] = createSignal(props.defaultJoin)
  return (
    <Panel class="space-y-4">
      <div class="flex flex-wrap gap-2">
        <Button class={buttonClass.primary} onClick={() => props.onStart()} data-ph-capture-attribute-action="start">
          Start race
        </Button>
        <Button class={buttonClass.outline} onClick={() => props.onHost()} data-ph-capture-attribute-action="host">
          Host online race
        </Button>
      </div>
      <div class="border-t border-border pt-4">
        <label class="mb-1 block text-sm font-medium" for="join-link">
          Join a friend's race
        </label>
        <div class="flex gap-2">
          <Input
            id="join-link"
            value={joinText()}
            placeholder="Paste the invite link"
            onValueChange={(v) => setJoinText(v)}
            autocomplete="off"
            class="h-9 min-w-0 flex-1 rounded-md border border-input bg-card px-3 text-sm shadow-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
          />
          <Button
            class={buttonClass.outline}
            disabled={!parseJoinId(joinText())}
            onClick={() => props.onJoin(parseJoinId(joinText()))}
            data-ph-capture-attribute-action="join"
          >
            Join
          </Button>
        </div>
        <p class="mt-1.5 text-xs text-muted-foreground">You'll pick your name and boat in the lobby.</p>
      </div>
    </Panel>
  )
}

/** A guest's own entry in the lobby: name and boat, then ready. Ready locks them until changed again. */
function GuestSailor(props: { me: Entrant; onChange: (name: string, boat: BoatClassId, ready: boolean) => void }) {
  const [name, setName] = createSignal(props.me.name)
  const [boat, setBoat] = createSignal<BoatClassId>(props.me.boat)
  const ready = () => props.me.ready === true
  return (
    <div class="space-y-2 rounded-md border border-border p-3">
      <div class="text-sm font-medium">Your boat</div>
      <div class="flex items-center gap-2">
        <span class="inline-block size-3 shrink-0 rounded-full" style={{ background: props.me.color || "var(--muted-foreground)" }} />
        <Input
          value={name()}
          disabled={ready()}
          aria-label="Your name"
          maxlength={MAX_NAME}
          onValueChange={(v) => {
            setName(v)
            props.onChange(v, boat(), false)
          }}
          class="h-8 min-w-0 flex-1 rounded-md border border-input bg-card px-2.5 text-sm shadow-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/40 disabled:opacity-60"
        />
      </div>
      <div class="pl-5">
        <Choice<BoatClassId>
          label="Your boat"
          value={boat()}
          options={BOATS}
          disabled={ready()}
          class="w-full"
          onChange={(b) => {
            setBoat(b)
            props.onChange(name(), b, false)
          }}
        />
      </div>
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5 pt-1">
        <Button
          class={ready() ? buttonClass.outline : buttonClass.primary}
          onClick={() => props.onChange(name(), boat(), !ready())}
          data-ph-capture-attribute-action={ready() ? "lobby-unready" : "lobby-ready"}
        >
          {ready() ? "Change name or boat" : "Ready"}
        </Button>
        <span class="text-xs text-muted-foreground" aria-live="polite">
          {ready() ? "You're ready. Waiting for the host to start." : "Pick your name and boat, then tell the host you're ready."}
        </span>
      </div>
    </div>
  )
}

function lobbyRole(e: Entrant) {
  if (e.controller === "ai") return `AI · ${e.difficulty}`
  if (e.controller === "human") return "host's screen"
  return e.ready ? "ready" : "choosing…"
}

/** Online lobby, for the host and for guests: the race, who's in, and (for guests) their own boat. */
export function LobbyPanel(props: {
  host: boolean
  inviteUrl: string | null
  config: RaceConfig | null
  entrants: Entrant[]
  /** Guests: their own place in the entrants, once the host has taken them in. */
  you: number | null
  status: string
  error: string | null
  onStart: () => void
  onLeave: () => void
  onSailor: (name: string, boat: BoatClassId, ready: boolean) => void
  /** Host: take an online sailor out of the lobby. */
  onRemove: (peer: string) => void
}) {
  const [copied, setCopied] = createSignal(false)
  const me = () => (props.you === null ? undefined : props.entrants[props.you])
  const waiting = () => notReady(props.entrants)
  return (
    <Panel title={props.host ? "Online race" : "Joining a race"} class="space-y-4">
      <Show when={props.host && props.inviteUrl}>
        {(url) => (
          <div>
            <div class="mb-1 text-sm font-medium">Invite link</div>
            <div class="flex gap-2">
              <input
                readonly
                value={url()}
                aria-label="Invite link"
                class="h-9 min-w-0 flex-1 rounded-md border border-input bg-muted px-3 text-xs shadow-xs outline-none"
                onFocus={(e) => e.currentTarget.select()}
              />
              <Button
                class={buttonClass.outline}
                onClick={() =>
                  void navigator.clipboard.writeText(url()).then(() => {
                    setCopied(true)
                    setTimeout(() => setCopied(false), 1500)
                  })
                }
              >
                {copied() ? "Copied" : "Copy"}
              </Button>
            </div>
            <p class="mt-1.5 text-xs text-muted-foreground">Send it to friends: each one gets a boat. Keep this tab open.</p>
          </div>
        )}
      </Show>
      <Show when={!props.host && props.config}>
        {(c) => (
          <div>
            <div class="mb-0.5 text-sm font-medium">The race</div>
            <p class="text-sm">{describeConfig(c())}</p>
            <p class="text-xs text-muted-foreground">The host sets the course; it's on the chart.</p>
          </div>
        )}
      </Show>
      <Show when={me()}>{(m) => <GuestSailor me={m()} onChange={props.onSailor} />}</Show>
      <Show when={props.entrants.length}>
        <div>
          <div class="mb-1 text-sm font-medium">In the lobby</div>
          <ul class="space-y-1.5">
            <For each={props.entrants} keyed={false}>
              {(e, i) => (
                <li class="flex items-center gap-2 text-sm">
                  <span class="inline-block size-3 shrink-0 rounded-full" style={{ background: e().color || "var(--muted-foreground)" }} />
                  <span class="min-w-0 flex-1 truncate">
                    {e().name}
                    <Show when={i === props.you}>
                      <span class="text-muted-foreground"> (you)</span>
                    </Show>
                  </span>
                  <span class="shrink-0 text-xs text-muted-foreground">
                    {boatClass(e().boat).name} ·{" "}
                    <span class={e().controller === "remote" ? (e().ready ? "text-good" : "text-warn") : ""}>{lobbyRole(e())}</span>
                  </span>
                  <Show when={props.host && e().peer}>
                    {(peer) => (
                      <button
                        type="button"
                        aria-label={`Remove ${e().name} from the race`}
                        title={`Remove ${e().name} from the race`}
                        onClick={() => props.onRemove(peer())}
                        data-ph-capture-attribute-action="lobby-remove"
                        class="-my-1 shrink-0 rounded-md p-1 text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/40"
                      >
                        <svg viewBox="0 0 24 24" class="size-3.5" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                          <path d="M18 6 6 18" />
                          <path d="m6 6 12 12" />
                        </svg>
                      </button>
                    )}
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </div>
      </Show>
      <Show when={props.status}>
        <p class="text-sm text-muted-foreground" aria-live="polite">
          {props.status}
        </p>
      </Show>
      <Show when={props.error}>{(e) => <p class="text-sm text-danger">{e()}</p>}</Show>
      <div class="flex flex-wrap items-center gap-2">
        <Show when={props.host}>
          <Button
            class={buttonClass.primary}
            disabled={waiting().length > 0}
            onClick={() => props.onStart()}
            data-ph-capture-attribute-action="start-online"
          >
            Start race
          </Button>
        </Show>
        <Button class={buttonClass.ghost} onClick={() => props.onLeave()}>
          {props.host ? "Cancel" : "Leave"}
        </Button>
        <Show when={props.host && waiting().length}>
          <span class="text-xs text-muted-foreground" aria-live="polite">
            Waiting for {waiting().map((e) => e.name).join(", ")} to be ready. Or remove them with ×.
          </span>
        </Show>
      </div>
    </Panel>
  )
}
