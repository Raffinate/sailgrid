import { createMemo, For, Show } from "solid-js"
import { boomAngle } from "../game/boat.ts"
import { bearing, dirVec } from "../game/geom.ts"

interface CompassProps {
  heading: number
  windFrom: number
  /** Half-width of the no-go zone around the wind. */
  noGo: number
  color: string
  /** The boat's polar: speed (knots) at a true wind angle and wind speed. */
  polarAt: (twa: number, tws: number) => number
  /** Wind speed where the boat is, knots. */
  windSpeed: number
  disabled?: boolean
  onHeading: (deg: number) => void
}

const R = 70
const C = 90

const at = (deg: number, r: number) => {
  const v = dirVec(deg)
  return { x: C + v.x * r, y: C + v.y * r }
}

function arcPath(from: number, to: number, r: number) {
  const a = at(from, r)
  const b = at(to, r)
  const large = (((to - from) % 360) + 360) % 360 > 180 ? 1 : 0
  return `M ${C} ${C} L ${a.x} ${a.y} A ${r} ${r} 0 ${large} 1 ${b.x} ${b.y} Z`
}

/**
 * Heading dial, north up: drag the boat around. Drawn on it: the wind, the no-go zone, and the boat's
 * polar diagram turned to the wind: thin curves for the standard wind speeds and a bold one for the wind
 * where the boat is, all on one scale, so a curve's distance from the middle is how fast each heading sails.
 */

