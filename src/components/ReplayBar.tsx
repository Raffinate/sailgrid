import { Button } from "@ui-sdk/solid/button"
import { Show } from "solid-js"

/**
 * Once the race is over: scrub through it turn by turn, or play it back. Sits right under the chart, so it's
 * next to the map on a phone too. Each player's replay is their own; nothing goes over the network.
 */
export function ReplayBar(props: {
  /** Turns sailed at the point shown. */
  turn: number
  last: number
  playing: boolean
  onTurn: (turn: number) => void
  onPlay: () => void
}) {
  return (
    <div class="flex items-center gap-2 px-1">
      <Button
        class="inline-flex size-9 shrink-0 items-center justify-center rounded-md border border-input bg-card text-foreground shadow-xs outline-none transition-colors hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/40"
        aria-label={props.playing ? "Pause the replay" : "Play the replay"}
        onClick={() => props.onPlay()}
        data-ph-capture-attribute-action={props.playing ? "replay-pause" : "replay-play"}
      >
        <Show
          when={props.playing}
          fallback={
            <svg viewBox="0 0 24 24" class="size-4 shrink-0" fill="currentColor" aria-hidden="true">
              <path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z" />
            </svg>
          }
        >
          <svg viewBox="0 0 24 24" class="size-4 shrink-0" fill="currentColor" aria-hidden="true">
            <rect x="6" y="5" width="4" height="14" rx="1" />
            <rect x="14" y="5" width="4" height="14" rx="1" />
          </svg>
        </Show>
      </Button>
      <input
        type="range"
        min={0}
        max={props.last}
        step={1}
        value={props.turn}
        aria-label="Replay: turn"
        onInput={(e) => props.onTurn(Number(e.currentTarget.value))}
        class="h-9 min-w-0 flex-1 cursor-pointer accent-current"
      />
      <span class="w-24 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
        Turn {props.turn} / {props.last}
      </span>
    </div>
  )
}
