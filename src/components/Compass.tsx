import { For } from "solid-js"
import { bearing, dirVec } from "../game/geom.ts"

interface CompassProps {
  heading: number
  sail: number
  windFrom: number
  /** Half-width of the no-go zone around the wind. */
  noGo: number
  color: string
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

/** Heading dial, north up: drag the boat around. The wind and the no-go zone are drawn on it. */
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
    const dir = props.heading + 180 + (twa() >= 0 ? props.sail : -props.sail)
    const mast = at(props.heading, 10)
    const v = dirVec(dir)
    return { x1: mast.x, y1: mast.y, x2: mast.x + v.x * 30, y2: mast.y + v.y * 30 }
  }
  const hull = () => {
    const f = dirVec(props.heading)
    const r = { x: -f.y, y: f.x }
    const pt = (fw: number, rt: number) => `${C + (f.x * fw + r.x * rt) * 56},${C + (f.y * fw + r.y * rt) * 56}`
    return [pt(0.55, 0), pt(0.12, 0.19), pt(-0.42, 0.15), pt(-0.42, -0.15), pt(0.12, -0.19)].join(" ")
  }
  const windArrow = () => {
    const tail = at(props.windFrom, R + 16)
    const tip = at(props.windFrom, R - 6)
    return { tail, tip }
  }
  return (
    <svg
      ref={svg}
      viewBox="0 0 180 180"
      class={["mx-auto block w-full max-w-[13rem] touch-none select-none", props.disabled ? "opacity-60" : "cursor-pointer"]}
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
      <line {...boomEnd()} stroke="var(--foreground)" stroke-width="2.5" stroke-linecap="round" />
      <circle cx={at(props.heading, R - 2).x} cy={at(props.heading, R - 2).y} r="5" fill={props.color} stroke="var(--card)" stroke-width="1.5" />
    </svg>
  )
}
