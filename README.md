# Sailgrid

A turn-based sailing regatta on grid paper. It grew out of pencil racing (Racetrack): every boat sits on a grid
intersection and its speed carries over from turn to turn. Here the speed comes from the wind and the boat. Each
turn you choose a **heading** (the crew trims the sails), then every boat sails its minute at once. You sail
one of four real boats, with no handicap: first across the line wins, so the race is won by picking the boat
that suits the day's wind and course, and then the best route round it.

## The game

- **Grid.** A fine grid (80×56 to 140×96 intersections). Boats move several intersections a turn and land on
  the nearest one.
- **Boats.** Four popular designs: J/35, J/109, X-35 and Melges 24. They were chosen from ORC's 2026
  certificates because their real polars are about equally fast overall (within ~1.5%), yet each is the
  quickest in different conditions:
  - J/35: upwind, in any wind.
  - J/109: reaching and running in light and medium air.
  - X-35: the all-rounder; close to the best on every point of sail in light and medium air, the best at
    nothing (1.5% slower than its certificates, see `PACE`).
  - Melges 24: reaching and downwind in strong air, and reaching in medium.

  There's no handicap: first across the line wins, so choosing the boat for the day's wind and course is
  part of the game. `scripts/fetch-boats.ts` (`pnpm fetch-boats`, run by hand once) downloads the
  certificates from data.orc.org and saves the median of each class (32–75 certificates) into
  `src/data/boats.json`. That file holds the VPP speed table (beat, 52°–150°, run), size and weight, plus
  GPH and triple numbers for reference. `src/game/fleet.ts` turns it into polars, unchanged except for `PACE` and a
  pinching zone a few degrees above the beat angle, a no-go zone closer to the wind, and a dead run. It
  also sets each class's handling (turn rate, and how quickly speed builds and fades) from size and weight.
- **Scale.** One turn is a minute of sailing; a cell is about 39 m, roughly three lengths of the 40-foot
  boat (`src/game/units.ts`).
- **Handling.** Each turn is simulated a second at a time (`src/game/boat.ts`):
  - The boat turns onto the new heading at 3°/s when stopped, up to its class's rate (11–13°/s) at speed,
    so it sails an arc. The rudder costs a little speed; the crew keeps the sails trimmed.
  - Speed closes on the polar speed with the class's time constant: about 12 s for the Melges 24, 17–19 s
    for the others, a little slower when slowing down.
  - Inside the no-go zone the sails give no drive and the boat stops within 5–10 s. A tack costs about
    2.5 boat lengths and a gybe a few percent of speed; bearing away costs almost nothing.
  - The wind is sampled along the way.
  - Land, marks, gates and contact between boats are all checked along the arc actually sailed.
- **Wind.** Every intersection has its own direction and strength, a pure function of the map seed and
  the turn number, so all clients and the AI agree (`src/game/wind.ts`). The **Weather** setting (settled,
  changeable, unsettled, stormy) sets how unstable it is: how big the shifts are, how strong the puffs, how
  many wind lines and eddies, and whether a front might come. Wind speed is a separate setting, though random
  races make worse weather windier on average. It's made of:
  - a breeze that oscillates and wanders, with each shift travelling downwind with the air, so boats
    further upwind get it first;
  - puffs and lulls carried downwind at about 70% of the wind speed, stretched along the wind and changing
    over a few minutes, with puffs veering and lulls backing (northern hemisphere);
  - a slow, large-scale bias that favours one part of the course;
  - wind lines: a new breeze filling in. A band of changed wind moves down the course; behind its leading
    edge the wind has shifted 10–25° either way and is usually 15–40% stronger (sometimes lighter), for 3–8
    turns at any one spot, before the old breeze returns. About one every 24 turns when settled, down to
    one every 8 when stormy, and bigger in worse weather;
  - eddies, a few hundred metres across, that drift downwind with the air for 6–14 turns and fade; the air
    turns round each one, so the wind is stronger on one side, lighter on the other, and swings in direction;
  - wind shadow behind islands (longer behind higher land, and gusty), wind speeding up between islands and
    round headlands, and wind bending along a shore it blows onto;
  - occasionally a front, on any day but a settled one: 5% of changeable days, 20% of unsettled ones and 45% of
    stormy ones (about one random race in nine).
    A line sweeps across the course partway through the race. Ahead of it the wind backs and eases, on the
    line there's a squall, then 1.7–3 km of rough air (several turns of it) full of eddies, where the
    direction jumps by 20–30° and gusts and lulls come and go every turn, and behind that the wind has
    settled, veered 35–70° and 20–50% stronger, for the rest of the race. Nothing announces it: the wind shows
    it coming.

  None of this is a fluid simulation: the wind at each intersection is computed fresh each turn from the seed
  and the turn number, so the motion comes from that recipe changing smoothly with time.
