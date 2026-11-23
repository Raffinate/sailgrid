import { Button } from "@ui-sdk/solid/button"
import { For, onCleanup } from "solid-js"
import type { Plan } from "../game/boat.ts"
import { boatClass } from "../game/fleet.ts"
import type { Boat, PlanPreview } from "../game/race.ts"
import { moveNotes, pointOfSail } from "./Helm.tsx"
import { buttonClass } from "./ui.tsx"

/**
 * On narrow screens the helm card sits below the chart, so this bar stays pinned to the bottom of the
 * screen while it's your turn: tap the chart to aim, nudge the heading, see what the move will do, sail.
 * Wide screens have the helm card beside the chart and don't show it.
 */
export function ActionBar(props: {
  boat: Boat
  plan: Plan
  preview: PlanPreview
  windSpeed: number
  disabled: boolean
  onPlan: (plan: Plan) => void
  onSubmit: () => void
}) {
  const noGo = () => boatClass(props.boat.boat).polar.minTwa(props.windSpeed)
  const mv = () => props.preview.move
  const notes = () => moveNotes(props.preview, noGo())
  const turnBy = (deg: number) => props.onPlan({ heading: (((props.plan.heading + deg) % 360) + 360) % 360 })
  return (
    <div class="sticky bottom-0 z-20 -mx-4 mt-4 border-t border-border bg-card/95 px-4 pt-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] shadow-[0_-4px_12px_rgb(0_0_0/0.06)] backdrop-blur lg:hidden">
      <div class="flex items-center gap-3">
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-1.5">
            <span class="inline-block size-2.5 shrink-0 rounded-full" style={{ background: props.boat.color }} />
            <Nudge label="Turn 1° to port" disabled={props.disabled} onStep={() => turnBy(-1)}>
              −
            </Nudge>
            <span class="w-11 text-center text-base font-semibold tabular-nums" aria-live="polite" aria-label="Heading">
              {props.plan.heading}°
            </span>
            <Nudge label="Turn 1° to starboard" disabled={props.disabled} onStep={() => turnBy(1)}>
              +
            </Nudge>
          </div>
          <div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            <span class="tabular-nums">
              {pointOfSail(mv().twa, noGo())} · {props.boat.speed.toFixed(1)} → {mv().speed.toFixed(1)} kn
            </span>
            <For each={notes()}>
              {(n) => <span class={n.warn ? "font-medium text-warn" : ""}>{n.warn ? `⚠ ${n.short}` : n.short}</span>}
            </For>
          </div>
        </div>
        <Button
          class={`${buttonClass.primary} h-11 shrink-0 px-5`}
          disabled={props.disabled}
          onClick={() => props.onSubmit()}
          data-ph-capture-attribute-action="sail-bar"
        >
          Sail
        </Button>
      </div>
    </div>
  )
}

/** A heading button: tap for a degree, hold to keep turning. */
function Nudge(props: { label: string; disabled: boolean; onStep: () => void; children: string }) {
  let delay: ReturnType<typeof setTimeout> | undefined
  let repeat: ReturnType<typeof setInterval> | undefined
  const stop = () => {
    clearTimeout(delay)
    clearInterval(repeat)
    delay = repeat = undefined
  }
  onCleanup(stop)
  return (
    <button
      type="button"
      aria-label={props.label}
      disabled={props.disabled}
      class="grid size-9 shrink-0 touch-none place-items-center rounded-md border border-input bg-card text-lg leading-none shadow-xs outline-none select-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/40 disabled:opacity-50"
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        stop()
        props.onStep()
        delay = setTimeout(() => (repeat = setInterval(() => props.onStep(), 70)), 400)
      }}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      // Keyboard activation (a click with no pointer behind it).
      onClick={(e) => e.detail === 0 && props.onStep()}
    >
      {props.children}
    </button>
  )
}
