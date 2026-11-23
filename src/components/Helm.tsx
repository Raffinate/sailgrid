import { Button } from "@ui-sdk/solid/button"
import { Show } from "solid-js"
import { type Plan, tackOf } from "../game/boat.ts"
import { boatClass } from "../game/fleet.ts"
import type { GameMap } from "../game/map.ts"
import type { Boat, PlanPreview } from "../game/race.ts"
import { CELL_METERS } from "../game/units.ts"
import { Compass } from "./Compass.tsx"
import { RangeField } from "./RangeField.tsx"
import { buttonClass, Kbd, Panel } from "./ui.tsx"

export function pointOfSail(twa: number, noGo: number) {
  const a = Math.abs(twa)
  if (a < noGo) return "In irons"
  if (a < 55) return "Close-hauled"
  if (a < 80) return "Close reach"
  if (a < 105) return "Beam reach"
  if (a < 155) return "Broad reach"
  return "Running"
}

export function gateLabel(map: GameMap, next: number) {
  const g = map.gates[next]
  if (!g) return "Finished"
  if (g.kind === "start") return "Cross the start line"
  if (g.kind === "finish") return "Cross the finish line"
  return `Round mark ${next}, leave it to ${g.side}`
}

export interface MoveNote {
  /** A word or two, for the action bar. */
  short: string
  /** The full explanation, for the helm card. */
  long: string
  /** It costs you: a penalty, or no drive at all. Tacks and gybes are just worth knowing. */
  warn: boolean
}

/** What's worth knowing about a planned move before sailing it. */
export function moveNotes(p: PlanPreview, noGo: number): MoveNote[] {
  const mv = p.move
  const out: MoveNote[] = []
  if (Math.abs(mv.twa) < noGo) out.push({ short: "No drive", long: "Pointing into the wind: no drive.", warn: true })
  if (p.aground) out.push({ short: "Runs aground", long: "This runs aground: you'll stop short and take a penalty.", warn: true })
  if (p.touchesMark) out.push({ short: "Touches mark", long: "Too close: you'll touch the mark (penalty).", warn: true })
  if (mv.tacked)
    out.push({
      short: "Tack",
      long: "Tacking: the sails stop drawing as the bow crosses the wind, and you must keep clear of other boats.",
      warn: false,
    })
  if (mv.gybed) out.push({ short: "Gybe", long: "Gybing: the boom comes across, a little speed lost.", warn: false })
  return out
}

function Row(props: { label: string; value: string; sub?: string; tone?: "good" | "warn" | "danger" }) {
  return (
    <div class="flex items-baseline justify-between gap-3 text-sm">
      <span class="text-muted-foreground">{props.label}</span>
      <span
        class={[
          "text-right font-medium tabular-nums",
          props.tone === "good" && "text-good",
          props.tone === "warn" && "text-warn",
          props.tone === "danger" && "text-danger",
        ]}
      >
        {props.value}
        <Show when={props.sub}>
          <span class="ml-1 text-xs font-normal text-muted-foreground">{props.sub}</span>
        </Show>
      </span>
    </div>
  )
}

interface HelmProps {
  map: GameMap
  boat: Boat
  turn: number
  plan: Plan
  preview: PlanPreview
  windFrom: number
  windSpeed: number
  disabled: boolean
  onPlan: (plan: Plan) => void
  onSubmit: () => void
}

/** The controls for the boat whose turn it is: where to steer, and what that will do. The crew trims. */
export function Helm(props: HelmProps) {
  const mv = () => props.preview.move
  const cls = () => boatClass(props.boat.boat)
  const noGo = () => cls().polar.minTwa(props.windSpeed)
  const dips = () => mv().carried < Math.min(props.boat.speed, mv().speed) - 0.3
  const warnings = () => moveNotes(props.preview, noGo()).map((n) => n.long)
  return (
    <Panel class="space-y-4">
      <div class="flex items-center justify-between gap-3">
        <h2 class="flex items-center gap-2 text-sm font-semibold">
          <span class="inline-block size-3 rounded-full" style={{ background: props.boat.color }} />
          {props.boat.name}
          <span class="font-normal text-muted-foreground">at the helm</span>
        </h2>
        <span class="text-xs text-muted-foreground tabular-nums">Turn {props.turn + 1}</span>
      </div>
      <p class="-mt-2 text-xs text-muted-foreground">
        {cls().name} · {gateLabel(props.map, props.boat.next)}
      </p>

      <Compass
        heading={props.plan.heading}
        windFrom={props.windFrom}
        noGo={noGo()}
        color={props.boat.color}
        polarAt={(twa, tws) => cls().polar.speed(twa, tws)}
        windSpeed={props.windSpeed}
        disabled={props.disabled}
        onHeading={(heading) => props.onPlan({ heading })}
      />
      <p class="-mt-2 text-center text-xs text-muted-foreground">
        Your boat's polar: thin curves for 6–20 kn of wind (labelled downwind), the bold blue one for the {Math.round(props.windSpeed)} kn here.
      </p>

      <RangeField
        label="Heading"
        unit="°"
        value={props.plan.heading}
        min={0}
        max={359}
        step={1}
        color={props.boat.color}
        onChange={(heading) => props.onPlan({ heading: Math.round(heading) % 360 })}
      />

      <div class="space-y-1.5 rounded-lg bg-muted px-3 py-2.5">
        <Row label="Wind" value={`${Math.round(props.windSpeed)} kn`} sub={`from ${Math.round(props.windFrom)}°`} />
        <Row
          label="Wind angle"
          value={`${Math.abs(Math.round(mv().twa))}°`}
          sub={`${pointOfSail(mv().twa, noGo())}, ${tackOf(mv().heading, props.windFrom)} tack`}
        />
        <Row
          label="Speed"
          value={`${props.boat.speed.toFixed(1)} → ${mv().speed.toFixed(1)} kn`}
          sub={dips() ? `dips to ${mv().carried.toFixed(1)}` : `polar ${mv().target.toFixed(1)}`}
          tone={mv().carried < Math.min(props.boat.speed, mv().speed) - 1 ? "warn" : undefined}
        />
        <Row
          label="This minute"
          value={`${Math.round((mv().distance * CELL_METERS) / 10) * 10} m`}
          sub={mv().turnSeconds ? `${mv().turnSeconds} s turning` : "straight on"}
        />
      </div>

      <Show when={warnings().length}>
        <ul class="space-y-1 text-xs text-warn">
          {warnings().map((w) => (
            <li>{w}</li>
          ))}
        </ul>
      </Show>

      <Button
        class={`${buttonClass.primary} w-full`}
        disabled={props.disabled}
        onClick={() => props.onSubmit()}
        data-ph-capture-attribute-action="sail"
      >
        Sail this turn
        <Kbd>Enter</Kbd>
      </Button>
      <p class="text-center text-xs text-muted-foreground">
        Click or drag on the chart to aim. <Kbd>←</Kbd>
        <Kbd>→</Kbd> to steer (<Kbd>Shift</Kbd> for 10°).
      </p>
    </Panel>
  )
}
