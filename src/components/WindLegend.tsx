import { SHADE_FULL_KNOTS, SHADE_MAX_ALPHA, WIND_HUES, windColor } from "./draw.ts"

const TOP_KNOTS = WIND_HUES[WIND_HUES.length - 1][0]

/** A knot scale bar: a gradient from 0 kn to `top` kn with a few ticks under it. */
function ScaleBar(props: { label: string; background: string; top: number; ticks: number[] }) {
  return (
    <span class="inline-flex items-center gap-2">
      <span>{props.label}</span>
      <span class="inline-flex flex-col gap-0.5">
        <span class="block h-1.5 w-32 rounded-full border border-border" style={{ background: props.background }} />
        <span class="relative block h-3 w-32 text-[10px] leading-3 tabular-nums">
          {props.ticks.map((k) => (
            <span class="absolute -translate-x-1/2" style={{ left: `${(100 * k) / props.top}%` }}>
              {k}
            </span>
          ))}
        </span>
      </span>
      <span>kn</span>
    </span>
  )
}

/** What the arrow colours and the water shading mean in knots. */
export function WindLegend() {
  const arrowGradient = `linear-gradient(to right, ${WIND_HUES.map(([k]) => `${windColor("var(--wind-scale)", k)} ${(100 * k) / TOP_KNOTS}%`).join(", ")})`
  const shadeGradient = `linear-gradient(to right, var(--water), color-mix(in oklab, var(--shade) ${SHADE_MAX_ALPHA * 100}%, var(--water)))`
  return (
    <>
      <ScaleBar label="Arrows" background={arrowGradient} top={TOP_KNOTS} ticks={[0, 10, 20, 30]} />
      <ScaleBar label="Water" background={shadeGradient} top={SHADE_FULL_KNOTS} ticks={[0, 10, 20, 30]} />
    </>
  )
}
