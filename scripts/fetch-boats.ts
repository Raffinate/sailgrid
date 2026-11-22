// One-time import of the fleet's data from ORC's public certificate feed (data.orc.org), written to
// src/data/boats.json. Run by hand (`pnpm fetch-boats`); the game only ever reads the saved file, which is
// then tuned by hand for balance (see `tuning` in src/game/fleet.ts).
//
// For each class, every certificate of that design is collected and the typical boat is the median of
// them, figure by figure: the VPP speed table (from the certificate's time allowances), beat and run
// angles, the GPH rating, the inshore triple-number factors, and size and weight.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const FEED = "https://data.orc.org/public/WPub.dll?action=DownRMS&ext=json&Family=1"
const CACHE = new URL("../.orc-cache/", import.meta.url).pathname
const OUT = new URL("../src/data/boats.json", import.meta.url).pathname
const CACHE_MS = 7 * 24 * 60 * 60 * 1000
const YEARS = [2026, 2025]
const MIN_CERTIFICATES = 5

const CLASSES = [
  { id: "first-40-7", name: "Beneteau First 40.7", match: /^FIRST 40\.?7$/ },
  { id: "j-109", name: "J/109", match: /^J ?109$/ },
  { id: "farr-30", name: "Farr 30", match: /^FARR 30( OD)?$/ },
  { id: "melges-24", name: "Melges 24", match: /^MELGES 24( OD)?$/ },
]

type Num = number | undefined
interface Allowances {
  WindSpeeds: number[]
  WindAngles: number[]
  BeatAngle?: number[]
  Beat?: number[]
  GybeAngle?: number[]
  Run?: number[]
  [key: string]: number[] | undefined
}
interface Certificate {
  Class?: string
  GPH?: number
  TN_Inshore_Low?: number
  TN_Inshore_Medium?: number
  TN_Inshore_High?: number
  LOA?: number
  Dspl_Sailing?: number
  Area_Main?: number
  Area_Jib?: number
  Area_Sym?: number
  Area_Asym?: number
  Allowances?: Allowances
}

const normalizeClass = (s: string) =>
  s
    .toUpperCase()
    .replace(/[^A-Z0-9.]+/g, " ")
    .trim()

