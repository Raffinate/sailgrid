import { Dialog, DialogBackdrop, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@ui-sdk/solid/dialog"
import { For, type Element as JSXElement } from "solid-js"
import { PENALTY, RULE_TEXT, type Rule } from "../game/race.ts"

function H(props: { children: JSXElement }) {
  return <h3 class="mt-5 mb-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase first:mt-0">{props.children}</h3>
}

const rules: Rule[] = ["10", "11", "12", "13", "31", "aground"]

export function HelpDialog(props: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={props.open} onOpenChange={(open) => props.onOpenChange(open)}>
      <DialogBackdrop class="fixed inset-0 z-50 bg-black/50 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0" />
      <DialogContent
        initialFocus="content"
        class="fixed inset-0 z-50 m-auto flex h-fit max-h-[calc(100dvh-2rem)] w-[min(40rem,calc(100%-2rem))] flex-col rounded-xl border border-border bg-card text-foreground shadow-xl outline-none transition-[opacity,scale] duration-150 data-ending-style:scale-97 data-ending-style:opacity-0 data-starting-style:scale-97 data-starting-style:opacity-0 motion-reduce:transition-none"
      >
        <div class="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div>
            <DialogTitle class="text-base font-semibold">How to sail</DialogTitle>
            <DialogDescription class="mt-0.5 text-sm text-muted-foreground">
              Pencil racing on grid paper, with real wind and sails.
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
        <div class="overflow-y-auto px-5 py-4 text-sm leading-relaxed">
          <H>Each turn</H>
          <p>
            A turn is a minute of sailing; a grid cell is about 40 m. Every boat sits on a grid intersection. Each turn you
            choose a <strong>heading</strong> (the crew trims the sails), then all boats sail their minute at once and land
            on the nearest intersection. The dashed curve on the chart shows the path you'll sail.
          </p>
          <H>Pick your boat</H>
          <p>
            Four popular boats race: the J/35, the J/109, the X-35 and the Melges 24. Their speeds come from real ORC
            certificates (the median of each class). They're about equally fast overall, but each is quickest in different
            conditions, and there's no handicap: first across the line wins. So look at the wind and the course before
            you choose. The J/35 is strongest upwind; the J/109 off the wind in light and medium air; the X-35 is the
            all-rounder, never far off in light and medium air; the Melges 24 planes away in a breeze but struggles upwind. The triangle course is mostly
            reaching; windward–leeward is beats and runs. The light Melges also turns and picks up speed faster.
          </p>
          <H>Turning and speed</H>
          <p>
            The boat turns onto the new heading at 11–13° a second when it's moving (much slower when it isn't), so it
            sails an arc. Speed builds and fades over seconds to tens of seconds: boats carry their way. Bearing away costs
            almost nothing; heading up bleeds speed gradually. In a tack the sails stop drawing while the bow crosses the
            wind, costing two or three boat lengths. You can't sail closer than about 37–46° to the wind (the red wedge on
            the compass, wider in light air); point into it and the boat glides to a stop.
          </p>
          <H>Wind</H>
          <p>
            Each intersection has its own wind: the arrows show direction and strength; darker water is a puff, lighter a
            lull. Puffs travel downwind at most of the wind's speed, so look upwind to see what's coming. They grow and
            fade over a few minutes, and they veer (swing clockwise) while lulls back. The breeze also swings back and
            forth, and each shift reaches the boats further upwind first. One side of the course can be a little windier
            than the other. Islands cast wind shadow downwind (further behind higher land, and gusty inside it), the wind
            speeds up between islands and round headlands, and it bends along a shore it blows onto.
          </p>
          <H>The course</H>
          <p>
            Cross the start line upwind, then round the marks in order, leaving each one on the side its arrow shows
            (port: the mark on your left), and cross the finish line. Hitting land stops you short.
          </p>
          <H>Racing rules and penalties</H>
          <p class="mb-2">
            Boats that come within a boat-length or so of each other during a turn have met; the boat that should have kept
            clear takes a time penalty. Your result is your elapsed time (in turns) plus penalties.
          </p>
          <dl class="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5">
            <For each={rules}>
              {(r) => (
                <>
                  <dt class="font-medium">{r === "aground" ? "Shore" : r === "31" ? "Mark" : `Rule ${r}`}</dt>
                  <dd class="text-muted-foreground">
                    {RULE_TEXT[r]}: +{PENALTY[r]} {PENALTY[r] === 1 ? "turn" : "turns"}
                  </dd>
                </>
              )}
            </For>
          </dl>
          <H>Playing together</H>
          <p>
            Add several humans to take turns on one screen; the chart hides until the next sailor takes the helm. Or host
            an online race and send friends the invite link: each gets a boat, and the turn runs once everyone has chosen.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  )
}
