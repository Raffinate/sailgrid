import { Field, FieldLabel } from "@ui-sdk/solid/field"
import { NumberInput, NumberInputControl, NumberInputGroup } from "@ui-sdk/solid/number-input"
import { Slider, SliderControl, SliderIndicator, SliderThumb, SliderTrack } from "@ui-sdk/solid/slider"
import type { Element as JSXElement } from "solid-js"

interface RangeFieldProps {
  label: string
  unit: string
  value: number
  min: number
  max: number
  step: number
  onChange: (value: number) => void
  hint?: JSXElement
  color?: string
}

export function RangeField(props: RangeFieldProps) {
  return (
    <div>
      <div class="grid grid-cols-[1fr_auto] items-end gap-x-3">
        <Field class="min-w-0">
          <Slider
            value={props.value}
            min={props.min}
            max={props.max}
            step={props.step}
            onValueChange={(v) => props.onChange(v as number)}
          >
            <FieldLabel class="flex items-center gap-2 text-sm font-medium">
              <span class="inline-block size-2.5 rounded-full" style={{ background: props.color ?? "var(--foreground)" }} />
              {props.label}
            </FieldLabel>
            <SliderControl class="flex h-9 w-full touch-none items-center">
              <SliderTrack class="relative h-1.5 w-full rounded-full bg-muted">
                <SliderIndicator class="absolute h-full rounded-full bg-foreground/60" />
                <SliderThumb class="absolute top-1/2 block size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border border-foreground/40 bg-card shadow-sm has-focus-visible:ring-4 has-focus-visible:ring-ring/40" />
              </SliderTrack>
            </SliderControl>
          </Slider>
        </Field>
        <NumberInput
          value={props.value}
          min={props.min}
          max={props.max}
          step={props.step}
          onValueChange={(v) => {
            if (v !== null) props.onChange(v)
          }}
        >
          <NumberInputGroup class="flex h-9 w-24 items-center rounded-md border border-input bg-card pr-2 shadow-xs focus-within:ring-3 focus-within:ring-ring/40">
            <NumberInputControl
              aria-label={`${props.label} (${props.unit})`}
              class="w-full min-w-0 bg-transparent px-2 text-right text-sm tabular-nums outline-none"
            />
            <span class="text-xs whitespace-nowrap text-muted-foreground">{props.unit}</span>
          </NumberInputGroup>
        </NumberInput>
      </div>
      {props.hint}
    </div>
  )
}
