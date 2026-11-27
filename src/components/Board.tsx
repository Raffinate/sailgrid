import { createEffect, onSettled } from "solid-js"
import type { Move } from "../game/boat.ts"
import { bearing, lerp, type Pt } from "../game/geom.ts"
import type { GameMap } from "../game/map.ts"
import { type RaceState, racing } from "../game/race.ts"
import { windAt, windField } from "../game/wind.ts"
import {
  drawBoat,
  drawBoatName,
  drawCourse,
  drawPreview,
  drawStatic,
  drawTrack,
  drawIsotachs,
  drawWind,
  fromPx,
  type Palette,
  readPalette,
  type Viewport,
  viewport,
} from "./draw.ts"

export interface Preview {
  move: Move
  stop: Pt
  aground: boolean
}

interface BoardProps {
  map: GameMap
  state: RaceState | null
  prev: RaceState | null
  active: number | null
  /** Highlight this boat's next mark (the active boat, or this device's boat). */
  focus: number | null
  preview: Preview | null
  showWind: boolean
  /** Lines of equal wind speed at the 20th, 50th and 80th percentile of this turn's wind (with the wind shown). */
  showIsotachs: boolean
  showNames: boolean
  /** The boats' tracks so far. */
  showPaths: boolean
  /** Draw only these boats (and their tracks and names); null draws them all. */
  onlyBoats: number[] | null
  onAim?: (heading: number) => void
}

const ANIM_MS = 550

interface Frame {
  map: GameMap
  state: RaceState | null
  prev: RaceState | null
  active: number | null
  focus: number | null
  preview: Preview | null
  showWind: boolean
  showIsotachs: boolean
  showNames: boolean
  showPaths: boolean
  onlyBoats: number[] | null
}

