import { boomAngle, type Move } from "../game/boat.ts"
import { dirVec, lerp, type Pt, scale, sub } from "../game/geom.ts"
import type { GameMap, Gate } from "../game/map.ts"
import type { Boat } from "../game/race.ts"
import type { WindField } from "../game/wind.ts"
import { coastline } from "./coastline.ts"

/** Canvas drawing of the chart: grid paper, islands, wind, the course, tracks and boats. */

export interface Palette {
  water: string
  grid: string
  gridMajor: string
  land: string
  landEdge: string
  puff: string
  lull: string
  windArrow: string
  course: string
  line: string
  mark: string
  good: string
  danger: string
  foreground: string
  card: string
}

export function readPalette(): Palette {
  const cs = getComputedStyle(document.documentElement)
  const v = (name: string) => cs.getPropertyValue(`--${name}`).trim()
  return {
    water: v("water"),
    grid: v("grid"),
    gridMajor: v("grid-major"),
    land: v("land"),
    landEdge: v("land-edge"),
    puff: v("puff"),
    lull: v("lull"),
    windArrow: v("wind-arrow"),
    course: v("course"),
    line: v("line"),
    mark: v("mark"),
    good: v("good"),
    danger: v("danger"),
    foreground: v("foreground"),
    card: v("card"),
  }
}

export interface Viewport {
  cell: number
  pad: number
  width: number
  height: number
}

export function viewport(map: GameMap, cssWidth: number): Viewport {
  const cell = Math.max(2, (cssWidth - 16) / (map.width - 1 + 2))
  const pad = cell * 1 + 8
  return { cell, pad, width: cssWidth, height: Math.round(pad * 2 + cell * (map.height - 1)) }
}

export const toPx = (v: Viewport, p: Pt): Pt => ({ x: v.pad + p.x * v.cell, y: v.pad + p.y * v.cell })
export const fromPx = (v: Viewport, p: Pt): Pt => ({ x: (p.x - v.pad) / v.cell, y: (p.y - v.pad) / v.cell })

// ---- Static layer: paper, land, course ----------------------------------------------------------

interface LandShape {
  fill: Path2D
  coast: Path2D
}

const landCache = new WeakMap<GameMap, LandShape>()

/** The land and coastline as canvas paths, in grid units. */
function landShape(m: GameMap): LandShape {
  const hit = landCache.get(m)
  if (hit) return hit
  const fill = new Path2D()
  const coast = new Path2D()
  const shore = coastline(m)
  for (const poly of shore.land) {
    fill.moveTo(poly[0].x, poly[0].y)
    for (const q of poly.slice(1)) fill.lineTo(q.x, q.y)
    fill.closePath()
  }
  for (const [a, b] of shore.coast) {
    coast.moveTo(a.x, a.y)
    coast.lineTo(b.x, b.y)
  }
  const shape = { fill, coast }
  landCache.set(m, shape)
  return shape
}

const gateCenter = (g: Gate): Pt => g.mark ?? { x: (g.a.x + g.b.x) / 2, y: (g.a.y + g.b.y) / 2 }

export function drawStatic(ctx: CanvasRenderingContext2D, m: GameMap, v: Viewport, c: Palette) {
  ctx.fillStyle = c.water
  ctx.fillRect(0, 0, v.width, v.height)
  // Grid paper: every intersection is a place a boat can be.
  if (v.cell >= 3.5) {
    ctx.lineWidth = 1
    for (const major of [false, true]) {
      ctx.strokeStyle = major ? c.gridMajor : c.grid
      ctx.beginPath()
      for (let x = 0; x < m.width; x++) {
        if ((x % 10 === 0) !== major) continue
        const px = Math.round(v.pad + x * v.cell) + 0.5
        ctx.moveTo(px, v.pad)
        ctx.lineTo(px, v.pad + (m.height - 1) * v.cell)
      }
      for (let y = 0; y < m.height; y++) {
        if ((y % 10 === 0) !== major) continue
        const py = Math.round(v.pad + y * v.cell) + 0.5
        ctx.moveTo(v.pad, py)
        ctx.lineTo(v.pad + (m.width - 1) * v.cell, py)
      }
      ctx.stroke()
    }
  }
  const land = landShape(m)
  ctx.save()
  ctx.translate(v.pad, v.pad)
  ctx.scale(v.cell, v.cell)
  ctx.fillStyle = c.land
  ctx.strokeStyle = c.land
  ctx.lineWidth = 0.6 / v.cell
  ctx.fill(land.fill)
  ctx.stroke(land.fill)
  ctx.strokeStyle = c.landEdge
  ctx.lineWidth = 1.5 / v.cell
  ctx.lineCap = "round"
  ctx.stroke(land.coast)
  ctx.restore()
  // Map border.
  ctx.strokeStyle = c.gridMajor
  ctx.strokeRect(v.pad - 0.5, v.pad - 0.5, (m.width - 1) * v.cell + 1, (m.height - 1) * v.cell + 1)
}

