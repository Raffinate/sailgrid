import { createMemo, createSignal, For, Show } from "solid-js"
import { DEG } from "../game/geom.ts"
import { type BoatClass, FLEET } from "../game/fleet.ts"

/**
 * The four boats' polars at one wind speed: boat speed (radius) against true wind angle, wind from the
 * top. Hover anywhere to read every boat's speed at that angle. Each boat is labelled where it leads the
 * others by the most, which is what it's good at; the table underneath has the same story in numbers.
 */

const SERIES = ["var(--series-1)", "var(--series-2)", "var(--series-3)", "var(--series-4)"]
export const boatSeries = (id: string) => SERIES[Math.max(0, FLEET.findIndex((c) => c.id === id)) % SERIES.length]

const R = 170
const CX = 34
const CY = R + 34
const W = 280
const H = CY + R + 26

const vmgUp = (c: BoatClass, w: number) => {
  let best = 0
  for (let a = 25; a <= 90; a++) best = Math.max(best, c.polar.speed(a, w) * Math.cos(a * DEG))
  return best
}
const vmgDown = (c: BoatClass, w: number) => {
  let best = 0
  for (let a = 90; a <= 180; a++) best = Math.max(best, -c.polar.speed(a, w) * Math.cos(a * DEG))
  return best
}

