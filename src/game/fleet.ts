import data from "../data/boats.json" with { type: "json" }
import { makePolar, type Polar, type PolarCurve } from "./polar.ts"

/**
 * The fleet: four popular boats of different types that race together in ORC club classes. Speeds and
 * handicaps both come from the boats' real ORC certificates (the median of each class, imported once
 * by scripts/fetch-boats.ts into src/data/boats.json), so they agree with each other. Handling (how fast
 * a boat turns and picks up speed) isn't on a certificate; it's set here from the boats' size and weight.
 * `TUNING` balances the fleet in the game without touching the ratings.
 */

export type BoatClassId = "first-40-7" | "j-109" | "farr-30" | "melges-24"

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
  polar: Polar
  handling: Handling
  /** ORC inshore triple-number time factors, relative to the First 40.7 (corrected = elapsed × factor). */
  rating: Record<WindBand, number>
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

const INFO: Record<BoatClassId, { blurb: string; handling: Handling }> = {
  "first-40-7": {
    blurb: "Heavy 12 m cruiser-racer. Points high and holds speed upwind; slow to get going after a tack.",
    handling: { turnRate: 10, tauUp: 20, tauDown: 26, tauIrons: 10 },
  },
  "j-109": {
    blurb: "Asymmetric spinnaker on a bowsprit. Strong downwind in light air, weaker upwind in it.",
    handling: { turnRate: 11, tauUp: 18, tauDown: 24, tauIrons: 9 },
  },
  "farr-30": {
    blurb: "Light, powerful racer. Takes off downwind in a breeze; quick through tacks.",
    handling: { turnRate: 12, tauUp: 15, tauDown: 20, tauIrons: 8 },
  },
  "melges-24": {
    blurb: "7.5 m planing sportboat. Struggles upwind in a breeze, flies downwind in it; very nimble.",
    handling: { turnRate: 13, tauUp: 12, tauDown: 16, tauIrons: 7 },
  },
}

/**
 * Hand balance on top of the certificates, from in-game calibration (every boat raced alone by the best AI
 * over the same courses in light, medium and strong air; see README). The ORC ratings stay exactly as on
 * the certificates; instead a class's boat speeds are scaled a little per wind band, so that corrected
 * times come out even. Real ratings don't see how the game's puffy wind and quick handling favour light
 * planing boats.
 */
const TUNING: Partial<Record<BoatClassId, Partial<Record<WindBand, number>>>> = {
  "j-109": { low: 0.995, medium: 0.98, high: 0.95 },
  "farr-30": { low: 0.975, medium: 0.985, high: 0.94 },
  "melges-24": { low: 0.98, medium: 0.94, high: 0.925 },
}

/** Wind speeds the bands' multipliers apply at; in between they blend. */
const BAND_TWS: [number, WindBand][] = [
  [8, "low"],
  [12, "medium"],
  [16, "high"],
]

function bandScale(tune: Partial<Record<WindBand, number>>, tws: number): number {
  const v = BAND_TWS.map(([w, b]) => [w, tune[b] ?? 1] as const)
  if (tws <= v[0][0]) return v[0][1]
  if (tws >= v[v.length - 1][0]) return v[v.length - 1][1]
  let i = 0
  while (v[i + 1][0] < tws) i++
  const f = (tws - v[i][0]) / (v[i + 1][0] - v[i][0])
  return v[i][1] + (v[i + 1][1] - v[i][1]) * f
}

/** One wind speed's curve from the certificate: the beat, the fixed angles, the run, and a dead run. */
function curveFrom(p: Imported["polar"], j: number, tune: Partial<Record<WindBand, number>>): PolarCurve | null {
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
  const k = bandScale(tune, p.tws[j])
  for (const [a, v] of pts) {
    if (twa.length && a - twa[twa.length - 1] < 0.5) continue
    twa.push(a)
    bsp.push(v * k)
  }
  return { tws: p.tws[j], twa, bsp }
}

const imported = (data as { boats: Imported[] }).boats
const reference = imported.find((b) => b.id === "first-40-7")!

export const FLEET: BoatClass[] = imported.map((b) => {
  const id = b.id as BoatClassId
  const curves = b.polar.tws.map((_, j) => curveFrom(b.polar, j, TUNING[id] ?? {})).filter((c): c is PolarCurve => c !== null)
  return {
    id,
    name: b.name,
    blurb: INFO[id].blurb,
    polar: makePolar(curves),
    handling: INFO[id].handling,
    rating: {
      low: b.tripleNumber.low / reference.tripleNumber.low,
      medium: b.tripleNumber.medium / reference.tripleNumber.medium,
      high: b.tripleNumber.high / reference.tripleNumber.high,
    },
    gph: b.gph,
    certificates: b.certificates,
    loa: b.loa,
    displacement: b.displacement,
  }
})

export const DEFAULT_BOAT: BoatClassId = "first-40-7"

export const boatClass = (id: BoatClassId | undefined): BoatClass => FLEET.find((c) => c.id === id) ?? FLEET[0]

/** ORC inshore wind ranges: light under 9 kn, strong over 14. */
export const windBand = (knots: number): WindBand => (knots < 9 ? "low" : knots <= 14 ? "medium" : "high")

export const WIND_BAND_LABEL: Record<WindBand, string> = { low: "light air", medium: "medium air", high: "strong air" }

/** The time factor a boat races on, for a race in this wind. */
export const timeFactor = (id: BoatClassId | undefined, windSpeed: number) => boatClass(id).rating[windBand(windSpeed)]