async function download(year: number, country: string): Promise<{ rms: Certificate[]; Countries?: { CountryId: string }[] }> {
  const file = join(CACHE, `${country}${year}.json`)
  if (existsSync(file) && Date.now() - statSync(file).mtimeMs < CACHE_MS)
    return JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""))
  let lastError: unknown
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${FEED}&VPPYear=${year}&CountryId=${country}`, {
        headers: { "User-Agent": "sailgrid-data-import", Referer: "https://data.orc.org/public/WPub.dll" },
        signal: AbortSignal.timeout(180_000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const text = (await res.text()).replace(/^﻿/, "")
      const data = JSON.parse(text)
      mkdirSync(CACHE, { recursive: true })
      writeFileSync(file, text)
      return data
    } catch (e) {
      lastError = e
      await new Promise((r) => setTimeout(r, 2000 * attempt))
    }
  }
  throw new Error(`${country} ${year}: ${(lastError as Error).message}`)
}

async function certificates(year: number): Promise<Certificate[]> {
  const index = await download(year, "ORC")
  const queue = (index.Countries ?? []).map((c) => c.CountryId).filter((c) => c !== "ORC")
  const all: Certificate[] = [...(index.rms ?? [])]
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      for (let c = queue.shift(); c; c = queue.shift()) {
        try {
          all.push(...((await download(year, c)).rms ?? []))
        } catch (e) {
          console.warn(`  skipped ${(e as Error).message}`)
        }
      }
    }),
  )
  return all
}

const median = (xs: Num[]): number | null => {
  const v = xs.filter((x): x is number => typeof x === "number" && Number.isFinite(x) && x > 0).sort((a, b) => a - b)
  if (!v.length) return null
  const m = v.length >> 1
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2
}
const round = (x: number | null, k = 100) => (x === null ? null : Math.round(x * k) / k)
const speed = (secondsPerMile: number | null) => (secondsPerMile ? 3600 / secondsPerMile : null)

function typical(certs: Certificate[]) {
  const tws = certs[0].Allowances!.WindSpeeds
  const angles = certs[0].Allowances!.WindAngles
  const same = certs.filter(
    (c) => c.Allowances!.WindSpeeds.join() === tws.join() && c.Allowances!.WindAngles.join() === angles.join(),
  )
  const cell = (key: string, j: number) => median(same.map((c) => c.Allowances![key]?.[j]))
  return {
    certificates: same.length,
    gph: round(median(same.map((c) => c.GPH)), 10),
    tripleNumber: {
      low: round(median(same.map((c) => c.TN_Inshore_Low)), 10000),
      medium: round(median(same.map((c) => c.TN_Inshore_Medium)), 10000),
      high: round(median(same.map((c) => c.TN_Inshore_High)), 10000),
    },
    loa: round(median(same.map((c) => c.LOA))),
    displacement: round(median(same.map((c) => c.Dspl_Sailing)), 1),
    sailArea: {
      main: round(median(same.map((c) => c.Area_Main))),
      jib: round(median(same.map((c) => c.Area_Jib))),
      spinnaker: round(median(same.map((c) => Math.max(c.Area_Sym ?? 0, c.Area_Asym ?? 0)))),
    },
    polar: {
      tws,
      beatAngle: tws.map((_, j) => round(cell("BeatAngle", j), 10)),
      /** Boat speed at the beat angle, knots. */
      beatSpeed: tws.map((_, j) => {
        const a = cell("BeatAngle", j)
        const vmg = speed(cell("Beat", j))
        return a && vmg ? round(vmg / Math.cos((a * Math.PI) / 180)) : null
      }),
      runAngle: tws.map((_, j) => round(cell("GybeAngle", j), 10)),
      runSpeed: tws.map((_, j) => {
        const a = cell("GybeAngle", j)
        const vmg = speed(cell("Run", j))
        return a && vmg ? round(vmg / Math.cos(((180 - a) * Math.PI) / 180)) : null
      }),
      angles,
      /** speeds[i][j]: boat speed (knots) at angles[i] and tws[j]. */
      speeds: angles.map((a) => tws.map((_, j) => round(speed(cell(`R${a}`, j))))),
    },
  }
}

const found = new Map<string, Certificate[]>()
for (const year of YEARS) {
  const missing = CLASSES.filter((k) => (found.get(k.id)?.length ?? 0) < MIN_CERTIFICATES)
  if (!missing.length) break
  console.log(`Downloading ${year} certificates…`)
  const certs = await certificates(year)
  console.log(`  ${certs.length} certificates`)
  for (const k of missing) {
    const mine = certs.filter((c) => c.Allowances?.WindSpeeds && k.match.test(normalizeClass(c.Class ?? "")))
    // Keep one VPP year per class: only top up from an older year if this one has too few.
    if (mine.length > (found.get(k.id)?.length ?? 0)) found.set(k.id, mine)
  }
}

const boats = CLASSES.map((k) => {
  const certs = found.get(k.id) ?? []
  if (!certs.length) throw new Error(`No certificates for ${k.name}`)
  const t = typical(certs)
  console.log(`${k.name}: ${t.certificates} certificates, GPH ${t.gph}`)
  return { id: k.id, name: k.name, source: `ORC certificates (median of ${t.certificates})`, ...t }
})
mkdirSync(new URL("../src/data/", import.meta.url).pathname, { recursive: true })
writeFileSync(OUT, `${JSON.stringify({ imported: new Date().toISOString().slice(0, 10), boats }, null, 2)}\n`)
console.log(`Wrote ${OUT}`)