/** Reference wind speeds for the thin polar curves, knots. */
const BASE_WINDS = [6, 8, 10, 12, 16, 20]
/** The ones labelled along the downwind axis. */
const LABELLED = new Set([6, 12, 20])
export function Compass(props: CompassProps) {
  let svg!: SVGSVGElement
  let dragging = false
  const set = (e: PointerEvent) => {
    if (props.disabled) return
    const r = svg.getBoundingClientRect()
    const p = { x: ((e.clientX - r.left) / r.width) * 180, y: ((e.clientY - r.top) / r.height) * 180 }
    if (Math.hypot(p.x - C, p.y - C) < 8) return
    props.onHeading(Math.round(bearing({ x: C, y: C }, p)) % 360)
  }
  const twa = () => ((props.windFrom - props.heading + 540) % 360) - 180
  const boomEnd = () => {
    const boom = boomAngle(twa())
    const dir = props.heading + 180 + (twa() >= 0 ? boom : -boom)
    const mast = at(props.heading, 6)
    const v = dirVec(dir)
    return { x1: mast.x, y1: mast.y, x2: mast.x + v.x * 20, y2: mast.y + v.y * 20 }
  }
  const hull = () => {
    const f = dirVec(props.heading)
    const r = { x: -f.y, y: f.x }
    const pt = (fw: number, rt: number) => `${C + (f.x * fw + r.x * rt) * 38},${C + (f.y * fw + r.y * rt) * 38}`
    return [pt(0.55, 0), pt(0.12, 0.19), pt(-0.42, 0.15), pt(-0.42, -0.15), pt(0.12, -0.19)].join(" ")
  }
  const twaFor = (h: number) => ((props.windFrom - h + 540) % 360) - 180
  const speedAt = (h: number, tws: number) => props.polarAt(twaFor(h), tws)
  // One scale for every curve: the fastest speed among them reaches just inside the ring.
  const scale = createMemo(() => {
    let max = 0.1
    for (const tws of [...BASE_WINDS, props.windSpeed]) for (let a = 0; a <= 180; a += 2) max = Math.max(max, props.polarAt(a, tws))
    return (R - 8) / max
  })
  const curve = (tws: number) => {
    const d: string[] = []
    for (let h = 0; h < 360; h += 2) {
      const p = at(h, speedAt(h, tws) * scale())
      d.push(`${h ? "L" : "M"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    }
    return `${d.join(" ")} Z`
  }
  const baseCurves = createMemo(() =>
    BASE_WINDS.map((tws) => {
      const label = at(props.windFrom + 180, speedAt(Math.round(props.windFrom + 180) % 360, tws) * scale())
      return { tws, d: curve(tws), label }
    }),
  )
  const current = createMemo(() => curve(props.windSpeed))
  const onCurve = (h: number) => at(h, speedAt(h, props.windSpeed) * scale())
  const windArrow = () => {
    const tail = at(props.windFrom, R + 16)
    const tip = at(props.windFrom, R - 6)
    return { tail, tip }
  }
  return (
    <svg
      ref={svg}
      viewBox="0 0 180 180"
      class={["mx-auto block w-full max-w-[16rem] touch-none select-none", props.disabled ? "opacity-60" : "cursor-pointer"]}
      role="slider"
      aria-label="Heading"
      aria-valuemin={0}
      aria-valuemax={359}
      aria-valuenow={props.heading}
      aria-valuetext={`${props.heading}°`}
      onPointerDown={(e) => {
        if (props.disabled) return
        dragging = true
        svg.setPointerCapture(e.pointerId)
        set(e)
      }}
      onPointerMove={(e) => dragging && set(e)}
      onPointerUp={() => (dragging = false)}
      onPointerCancel={() => (dragging = false)}
    >
      <circle cx={C} cy={C} r={R} fill="var(--water)" stroke="var(--border)" />
      <path d={arcPath(props.windFrom - props.noGo, props.windFrom + props.noGo, R)} fill="var(--danger)" opacity="0.13" />
      <For each={Array.from({ length: 36 }, (_, i) => i * 10)}>
        {(deg) => {
          const a = at(deg, R)
          const b = at(deg, deg % 90 === 0 ? R - 9 : deg % 30 === 0 ? R - 6 : R - 3.5)
          return <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="var(--muted-foreground)" stroke-width={deg % 90 === 0 ? 1.5 : 0.75} />
        }}
      </For>
      <For each={[["N", 0], ["E", 90], ["S", 180], ["W", 270]] as const}>
        {([l, deg]) => {
          const p = at(deg, R - 17)
          return (
            <text x={p.x} y={p.y} text-anchor="middle" dominant-baseline="central" font-size="10" font-weight="600" fill="var(--muted-foreground)">
              {l}
            </text>
          )
        }}
      </For>
      {/* Wind: an arrow from outside the ring, blowing in. */}
      <line
        x1={windArrow().tail.x}
        y1={windArrow().tail.y}
        x2={windArrow().tip.x}
        y2={windArrow().tip.y}
        stroke="var(--wind)"
        stroke-width="2.5"
        stroke-linecap="round"
      />
      <circle cx={windArrow().tip.x} cy={windArrow().tip.y} r="3" fill="var(--wind)" />
      {/* The polar: thin curves for the standard wind speeds, bold for the wind here. */}
      <For each={baseCurves()}>
        {(c) => <path d={c.d} fill="none" stroke="var(--muted-foreground)" stroke-opacity="0.45" stroke-width="0.75" stroke-linejoin="round" />}
      </For>
      <path d={current()} fill="var(--wind)" fill-opacity="0.12" stroke="var(--wind)" stroke-width="1.75" stroke-linejoin="round" />
      <For each={baseCurves()}>
        {(c) => (
          <Show when={LABELLED.has(c.tws)}>
            <text
              x={c.label.x}
              y={c.label.y}
              text-anchor="middle"
              dominant-baseline="central"
              font-size="6.5"
              fill="var(--muted-foreground)"
              stroke="var(--water)"
              stroke-width="2"
              paint-order="stroke"
            >
              {c.tws}
            </text>
          </Show>
        )}
      </For>
      {/* Heading line and the boat. */}
      <line
        x1={C}
        y1={C}
        x2={at(props.heading, R - 2).x}
        y2={at(props.heading, R - 2).y}
        stroke={props.color}
        stroke-width="1.5"
        stroke-dasharray="3 3"
      />
      <polygon points={hull()} fill={props.color} stroke="var(--card)" stroke-width="1.5" />
      <line {...boomEnd()} stroke="var(--foreground)" stroke-width="2" stroke-linecap="round" />
      {/* Where the planned heading meets the polar, and how fast that is. */}
      <Show when={speedAt(props.heading, props.windSpeed) > 0}>
        <circle cx={onCurve(props.heading).x} cy={onCurve(props.heading).y} r="4.5" fill={props.color} stroke="var(--card)" stroke-width="2" />
      </Show>
      <circle cx={at(props.heading, R - 2).x} cy={at(props.heading, R - 2).y} r="5" fill={props.color} stroke="var(--card)" stroke-width="1.5" />
    </svg>
  )
}
