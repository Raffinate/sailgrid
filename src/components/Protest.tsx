import { Dialog, DialogBackdrop, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@ui-sdk/solid/dialog"
import { createEffect, createSignal, onSettled, Show } from "solid-js"
import { SAMPLE } from "../game/boat.ts"
import type { Pt } from "../game/geom.ts"
import type { GameMap } from "../game/map.ts"
import { CONTACT, type Incident, type RaceState, RULE_TEXT } from "../game/race.ts"
import { drawIncident, type IncidentBoat, readPalette } from "./draw.ts"

/** The path a boat sailed in a given turn, if this device saw it. */
export type WakeOf = (turn: number, boat: number) => Pt[] | null

const THUMB = { width: 88, height: 66 }
const BIG = { width: 560, height: 420 }

/** Bumps whenever the theme changes, so pictures repaint in the new colours. */
function themeTick() {
  const [tick, setTick] = createSignal(0)
  onSettled(() => {
    const mo = new MutationObserver(() => setTick((t) => t + 1))
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] })
    return () => mo.disconnect()
  })
  return tick
}

const incidentBoats = (state: RaceState, inc: Incident, wake: WakeOf): IncidentBoat[] =>
  [inc.boat, inc.other]
    .filter((id) => id !== undefined)
    .map((id, i) => {
      const b = state.boats[id]
      const at = inc.sketch!.boats[i] ?? inc.sketch!.boats[0]
      return { color: b?.color ?? "gray", name: b?.name ?? "?", path: wake(inc.turn, id), pos: at.pos, heading: at.heading }
    })

/** An incident close up, north up (see drawIncident). Draws nothing for an incident without a sketch. */
export function IncidentPicture(props: {
  map: GameMap
  state: RaceState
  inc: Incident
  wake: WakeOf
  big?: boolean
  class?: string
}) {
  let canvas!: HTMLCanvasElement
  const tick = themeTick()
  const size = () => (props.big ? BIG : THUMB)
  createEffect(
    () => ({ map: props.map, state: props.state, inc: props.inc, big: !!props.big, tick: tick() }),
    ({ map, state, inc, big }) => {
      const s = inc.sketch
      if (!s || !canvas) return
      const { width, height } = size()
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      const ctx = canvas.getContext("2d")!
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const radius = inc.other !== undefined ? CONTACT / 2 + 0.15 : 0.5
      drawIncident(ctx, map, readPalette(), { width, height }, { at: s.at, radius }, s.wind, incidentBoats(state, inc, props.wake), big)
    },
  )
  return (
    <canvas
      ref={canvas}
      class={["block rounded-md", props.class ?? ""]}
      style={{ width: `${size().width}px`, "max-width": "100%", "aspect-ratio": `${size().width} / ${size().height}` }}
      role="img"
      aria-label={`${RULE_TEXT[props.inc.rule]}: the boats' paths that turn, north up`}
    />
  )
}

export const incidentTitle = (state: RaceState, inc: Incident) => {
  const name = (id: number) => state.boats[id]?.name ?? "?"
  return `T${inc.turn + 1} · ${name(inc.boat)}${inc.other !== undefined ? ` vs ${name(inc.other)}` : ""}`
}

/** One incident, big, in a dialog. */
export function ProtestDialog(props: {
  map: GameMap
  state: RaceState
  inc: Incident | null
  wake: WakeOf
  onClose: () => void
}) {
  return (
    <Dialog open={props.inc !== null} onOpenChange={(open) => !open && props.onClose()}>
      <DialogBackdrop class="fixed inset-0 z-50 bg-black/50 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0" />
      <DialogContent
        initialFocus="content"
        class="fixed inset-0 z-50 m-auto flex h-fit max-h-[calc(100dvh-2rem)] w-[min(37rem,calc(100%-2rem))] flex-col rounded-xl border border-border bg-card text-foreground shadow-xl outline-none transition-[opacity,scale] duration-150 data-ending-style:scale-97 data-ending-style:opacity-0 data-starting-style:scale-97 data-starting-style:opacity-0 motion-reduce:transition-none"
      >
        <Show when={props.inc}>
          {(inc) => (
            <>
              <div class="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
                <div>
                  <DialogTitle class="text-base font-semibold">{incidentTitle(props.state, inc())}</DialogTitle>
                  <DialogDescription class="mt-0.5 text-sm text-muted-foreground">
                    {inc().rule === "aground" || inc().rule === "31" ? "" : `Rule ${inc().rule}: `}
                    {RULE_TEXT[inc().rule]} · +{inc().penalty} {inc().penalty === 1 ? "turn" : "turns"}
                    <Show when={inc().sketch}>{(s) => <> · {Math.round(s().k * SAMPLE)} s into the turn</>}</Show>
                  </DialogDescription>
                </div>
                <DialogClose
                  aria-label="Close"
                  class="-mr-1 rounded-md p-1 text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/40"
                >
                  <svg viewBox="0 0 24 24" class="size-4" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                    <path d="M18 6 6 18" />
                    <path d="m6 6 12 12" />
                  </svg>
                </DialogClose>
              </div>
              <div class="px-5 py-4">
                <IncidentPicture map={props.map} state={props.state} inc={inc()} wake={props.wake} big class="w-full" />
                <p class="mt-2 text-xs text-muted-foreground">
                  North is up. Each line is a boat's path that turn, from the dot where it started; the boats are drawn
                  where they were at that moment, and the dashed circle marks the spot.
                </p>
              </div>
            </>
          )}
        </Show>
      </DialogContent>
    </Dialog>
  )
}