export function PolarChart(props: { windSpeed: number }) {
  const w = () => props.windSpeed
  const maxSpeed = createMemo(() => {
    let m = 0
    for (const c of FLEET) for (let a = 0; a <= 180; a++) m = Math.max(m, c.polar.speed(a, w()))
    return Math.max(2, Math.ceil(m / 2) * 2)
  })
  const rings = () => Array.from({ length: maxSpeed() / 2 }, (_, i) => (i + 1) * 2)
  const pt = (twa: number, speed: number) => {
    const r = (speed / maxSpeed()) * R
    return { x: CX + r * Math.sin(twa * DEG), y: CY - r * Math.cos(twa * DEG) }
  }
  const curves = createMemo(() =>
    FLEET.map((c) => {
      const from = Math.ceil(c.polar.minTwa(w()))
      const pts: string[] = []
      for (let a = from; a <= 180; a++) {
        const p = pt(a, c.polar.speed(a, w()))
        pts.push(`${p.x.toFixed(1)},${p.y.toFixed(1)}`)
      }
      return pts.join(" ")
    }),
  )
  // Label each boat where its lead over the best of the others is largest, or the next best spot if
  // that would collide with a label already placed.
  const labels = createMemo(() => {
    const placed: { x: number; y: number; w: number }[] = []
    return FLEET.map((c) => {
      const spots: { a: number; lead: number }[] = []
      for (let a = 40; a <= 175; a += 5) {
        const mine = c.polar.speed(a, w())
        const others = Math.max(...FLEET.filter((o) => o !== c).map((o) => o.polar.speed(a, w())))
        if (mine > 0) spots.push({ a, lead: mine / others })
      }
      spots.sort((p, q) => q.lead - p.lead)
      const width = c.name.length * 6
      for (const { a } of spots) {
        const p = pt(a, c.polar.speed(a, w()) + maxSpeed() * 0.05)
        const clash = placed.some((q) => Math.abs(q.y - p.y) < 13 && p.x < q.x + q.w + 4 && q.x < p.x + width + 4)
        if (clash) continue
        placed.push({ x: p.x, y: p.y, w: width })
        return { x: p.x, y: p.y, anchor: "start" as const }
      }
      const p = pt(90, c.polar.speed(90, w()) + maxSpeed() * 0.05)
      return { x: p.x, y: p.y, anchor: "start" as const }
    })
  })

  const [hover, setHover] = createSignal<number | null>(null)
  let svg!: SVGSVGElement
  const onMove = (e: PointerEvent) => {
    const r = svg.getBoundingClientRect()
    const x = ((e.clientX - r.left) / r.width) * W - CX
    const y = ((e.clientY - r.top) / r.height) * H - CY
    if (x < -10) return setHover(null)
    const a = Math.round(Math.atan2(Math.max(0, x), -y) / DEG / 5) * 5
    setHover(Math.min(180, Math.max(0, a)))
  }

  const table = createMemo(() => {
    const rows = FLEET.map((c) => ({ c, up: vmgUp(c, w()), reach: c.polar.speed(90, w()), down: vmgDown(c, w()) }))
    const best = { up: Math.max(...rows.map((r) => r.up)), reach: Math.max(...rows.map((r) => r.reach)), down: Math.max(...rows.map((r) => r.down)) }
    return { rows, best }
  })

  return (
    <div class="space-y-3">
      <div class="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground" aria-hidden="true">
        <For each={FLEET}>
          {(c, i) => (
            <span class="inline-flex items-center gap-1.5">
              <span class="inline-block h-0.5 w-4 rounded-full" style={{ background: SERIES[i()] }} />
              {c.name}
            </span>
          )}
        </For>
      </div>
      <div class="relative">
        <svg
          ref={svg}
          viewBox={`0 0 ${W} ${H}`}
          class="block w-full touch-none select-none"
          role="img"
          aria-label={`Boat speed against wind angle in ${w()} knots of wind, for the four boats. The table below has the key numbers.`}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        >
          {/* Grid: speed rings and wind-angle spokes, solid hairlines. */}
          <For each={rings()}>
            {(k) => (
              <>
                <path
                  d={`M ${CX} ${CY - (k / maxSpeed()) * R} A ${(k / maxSpeed()) * R} ${(k / maxSpeed()) * R} 0 0 1 ${CX} ${CY + (k / maxSpeed()) * R}`}
                  fill="none"
                  stroke="var(--border)"
                  stroke-width="1"
                />
                <text x={CX - 4} y={CY - (k / maxSpeed()) * R + 3} text-anchor="end" font-size="9" fill="var(--muted-foreground)">
                  {k === maxSpeed() ? `${k} kn` : k}
                </text>
              </>
            )}
          </For>
          <For each={[0, 30, 60, 90, 120, 150, 180]}>
            {(a) => {
              const end = () => pt(a, maxSpeed())
              const lab = () => pt(a, maxSpeed() * 1.1)
              return (
                <>
                  <line x1={CX} y1={CY} x2={end().x} y2={end().y} stroke="var(--border)" stroke-width="1" />
                  <Show when={a > 0}>
                    <text x={lab().x} y={lab().y + 3} text-anchor="middle" font-size="9" fill="var(--muted-foreground)">
                      {a}°
                    </text>
                  </Show>
                </>
              )
            }}
          </For>
          {/* Wind, from the top. */}
          <line x1={CX} y1={4} x2={CX} y2={CY - R - 10} stroke="var(--wind)" stroke-width="2" stroke-linecap="round" />
          <path d={`M ${CX - 4} ${CY - R - 16} L ${CX} ${CY - R - 9} L ${CX + 4} ${CY - R - 16}`} fill="none" stroke="var(--wind)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
          <text x={CX + 8} y={14} font-size="10" fill="var(--muted-foreground)">
            wind {w()} kn
          </text>

          <For each={FLEET}>
            {(_, i) => (
              <polyline
                points={curves()[i()]}
                fill="none"
                stroke={SERIES[i()]}
                stroke-width="2"
                stroke-linejoin="round"
                stroke-linecap="round"
              />
            )}
          </For>
          <For each={FLEET}>
            {(c, i) => (
              <text
                x={labels()[i()].x}
                y={labels()[i()].y}
                text-anchor={labels()[i()].anchor}
                font-size="10"
                font-weight="500"
                fill="var(--foreground)"
                stroke="var(--card)"
                stroke-width="3"
                paint-order="stroke"
              >
                {c.name}
              </text>
            )}
          </For>

          <Show when={hover() !== null}>
            <line
              x1={CX}
              y1={CY}
              x2={pt(hover()!, maxSpeed()).x}
              y2={pt(hover()!, maxSpeed()).y}
              stroke="var(--muted-foreground)"
              stroke-width="1"
            />
            <For each={FLEET}>
              {(c, i) => {
                const p = () => pt(hover()!, c.polar.speed(hover()!, w()))
                return (
                  <Show when={c.polar.speed(hover()!, w()) > 0}>
                    <circle cx={p().x} cy={p().y} r="4" fill={SERIES[i()]} stroke="var(--card)" stroke-width="2" />
                  </Show>
                )
              }}
            </For>
          </Show>
        </svg>
        <Show when={hover() !== null}>
          <div class="pointer-events-none absolute top-0 right-0 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs shadow-md">
            <div class="mb-1 font-medium tabular-nums">{hover()}° to the wind</div>
            <For each={FLEET}>
              {(c, i) => (
                <div class="flex items-center justify-between gap-3">
                  <span class="inline-flex items-center gap-1.5">
                    <span class="inline-block size-2 rounded-full" style={{ background: SERIES[i()] }} />
                    {c.name}
                  </span>
                  <span class="tabular-nums">
                    {c.polar.speed(hover()!, w()) > 0 ? `${c.polar.speed(hover()!, w()).toFixed(1)} kn` : "no-go"}
                  </span>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
      <table class="w-full text-xs">
        <caption class="sr-only">Key speeds in {w()} knots of wind</caption>
        <thead>
          <tr class="text-left text-muted-foreground">
            <th class="pb-1 font-medium">In {w()} kn</th>
            <th class="pb-1 text-right font-medium" title="Best speed made good straight upwind">Upwind</th>
            <th class="pb-1 text-right font-medium" title="Boat speed with the wind on the beam">Reach</th>
            <th class="pb-1 text-right font-medium" title="Best speed made good straight downwind">Downwind</th>
          </tr>
        </thead>
        <tbody>
          <For each={table().rows}>
            {(r) => (
              <tr class="border-t border-border">
                <td class="py-1">{r.c.name}</td>
                {(["up", "reach", "down"] as const).map((k) => (
                  <td class={["py-1 text-right tabular-nums", r[k] === table().best[k] ? "font-semibold" : "text-muted-foreground"]}>
                    {r[k].toFixed(1)}
                    {r[k] === table().best[k] ? " ★" : ""}
                  </td>
                ))}
              </tr>
            )}
          </For>
        </tbody>
      </table>
      <p class="text-xs text-muted-foreground">Knots; upwind and downwind are speed made good toward or away from the wind. ★ marks the leader.</p>
    </div>
  )
}
