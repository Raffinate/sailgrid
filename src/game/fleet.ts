import data from "../data/boats.json" with { type: "json" }
import { makePolar, type Polar, type PolarCurve } from "./polar.ts"

/**
 * The fleet: four popular boats of different types, chosen from ORC's 2026 certificates because their real
 * polars are about equally fast overall (within ~1.5%) yet each is the quickest in different conditions.
 * Speeds are the real ones (the median certificate of each class, imported once by scripts/fetch-boats.ts
 * into src/data/boats.json), apart from the small `PACE` adjustment below. There's no handicap: first across the line wins, so the game is
 * picking the boat that suits the day's wind and course. Handling (how fast a boat turns and picks up
 * speed) isn't on a certificate; it's set here from the boats' size and weight.
 */

export type BoatClassId = "j-35" | "j-109" | "x-35" | "melges-24"

export interface Handling {
  /** Rate of turn at speed, degrees per second. */
  turnRate: number
  /** Seconds for speed to close most of the gap to its target: picking up, slowing down, stopped in irons. */
  tauUp: number
  tauDown: number
  tauIrons: number
}

export type WindBand = "low" | "medium" | "high"

export interface BoatClass {
  id: BoatClassId
  name: string
  /** One line on how the boat sails. */
  blurb: string
  /** Where it shines, and where it doesn't. */
  strengths: string
  weaknesses: string
  polar: Polar
  handling: Handling
  gph: number
  certificates: number
  loa: number
  displacement: number
}

interface Imported {
  id: string
  name: string
  certificates: number
  gph: number
  tripleNumber: Record<WindBand, number>
  loa: number
  displacement: number
  polar: {
    tws: number[]
    beatAngle: (number | null)[]
    beatSpeed: (number | null)[]
    runAngle: (number | null)[]
    runSpeed: (number | null)[]
    angles: number[]
    speeds: (number | null)[][]
  }
}

const INFO: Record<BoatClassId, { blurb: string; strengths: string; weaknesses: string; handling: Handling }> = {
  "j-35": {
    blurb: "Classic 1980s 35-footer with a masthead spinnaker; big fleets in the US.",
    strengths: "Upwind, in any wind.",
    weaknesses: "Downwind and reaching once the breeze is up.",
    handling: { turnRate: 11, tauUp: 18, tauDown: 24, tauIrons: 9 },
  },
  "j-109": {
    blurb: "Cruiser-racer with an asymmetric spinnaker on a bowsprit.",
    strengths: "Off the wind in light and medium air: reaching and running.",
    weaknesses: "Upwind in light air.",
    handling: { turnRate: 11, tauUp: 19, tauDown: 25, tauIrons: 9 },
  },
  "x-35": {
    blurb: "Popular European one-design racer.",
    strengths: "All-rounder: close to the best on every point of sail in light and medium air.",
    weaknesses: "The best at nothing; off the wind in a strong breeze.",
    handling: { turnRate: 11, tauUp: 17, tauDown: 23, tauIrons: 9 },
  },
  "melges-24": {
    blurb: "7.5 m planing sportboat; very nimble.",
    strengths: "Strong wind: planes away on reaches and downwind; reaching in medium air.",
    weaknesses: "Upwind, in any wind.",
    handling: { turnRate: 13, tauUp: 12, tauDown: 16, tauIrons: 7 },
  },
}

/**
 * Overall speed adjustments, from in-game calibration (each boat raced alone by the best AI in light,
 * medium and strong air on every course type). The real X-35 is a strong all-rounder and was
 * the best pick in all light and medium conditions; 1.5% slower, the J/35 and J/109 get their chances.
 */
const PACE: Partial<Record<BoatClassId, number>> = { "x-35": 0.985 }

/** One wind speed's curve from the certificate: the beat, the fixed angles, the run, and a dead run. */
function curveFrom(p: Imported["polar"], j: number, pace: number): PolarCurve | null {
  const beatA = p.beatAngle[j]
  const beatV = p.beatSpeed[j]
  const runA = p.runAngle[j]
  const runV = p.runSpeed[j]
  if (!beatA || !beatV || !runA || !runV) return null
  const pts: [number, number][] = []
  // Pinching a few degrees above the best upwind angle is possible, but slower; closer still is no-go.
  pts.push([beatA - 5, beatV * 0.86], [beatA, beatV])
  p.angles.forEach((a, i) => {
    const v = p.speeds[i][j]
    if (v && a > beatA + 0.5) pts.push([a, v])
  })
  pts.push([runA, runV])
  // Dead downwind: a little less progress downwind than at the best running angle.
  if (runA < 179) pts.push([180, runV * Math.cos(((180 - runA) * Math.PI) / 180) * 0.97])
  pts.sort((a, b) => a[0] - b[0])
  const twa: number[] = []
  const bsp: number[] = []
  for (const [a, v] of pts) {
    if (twa.length && a - twa[twa.length - 1] < 0.5) continue
    twa.push(a)
    bsp.push(v * pace)
  }
  return { tws: p.tws[j], twa, bsp }
}

const imported = (data as { boats: Imported[] }).boats

export const FLEET: BoatClass[] = imported.map((b) => {
  const id = b.id as BoatClassId
  const curves = b.polar.tws.map((_, j) => curveFrom(b.polar, j, PACE[id] ?? 1)).filter((c): c is PolarCurve => c !== null)
  return {
    id,
    name: b.name,
    blurb: INFO[id].blurb,
    strengths: INFO[id].strengths,
    weaknesses: INFO[id].weaknesses,
    polar: makePolar(curves),
    handling: INFO[id].handling,
    gph: b.gph,
    certificates: b.certificates,
    loa: b.loa,
    displacement: b.displacement,
  }
})

export const DEFAULT_BOAT: BoatClassId = "j-35"

export const boatClass = (id: BoatClassId | undefined): BoatClass => FLEET.find((c) => c.id === id) ?? FLEET[0]

/** Wind ranges, as ORC uses them: light under 9 kn, strong over 14. */
export const windBand = (knots: number): WindBand => (knots < 9 ? "low" : knots <= 14 ? "medium" : "high")

export const WIND_BAND_LABEL: Record<WindBand, string> = { low: "light air", medium: "medium air", high: "strong air" }