/** The chart, drawn on a canvas. Click or drag on it to aim the active boat. */
export function Board(props: BoardProps) {
  let wrap!: HTMLDivElement
  let canvas!: HTMLCanvasElement
  let frame: Frame | null = null
  let width = 0
  let palette: Palette | null = null
  let staticLayer: { key: string; canvas: HTMLCanvasElement } | null = null
  let windLayer: { key: string; canvas: HTMLCanvasElement } | null = null
  let animFrom = 0
  /** The state whose move is being (or was last) animated: a replay can show the same turn again. */
  let animState: RaceState | null = null
  let raf = 0
  let themeVersion = 0

  const layer = (v: Viewport, paint: (ctx: CanvasRenderingContext2D) => void) => {
    const dpr = window.devicePixelRatio || 1
    const c = document.createElement("canvas")
    c.width = Math.round(v.width * dpr)
    c.height = Math.round(v.height * dpr)
    const ctx = c.getContext("2d")!
    ctx.scale(dpr, dpr)
    paint(ctx)
    return c
  }

  const draw = (now: number) => {
    raf = 0
    if (!frame || width <= 0) return
    const { map, state, prev } = frame
    palette ??= readPalette()
    const c = palette
    const v = viewport(map, width)
    const dpr = window.devicePixelRatio || 1
    if (canvas.width !== Math.round(v.width * dpr) || canvas.height !== Math.round(v.height * dpr)) {
      canvas.width = Math.round(v.width * dpr)
      canvas.height = Math.round(v.height * dpr)
      canvas.style.height = `${v.height}px`
    }
    const ctx = canvas.getContext("2d")!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const sKey = `${map.config.seed}:${JSON.stringify(map.config)}:${v.width}:${themeVersion}`
    if (staticLayer?.key !== sKey) staticLayer = { key: sKey, canvas: layer(v, (x) => drawStatic(x, map, v, c)) }
    ctx.drawImage(staticLayer.canvas, 0, 0, v.width, v.height)

    const turn = state?.turn ?? 0
    const field = windField(map, turn)
    if (frame.showWind) {
      const iso = frame.showIsotachs
      const wKey = `${sKey}:${turn}:${iso}`
      if (windLayer?.key !== wKey)
        windLayer = {
          key: wKey,
          canvas: layer(v, (x) => {
            drawWind(x, map, v, c, field)
            if (iso) drawIsotachs(x, map, v, c, field)
          }),
        }
      ctx.drawImage(windLayer.canvas, 0, 0, v.width, v.height)
    }

    const focusBoat = frame.focus !== null ? state?.boats[frame.focus] : undefined
    drawCourse(ctx, map, v, c, focusBoat && racing(focusBoat) ? focusBoat.next : state ? null : 0)
    if (!state) return

    // Animate the last turn's moves.
    if (prev && prev.turn === state.turn - 1 && animState !== state) {
      animState = state
      animFrom = now
    }
    const t = prev && animState === state ? Math.min(1, (now - animFrom) / ANIM_MS) : 1
    const ease = 1 - (1 - t) ** 3
    // Mid-animation each boat is partway along last turn's wake (the arc it actually sailed).
    const where = (id: number): { at: Pt; heading: number | null; upTo: number; tail: Pt[] } => {
      const b = state.boats[id]
      const n = b.track.length
      if (t >= 1 || n < 2) return { at: b.pos, heading: null, upTo: n - 1, tail: [] }
      const wake = b.wake && b.wake.length > 1 ? b.wake : [b.track[n - 2], b.track[n - 1]]
      const k = ease * (wake.length - 1)
      const i = Math.min(wake.length - 2, Math.floor(k))
      const at = lerp(wake[i], wake[i + 1], k - i)
      const heading = wake[i + 1].x === wake[i].x && wake[i + 1].y === wake[i].y ? null : bearing(wake[i], wake[i + 1])
      return { at, heading, upTo: n - 2, tail: [...wake.slice(1, i + 1), at] }
    }
    const only = frame.onlyBoats
    const boats = only ? state.boats.filter((b) => only.includes(b.id)) : state.boats
    if (frame.showPaths)
      for (const b of boats) {
        const w = where(b.id)
        drawTrack(ctx, v, b, w.upTo, w.tail, !racing(b))
      }
    // Names under the planned move and the boats, so they never hide either.
    if (frame.showNames && v.cell >= 5) for (const b of boats) drawBoatName(ctx, v, c, b.name, where(b.id).at, !racing(b))
    if (frame.preview && t >= 1 && frame.active !== null) {
      const b = state.boats[frame.active]
      drawPreview(ctx, v, c, b.color, frame.preview.move, frame.preview.stop, frame.preview.aground)
    }
    for (const b of boats) {
      const w = where(b.id)
      const plan = frame.active === b.id && frame.preview && t >= 1 ? frame.preview.move : null
      drawBoat(
        ctx,
        v,
        c,
        { color: b.color, name: b.name, heading: plan?.heading ?? w.heading ?? b.heading },
        w.at,
        windAt(field, b.pos).from,
        { active: frame.active === b.id, faded: !racing(b) },
      )
    }
    if (t < 1) raf = requestAnimationFrame(draw)
  }

  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(draw)
  }

  createEffect(
    () => ({
      map: props.map,
      state: props.state,
      prev: props.prev,
      active: props.active,
      focus: props.focus,
      preview: props.preview,
      showWind: props.showWind,
      showIsotachs: props.showIsotachs,
      showNames: props.showNames,
      showPaths: props.showPaths,
      onlyBoats: props.onlyBoats,
    }),
    (f) => {
      frame = f
      schedule()
    },
  )

  onSettled(() => {
    const ro = new ResizeObserver((entries) => {
      const w = Math.floor(entries[0].contentRect.width)
      if (w !== width) {
        width = w
        schedule()
      }
    })
    ro.observe(wrap)
    const mo = new MutationObserver(() => {
      palette = null
      themeVersion++
      schedule()
    })
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] })
    return () => {
      ro.disconnect()
      mo.disconnect()
      if (raf) cancelAnimationFrame(raf)
    }
  })

  let aiming = false
  const aim = (e: PointerEvent) => {
    if (!props.onAim || props.active === null || !props.state || !frame) return
    const rect = canvas.getBoundingClientRect()
    const v = viewport(frame.map, width)
    const p = fromPx(v, { x: e.clientX - rect.left, y: e.clientY - rect.top })
    const boat = props.state.boats[props.active]
    if (Math.hypot(p.x - boat.pos.x, p.y - boat.pos.y) < 0.5) return
    props.onAim(Math.round(bearing(boat.pos, p)) % 360)
  }

  return (
    <div ref={wrap} class="w-full">
      <canvas
        ref={canvas}
        class={["block w-full touch-none rounded-lg", props.onAim && props.active !== null ? "cursor-crosshair" : ""]}
        aria-label="Race chart"
        role="img"
        onPointerDown={(e) => {
          if (!props.onAim || props.active === null) return
          aiming = true
          canvas.setPointerCapture(e.pointerId)
          aim(e)
        }}
        onPointerMove={(e) => aiming && aim(e)}
        onPointerUp={() => (aiming = false)}
        onPointerCancel={() => (aiming = false)}
      />
    </div>
  )
}