- **Maps.** Generated from a seed (`src/game/map.ts`): islands from fractal noise, and one of three
  courses: windward–leeward (beats and runs, 1–3 laps), a triangle (a beat and two reaches, 1–3 laps), or
  a loop round the islands with 3–4 marks. The generator clears water around every mark and the start
  line, and checks that the course can be sailed.
- **Course.** Cross the start line upwind, then round each mark on its side, then cross the finish line
  from the course side (the side of the last mark), as in the racing rules. A mark counts once you cross the
  ray running out from it, away from the course, in the right direction; going round the wrong way has to
  be undone first. Crossing the start or finish line the wrong way just doesn't count. The chart labels
  "Start" and "Finish" on the side they're crossed from, with an arrow the way across that counts.
- **Racing rules.** Simplified Racing Rules of Sailing, checked each turn (`src/game/race.ts`). Two boats
  that come within 0.8 of a cell of each other during a turn have met:
  - rule 10: port tack keeps clear of starboard tack;
  - rule 11: when overlapped on the same tack, the windward boat keeps clear;
  - rule 12: a boat clear astern keeps clear;
  - rule 13: a boat that tacked keeps clear.

  The boat at fault takes a 2-turn time penalty. Touching a mark costs 1 turn, and so does running aground
  (the boat also stops at the shore). Results are elapsed time plus penalties.

## Players

- **Solo** against 1–7 AI boats (easy, medium or hard).
- **Hot-seat**: several humans on one screen. Plans are entered in turn behind a hand-over screen.
- **Spectate**: AI boats only, with play, pause and step.
- **Online**: peer to peer over WebRTC ([PeerJS](https://peerjs.com)), set up the same way as the other games
  on raffinate.github.io. The host sends an invite link and each guest gets a boat. The host runs the race,
  including the AI; guests only send their own plans.

After the finish, a **replay** bar under the chart scrubs through the race turn by turn or plays it back
(←/→ to step, Home/End, Space to play). Each device records the race as it goes, so every player, online
too, replays on their own.

## AI

`src/game/ai.ts`. Each turn a backward Dijkstra over (intersection × gates still to cross) gives the time to
finish from everywhere, at polar speed in the current wind. A step that crosses the next gate the right way
moves on to the next layer; crossing it the wrong way isn't allowed. Each AI boat then simulates every
heading with the real physics. It scores a heading by route time from where it lands, plus costs for lost
speed, getting near a mark, and probably fouling another boat (assuming the others hold their course).

- **Easy** looks at fewer headings and helms carelessly.
- **Medium** is more careful.
- **Hard** steers precisely and looks a turn further ahead, using the next turn's wind.

## Develop

```sh
pnpm install
pnpm dev         # http://localhost:5173
pnpm test
pnpm typecheck
pnpm build
```

Stack: Solid 2, [ui-sdk](https://ui-sdk.dev) components styled with Tailwind 4, Vite. It's the same stack as
the other projects on [raffinate.github.io](https://raffinate.github.io/). The game engine (`src/game/`) is
plain TypeScript with no UI dependencies. `src/components/` holds the Solid UI, and the chart is drawn on a
canvas (`draw.ts`).

Analytics: cookieless PostHog (page views, clicks, and `race_started`, `race_hosted`, `race_joined`,
`race_finished` events), only on the deployed site. The light/dark choice is stored under the same `theme`
key as the blog, so it carries across the site.

## Deploy

`.github/workflows/deploy.yml` builds and deploys to GitHub Pages on every push to `main`. In the repository
settings, set **Pages → Source** to **GitHub Actions**.

## License

Apache-2.0, see `LICENSE`.
