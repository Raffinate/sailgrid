import { SegmentedControl, SegmentedControlIndicator, SegmentedControlItem } from "@ui-sdk/solid/segmented-control"
import { Select, SelectContent, SelectItem, SelectItemIndicator, SelectTrigger, SelectValue } from "@ui-sdk/solid/select"
import { For, type Element as JSXElement } from "solid-js"

/** A card section. `flush` drops the padding for content that brings its own. */
export function Panel(props: { title?: string; class?: string; flush?: boolean; children: JSXElement }) {
  return (
    <section class={["rounded-xl border border-border bg-card shadow-xs", !props.flush && "p-4 sm:p-5", props.class]}>
      {props.title && <h2 class="mb-4 text-sm font-semibold">{props.title}</h2>}
      {props.children}
    </section>
  )
}

export function Kbd(props: { children: JSXElement }) {
  return (
    <kbd class="ml-1.5 rounded border border-current/25 px-1 py-px font-sans text-[0.6875rem] leading-none opacity-70">
      {props.children}
    </kbd>
  )
}

const base =
  "inline-flex h-9 items-center justify-center gap-1 rounded-md text-sm font-medium whitespace-nowrap outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-50"

export const buttonClass = {
  primary: `${base} bg-primary px-4 text-primary-foreground shadow-xs hover:opacity-90`,
  outline: `${base} border border-input bg-card px-4 text-foreground shadow-xs hover:bg-accent`,
  ghost: `${base} px-3 text-muted-foreground hover:bg-accent hover:text-foreground`,
  danger: `${base} bg-danger px-4 text-white shadow-xs hover:opacity-90`,
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

const segmentClass =
  "relative rounded-md px-2.5 py-1 text-xs font-medium text-muted-foreground outline-none data-checked:text-foreground focus-visible:ring-3 focus-visible:ring-ring/40 data-disabled:opacity-50"

/** A small segmented control for a few mutually exclusive options. */
export function Segmented<T extends string>(props: {
  label: string
  value: T
  options: readonly (readonly [T, string])[]
  disabled?: boolean
  onChange: (value: T) => void
}) {
  return (
    <SegmentedControl
      aria-label={props.label}
      value={props.value}
      disabled={props.disabled}
      onValueChange={(v) => v && props.onChange(v as T)}
      class="inline-flex rounded-lg bg-muted p-0.5"
    >
      <SegmentedControlIndicator class="rounded-md bg-card shadow-sm" />
      <For each={props.options}>
        {([value, text]) => (
          <SegmentedControlItem value={value} class={segmentClass}>
            {text}
          </SegmentedControlItem>
        )}
      </For>
    </SegmentedControl>
  )
}

const check = (
  <svg viewBox="0 0 24 24" class="size-4" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
    <path d="M20 6 9 17l-5-5" />
  </svg>
)

const itemClass = "flex cursor-default items-center justify-between gap-4 rounded-sm px-2 py-1.5 outline-none data-highlighted:bg-accent"

/** A dropdown of a few options. */
export function Choice<T extends string>(props: {
  label: string
  value: T
  options: readonly (readonly [T, string])[]
  disabled?: boolean
  class?: string
  onChange: (value: T) => void
}) {
  return (
    <Select
      items={props.options.map(([value, label]) => ({ value, label }))}
      value={props.value}
      disabled={props.disabled}
      onValueChange={(v) => v && props.onChange(v as T)}
    >
      <SelectTrigger
        aria-label={props.label}
        class={[
          "flex h-8 items-center justify-between gap-2 rounded-md border border-input bg-card px-2.5 text-left text-sm shadow-xs outline-none focus-visible:ring-3 focus-visible:ring-ring/40 data-disabled:opacity-60",
          props.class,
        ]}
      >
        <SelectValue />
        <svg viewBox="0 0 24 24" class="size-4 shrink-0 opacity-60" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </SelectTrigger>
      <SelectContent class="m-0 overflow-y-auto rounded-md border border-border bg-card p-1 text-sm text-foreground shadow-lg outline-none">
        <For each={props.options}>
          {([value, text]) => (
            <SelectItem value={value} class={itemClass}>
              {text}
              <SelectItemIndicator>{check}</SelectItemIndicator>
            </SelectItem>
          )}
        </For>
      </SelectContent>
    </Select>
  )
}