export function drawCourse(ctx: CanvasRenderingContext2D, m: GameMap, v: Viewport, c: Palette, nextGate: number | null) {
  // The course order, faintly.
  ctx.save()
  ctx.strokeStyle = c.course
  ctx.lineWidth = 1.25
  ctx.setLineDash([5, 5])
  ctx.beginPath()
  m.gates.forEach((g, i) => {
    const p = toPx(v, gateCenter(g))
    if (i === 0) ctx.moveTo(p.x, p.y)
    else ctx.lineTo(p.x, p.y)
  })
  ctx.stroke()
  ctx.restore()

  // Start / finish line, with the committee boat and the pin.
  const [a, b] = m.startLine.map((p) => toPx(v, p))
  const lineActive = nextGate !== null && (m.gates[nextGate]?.kind === "start" || m.gates[nextGate]?.kind === "finish")
  ctx.strokeStyle = lineActive ? c.good : c.line
  ctx.lineWidth = lineActive ? 2.5 : 1.75
  ctx.setLineDash([2, 3])
  ctx.beginPath()
  ctx.moveTo(a.x, a.y)
  ctx.lineTo(b.x, b.y)
  ctx.stroke()
  ctx.setLineDash([])
  ctx.fillStyle = c.line
  for (const p of [a, b]) {
    ctx.beginPath()
    ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2)
    ctx.fill()
  }
  const mid = lerp(a, b, 0.5)
  label(ctx, "Start · Finish", { x: mid.x, y: mid.y + 14 }, c, 11)

  // Marks, numbered in the order they're rounded, with an arrow for the rounding direction.
  const r = Math.max(4.5, v.cell * 0.55)
  m.gates.forEach((g, i) => {
    if (g.kind !== "mark" || !g.mark) return
    const p = toPx(v, g.mark)
    const ray = sub(g.b, g.a)
    const ang = Math.atan2(ray.y, ray.x)
    const ccw = g.side === "port"
    const rr = r + 7
    const span = 1.1
    const start = ccw ? ang + span : ang - span
    const end = ccw ? ang - span : ang + span
    const isNext = i === nextGate
    ctx.strokeStyle = isNext ? c.mark : c.course
    ctx.lineWidth = isNext ? 2.5 : 1.5
    ctx.beginPath()
    ctx.arc(p.x, p.y, rr, start, end, ccw)
    ctx.stroke()
    // Arrowhead at the end of the arc, pointing along it.
    const tip = { x: p.x + Math.cos(end) * rr, y: p.y + Math.sin(end) * rr }
    const tangent = ccw ? end - Math.PI / 2 : end + Math.PI / 2
    ctx.fillStyle = isNext ? c.mark : c.course
    ctx.beginPath()
    ctx.moveTo(tip.x + Math.cos(tangent) * 6, tip.y + Math.sin(tangent) * 6)
    ctx.lineTo(tip.x + Math.cos(tangent + 2.5) * 5, tip.y + Math.sin(tangent + 2.5) * 5)
    ctx.lineTo(tip.x + Math.cos(tangent - 2.5) * 5, tip.y + Math.sin(tangent - 2.5) * 5)
    ctx.closePath()
    ctx.fill()
  })
  const seen = new Map<string, string[]>()
  m.gates.forEach((g, i) => {
    if (!g.mark) return
    const k = `${g.mark.x},${g.mark.y}`
    seen.set(k, [...(seen.get(k) ?? []), String(i)])
  })
  for (const mk of m.marks) {
    const p = toPx(v, mk)
    const isNext = nextGate !== null && m.gates[nextGate]?.mark === mk
    if (isNext) {
      ctx.fillStyle = c.mark
      ctx.globalAlpha = 0.25
      ctx.beginPath()
      ctx.arc(p.x, p.y, r * 2.2, 0, Math.PI * 2)
      ctx.fill()
      ctx.globalAlpha = 1
    }
    ctx.fillStyle = c.mark
    ctx.strokeStyle = c.line
    ctx.lineWidth = 1.25
    ctx.beginPath()
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
    label(ctx, (seen.get(`${mk.x},${mk.y}`) ?? []).join(" & "), { x: p.x, y: p.y - r - 14 }, c, 11, true)
  }
}

