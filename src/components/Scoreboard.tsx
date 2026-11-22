import { For, Show } from "solid-js"
import { boatClass } from "../game/fleet.ts"
import type { GameMap } from "../game/map.ts"
import { type Boat, corrected, isRetired, type RaceState, RULE_TEXT, racing, standings } from "../game/race.ts"
import { Panel } from "./ui.tsx"

const fmt = (t: number) => t.toFixed(2)

function who(b: Boat, mine: number[]) {
  if (mine.includes(b.id)) return mine.length > 1 ? "on this screen" : "you"
  if (b.controller === "ai") return `AI · ${b.difficulty}`
  if (b.controller === "remote") return "online"
  return "human"
}

function progress(map: GameMap, b: Boat) {
  if (isRetired(b)) return "Retired"
  if (b.finish !== null) return `elapsed ${fmt(b.finish)}`
  const g = map.gates[b.next]
  if (!g) return ""
  return g.kind === "start" ? "Starting" : g.kind === "finish" ? "To finish" : `To mark ${b.next}`
}

function BoatRow(props: { boat: Boat; place: number; map: GameMap; mine: number[]; planned: boolean; showPlanned: boolean }) {
  const b = () => props.boat
  return (
    <tr class="border-t border-border align-top">
      <td class="py-1.5 pr-2 tabular-nums text-muted-foreground">{props.place}</td>
      <td class="py-1.5 pr-2">
        <div class="flex items-center gap-1.5">
          <span class="inline-block size-2.5 shrink-0 rounded-full" style={{ background: b().color }} />
          <span class={["truncate", props.mine.includes(b().id) && "font-semibold"]}>{b().name}</span>
          <Show when={props.showPlanned && racing(b()) && b().controller !== "ai"}>
            <span class={["text-xs", props.planned ? "text-good" : "text-muted-foreground"]} title={props.planned ? "Ready" : "Thinking"}>
              {props.planned ? "✓" : "…"}
            </span>
          </Show>
        </div>
        <div class="text-xs text-muted-foreground">
          {boatClass(b().boat).name} × {b().rating.toFixed(3)} · {who(b(), props.mine)}
        </div>
        <div class="text-xs text-muted-foreground tabular-nums">
          {progress(props.map, b())}
          <Show when={corrected(b()) !== null}>
            {" "}
            → <span class="font-medium text-foreground">corrected {fmt(corrected(b())!)}</span>
          </Show>
        </div>
      </td>
      <td class="py-1.5 pr-2 text-right tabular-nums">{racing(b()) ? `${b().speed.toFixed(1)} kn` : "–"}</td>
      <td class={["py-1.5 text-right tabular-nums", b().penalty > 0 && "text-danger"]}>{b().penalty || "–"}</td>
    </tr>
  )
}

/** Positions: finishers by corrected time (elapsed + penalties), then the fleet by progress. */
export function Scoreboard(props: { map: GameMap; state: RaceState; mine: number[]; planned: number[]; showPlanned: boolean }) {
  return (
    <Panel title={props.state.over ? "Results" : "Fleet"}>
      <div class="-mt-2">
        <table class="w-full text-sm">
          <thead>
            <tr class="text-left text-xs text-muted-foreground">
              <th class="py-1.5 pr-2 font-medium">#</th>
              <th class="py-1.5 pr-2 font-medium">Boat</th>
              <th class="py-1.5 pr-2 text-right font-medium">Speed</th>
              <th class="py-1.5 text-right font-medium">Pen.</th>
            </tr>
          </thead>
          <tbody>
            <For each={standings(props.state)} keyed={false}>
              {(b, i) => (
                <BoatRow
                  boat={b()}
                  place={i + 1}
                  map={props.map}
                  mine={props.mine}
                  planned={props.planned.includes(b().id)}
                  showPlanned={props.showPlanned}
                />
              )}
            </For>
          </tbody>
        </table>
        <p class="mt-2 text-xs text-muted-foreground">
          Times are in turns (minutes). Corrected time = elapsed × the boat's handicap factor, plus penalties.
        </p>
      </div>
    </Panel>
  )
}

/** Fouls and groundings, most recent first. */
export function IncidentLog(props: { state: RaceState }) {
  const items = () => [...props.state.incidents].reverse().slice(0, 40)
  const name = (id: number) => props.state.boats[id]?.name ?? "?"
  return (
    <Panel title="Protest room">
      <Show when={items().length} fallback={<p class="text-sm text-muted-foreground">Clean racing so far.</p>}>
        <ul class="max-h-64 space-y-2 overflow-y-auto text-sm">
          <For each={items()}>
            {(inc) => (
              <li class="flex gap-2">
                <span class="w-9 shrink-0 text-xs text-muted-foreground tabular-nums">T{inc.turn + 1}</span>
                <span class="inline-block size-2.5 shrink-0 translate-y-1.5 rounded-full" style={{ background: props.state.boats[inc.boat]?.color }} />
                <span class="min-w-0">
                  <span class="font-medium">{name(inc.boat)}</span>
                  <Show when={inc.other !== undefined}> vs {name(inc.other!)}</Show>
                  <span class="block text-xs text-muted-foreground">
                    {inc.rule === "aground" || inc.rule === "31" ? "" : `Rule ${inc.rule}: `}
                    {RULE_TEXT[inc.rule]} · +{inc.penalty} {inc.penalty === 1 ? "turn" : "turns"}
                  </span>
                </span>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </Panel>
  )
}
