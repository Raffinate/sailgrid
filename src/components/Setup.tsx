import { Button } from "@ui-sdk/solid/button"
import { Input } from "@ui-sdk/solid/input"
import { createSignal, For, Show } from "solid-js"
import type { CourseKind, IslandDensity, MapSize, RaceConfig, Shiftiness } from "../game/map.ts"
import { parseJoinId } from "../game/multiplayer.ts"
import type { Difficulty, Entrant } from "../game/race.ts"
import { randomSeed } from "../game/rng.ts"
import { BOAT_COLORS, MAX_BOATS } from "../game/session.ts"
import { RangeField } from "./RangeField.tsx"
import { buttonClass, Choice, Panel, Segmented } from "./ui.tsx"

export type PlayerKind = "human" | Difficulty

export interface SetupPlayer {
  name: string
  kind: PlayerKind
}

const KINDS = [
  ["human", "Human"],
  ["easy", "AI · easy"],
  ["medium", "AI · medium"],
  ["hard", "AI · hard"],
] as const

const AI_NAMES = ["Tern", "Petrel", "Gannet", "Skua", "Fulmar", "Kittiwake", "Shearwater", "Puffin"]

export const defaultPlayers = (): SetupPlayer[] => [
  { name: "You", kind: "human" },
  { name: "Tern", kind: "hard" },
  { name: "Petrel", kind: "medium" },
  { name: "Gannet", kind: "easy" },
]

export const toEntrants = (players: SetupPlayer[]): Entrant[] =>
  players.map((p, i) => ({
    name: p.name.trim() || (p.kind === "human" ? `Sailor ${i + 1}` : AI_NAMES[i % AI_NAMES.length]),
    color: BOAT_COLORS[i % BOAT_COLORS.length],
    controller: p.kind === "human" ? "human" : "ai",
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

/** Course, wind and map settings. */
export function CoursePanel(props: { config: RaceConfig; disabled?: boolean; onChange: (c: RaceConfig) => void }) {
  const set = <K extends keyof RaceConfig>(k: K, v: RaceConfig[K]) => props.onChange({ ...props.config, [k]: v })
  return (
    <Panel title="Course" class="space-y-3.5">
      <Setting label="Course">
        <Segmented<CourseKind>
          label="Course"
          value={props.config.course}
          disabled={props.disabled}
          options={[
            ["windward-leeward", "Windward–leeward"],
            ["islands", "Round the islands"],
          ]}
          onChange={(v) => set("course", v)}
        />
      </Setting>
      <Show when={props.config.course === "windward-leeward"}>
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
      <Setting label="Wind shifts">
        <Segmented<Shiftiness>
          label="Wind shifts"
          value={props.config.shifts}
          disabled={props.disabled}
          options={[
            ["steady", "Steady"],
            ["shifty", "Shifty"],
          ]}
          onChange={(v) => set("shifts", v)}
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
            value={String(props.config.seed)}
            disabled={props.disabled}
            onChange={(e: Event) => {
              const n = Number((e.currentTarget as HTMLInputElement).value)
              if (Number.isFinite(n) && n >= 0) set("seed", Math.floor(n))
            }}
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
    props.onChange([...props.players, { name, kind }])
  }
  return (
    <Panel title="Sailors" class="space-y-3">
      <ul class="space-y-2">
        <For each={props.players}>
          {(p, i) => (
            <li class="flex items-center gap-2">
              <span class="inline-block size-3 shrink-0 rounded-full" style={{ background: BOAT_COLORS[i() % BOAT_COLORS.length] }} />
              <Input
                value={p.name}
                disabled={props.disabled}
                aria-label="Name"
                maxlength={20}
                onChange={(e: Event) => update(i(), { name: (e.currentTarget as HTMLInputElement).value })}
                class="h-8 min-w-0 flex-1 rounded-md border border-input bg-card px-2.5 text-sm shadow-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
              />
              <Choice<PlayerKind>
                label="Who sails it"
                value={p.kind}
                options={KINDS}
                disabled={props.disabled}
                class="w-32"
                onChange={(kind) => update(i(), { kind })}
              />
              <button
                type="button"
                aria-label={`Remove ${p.name}`}
                disabled={props.disabled || props.players.length <= 1}
                onClick={() => props.onChange(props.players.filter((_, j) => j !== i()))}
                class="rounded-md p-1 text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/40 disabled:opacity-40"
              >
                <svg viewBox="0 0 24 24" class="size-4" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                  <path d="M18 6 6 18" />
                  <path d="m6 6 12 12" />
                </svg>
              </button>
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
        <p class="mt-1.5 text-xs text-muted-foreground">You'll sail under the first name in your sailors list.</p>
      </div>
    </Panel>
  )
}

/** Online lobby, for the host and for guests. */
export function LobbyPanel(props: {
  host: boolean
  inviteUrl: string | null
  entrants: Entrant[]
  status: string
  error: string | null
  onStart: () => void
  onLeave: () => void
}) {
  const [copied, setCopied] = createSignal(false)
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
      <ul class="space-y-1.5">
        <For each={props.entrants} keyed={false}>
          {(e) => (
            <li class="flex items-center gap-2 text-sm">
              <span class="inline-block size-3 rounded-full" style={{ background: e().color || "var(--muted-foreground)" }} />
              <span class="flex-1">{e().name}</span>
              <span class="text-xs text-muted-foreground">
                {e().controller === "remote" ? "online" : e().controller === "ai" ? `AI · ${e().difficulty}` : "host's screen"}
              </span>
            </li>
          )}
        </For>
      </ul>
      <Show when={props.status}>
        <p class="text-sm text-muted-foreground" aria-live="polite">
          {props.status}
        </p>
      </Show>
      <Show when={props.error}>{(e) => <p class="text-sm text-danger">{e()}</p>}</Show>
      <div class="flex flex-wrap gap-2">
        <Show when={props.host}>
          <Button class={buttonClass.primary} onClick={() => props.onStart()} data-ph-capture-attribute-action="start-online">
            Start race
          </Button>
        </Show>
        <Button class={buttonClass.ghost} onClick={() => props.onLeave()}>
          {props.host ? "Cancel" : "Leave"}
        </Button>
      </div>
    </Panel>
  )
}