function label(ctx: CanvasRenderingContext2D, text: string, p: Pt, c: Palette, size: number, bold = false) {
  ctx.font = `${bold ? 600 : 500} ${size}px Inter, ui-sans-serif, system-ui, sans-serif`
  ctx.textAlign = "center"
  ctx.textBaseline = "middle"
  ctx.lineWidth = 3
  ctx.strokeStyle = c.water
  ctx.strokeText(text, p.x, p.y)
  ctx.fillStyle = c.foreground
  ctx.fillText(text, p.x, p.y)
}

// ---- Wind layer ---------------------------------------------------------------------------------

export function drawWind(ctx: CanvasRenderingContext2D, m: GameMap, v: Viewport, c: Palette, f: WindField) {
  const W = m.width
  // Puffs darker, lulls lighter: shade each intersection by how its speed compares with the base wind,
  // one pixel per intersection on a small canvas, then scaled up smoothly.
  const small = document.createElement("canvas")
  small.width = W
  small.height = m.height
  const sc = small.getContext("2d")!
  for (let y = 0; y < m.height; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      const r = f.speed[i] / f.baseSpeed - 1
      if (m.h[i] > 0 || Math.abs(r) < 0.03) continue
      sc.fillStyle = r > 0 ? c.puff : c.lull
      sc.globalAlpha = r > 0 ? Math.min(0.3, r * 0.6) : Math.min(0.6, -r * 0.85)
      sc.fillRect(x, y, 1, 1)
    }
  ctx.save()
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = "high"
  ctx.drawImage(small, 0, 0, W, m.height, v.pad - v.cell / 2, v.pad - v.cell / 2, W * v.cell, m.height * v.cell)
  ctx.restore()
  // Keep the land crisp on top of the shading.
  const land = landShape(m)
  ctx.save()
  ctx.translate(v.pad, v.pad)
  ctx.scale(v.cell, v.cell)
  ctx.fillStyle = c.land
  ctx.fill(land.fill)
  ctx.strokeStyle = c.landEdge
  ctx.lineWidth = 1.5 / v.cell
  ctx.lineCap = "round"
  ctx.stroke(land.coast)
  ctx.restore()
  // Arrows on a coarser lattice, pointing where the wind blows, longer where it's stronger.
  const k = Math.max(3, Math.ceil(26 / v.cell))
  ctx.strokeStyle = c.windArrow
  ctx.fillStyle = c.windArrow
  ctx.lineWidth = 1.25
  for (let y = Math.floor(k / 2); y < m.height; y += k)
    for (let x = Math.floor(k / 2); x < W; x += k) {
      const i = y * W + x
      if (m.h[i] > 0) continue
      const to = dirVec(f.from[i] + 180)
      const l = Math.min(k * v.cell * 0.8, k * v.cell * 0.42 * (f.speed[i] / f.baseSpeed))
      const p = toPx(v, { x, y })
      const tail = { x: p.x - (to.x * l) / 2, y: p.y - (to.y * l) / 2 }
      const tip = { x: p.x + (to.x * l) / 2, y: p.y + (to.y * l) / 2 }
      ctx.beginPath()
      ctx.moveTo(tail.x, tail.y)
      ctx.lineTo(tip.x, tip.y)
      ctx.stroke()
      const back = scale(to, -4.5)
      const side = { x: -to.y * 2.6, y: to.x * 2.6 }
      ctx.beginPath()
      ctx.moveTo(tip.x, tip.y)
      ctx.lineTo(tip.x + back.x + side.x, tip.y + back.y + side.y)
      ctx.lineTo(tip.x + back.x - side.x, tip.y + back.y - side.y)
      ctx.closePath()
      ctx.fill()
    }
}

// ---- Boats --------------------------------------------------------------------------------------

/** Pencil tracks: a line through every turn's intersection, with a dot at each; `tail` is the move in progress. */
export function drawTrack(ctx: CanvasRenderingContext2D, v: Viewport, b: Boat, upTo: number, tail: Pt[], faded: boolean) {
  const turns = b.track.slice(0, upTo + 1).map((p) => toPx(v, p))
  const pts = [...turns, ...tail.map((p) => toPx(v, p))]
  ctx.strokeStyle = b.color
  ctx.fillStyle = b.color
  ctx.globalAlpha = faded ? 0.35 : 0.75
  ctx.lineWidth = 1.5
  ctx.lineJoin = "round"
  ctx.beginPath()
  pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)))
  ctx.stroke()
  const dot = Math.max(1.2, Math.min(2.2, v.cell * 0.22))
  for (const p of turns) {
    ctx.beginPath()
    ctx.arc(p.x, p.y, dot, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.globalAlpha = 1
}

/** The boat: a hull pointing along its heading and the boom out to leeward. */
export function drawBoat(
  ctx: CanvasRenderingContext2D,
  v: Viewport,
  c: Palette,
  b: { color: string; name: string; heading: number },
  at: Pt,
  windFrom: number,
  opts: { active?: boolean; faded?: boolean },
) {
  const p = toPx(v, at)
  const L = boatLength(v)
  const f = dirVec(b.heading)
  const r = { x: -f.y, y: f.x }
  const pt = (fw: number, rt: number) => ({ x: p.x + (f.x * fw + r.x * rt) * L, y: p.y + (f.y * fw + r.y * rt) * L })
  ctx.globalAlpha = opts.faded ? 0.45 : 1
  if (opts.active) {
    ctx.strokeStyle = b.color
    ctx.lineWidth = 2
    ctx.globalAlpha = 0.35
    ctx.beginPath()
    ctx.arc(p.x, p.y, L * 0.85, 0, Math.PI * 2)
    ctx.stroke()
    ctx.globalAlpha = 1
  }
  const hull = [pt(0.55, 0), pt(0.12, 0.19), pt(-0.42, 0.15), pt(-0.42, -0.15), pt(0.12, -0.19)]
  ctx.fillStyle = b.color
  ctx.strokeStyle = c.card
  ctx.lineWidth = 1.25
  ctx.beginPath()
  hull.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)))
  ctx.closePath()
  ctx.fill()
  ctx.stroke()
  // Boom on the leeward side: wind over starboard puts it to port.
  const twa = ((windFrom - b.heading + 540) % 360) - 180
  const boom = boomAngle(twa)
  const boomDir = b.heading + 180 + (twa >= 0 ? boom : -boom)
  const mast = pt(0.12, 0)
  const bd = dirVec(boomDir)
  ctx.strokeStyle = c.line
  ctx.lineWidth = 2
  ctx.lineCap = "round"
  ctx.beginPath()
  ctx.moveTo(mast.x, mast.y)
  ctx.lineTo(mast.x + bd.x * L * 0.55, mast.y + bd.y * L * 0.55)
  ctx.stroke()
  ctx.fillStyle = c.line
  ctx.beginPath()
  ctx.arc(mast.x, mast.y, 1.6, 0, Math.PI * 2)
  ctx.fill()
  ctx.globalAlpha = 1
}

const boatLength = (v: Viewport) => Math.max(13, Math.min(24, v.cell * 2))

/**
 * A boat's name, just below it. Semi-transparent, and drawn before the boats and the planned move, so a
 * name never hides a boat and the wind and tracks show through it.
 */
export function drawBoatName(ctx: CanvasRenderingContext2D, v: Viewport, c: Palette, name: string, at: Pt, faded: boolean) {
  const p = toPx(v, at)
  ctx.globalAlpha = faded ? 0.3 : 0.6
  label(ctx, name, { x: p.x, y: p.y + boatLength(v) * 0.75 + 7 }, c, 11)
  ctx.globalAlpha = 1
}

/** The active boat's planned move: the curve it will sail, and where it ends up. */
export function drawPreview(ctx: CanvasRenderingContext2D, v: Viewport, c: Palette, color: string, mv: Move, stop: Pt, aground: boolean) {
  const a = toPx(v, mv.from)
  const s = toPx(v, stop)
  // The new heading, carried on past the end of the move.
  const ahead = dirVec(mv.heading)
  ctx.strokeStyle = color
  ctx.globalAlpha = 0.25
  ctx.lineWidth = 1
  ctx.setLineDash([2, 4])
  ctx.beginPath()
  ctx.moveTo(s.x, s.y)
  ctx.lineTo(s.x + ahead.x * v.cell * 60, s.y + ahead.y * v.cell * 60)
  ctx.stroke()
  ctx.globalAlpha = 1
  ctx.setLineDash([6, 4])
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(a.x, a.y)
  for (const p of mv.path.slice(1)) {
    const q = toPx(v, p)
    ctx.lineTo(q.x, q.y)
  }
  ctx.stroke()
  ctx.setLineDash([])
  ctx.lineWidth = 2
  ctx.strokeStyle = aground ? c.danger : color
  ctx.fillStyle = c.card
  ctx.beginPath()
  ctx.arc(s.x, s.y, Math.max(4, v.cell * 0.45), 0, Math.PI * 2)
  ctx.fill()
  ctx.stroke()
  if (aground) {
    const k = 5
    ctx.beginPath()
    ctx.moveTo(s.x - k, s.y - k)
    ctx.lineTo(s.x + k, s.y + k)
    ctx.moveTo(s.x + k, s.y - k)
    ctx.lineTo(s.x - k, s.y + k)
    ctx.stroke()
  }
}
