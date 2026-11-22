# Sailgrid

A turn-based sailing regatta on grid paper. It grew out of pencil racing (Racetrack): every boat sits on a
grid intersection and its speed carries over from turn to turn. Here the speed comes from the wind and the
sails. Each turn you set a **heading** and a **sheet** (how far the sail is eased). The boat's polar and your
trim give a target speed, and the boat's speed eases toward it. Then every boat moves at once.

## The game

- **Grid.** A fine grid (80×56 to 140×96 intersections). Boats move several intersections a turn and land on
  the nearest one.
- **Boat.** Speeds come from a Beneteau First 40.7 polar (OpenCPN Weather Routing), interpolated the same way
  as in [boatpolarsolver](https://github.com/Raffinate/boatpolar): monotone cubic between angles, linear
  between wind speeds. The no-go zone is about 33° each side of the wind.
- **Scale.** One turn is a minute of sailing; a cell is about 39 m, roughly three lengths of the 40-foot
  boat (`src/game/units.ts`).
- **Sail trim.** The ideal sheet setting grows with the wind angle, from nearly centered close-hauled to
  85° on a run. Easing past it makes the sail luff and loses drive fast; sheeting in too hard stalls it,
  which costs less.
- **Handling.** Each turn is simulated a second at a time (`src/game/boat.ts`):
  - The boat turns onto the new heading at 3–12°/s depending on its speed, so it sails an arc. The rudder
    costs a little speed, and the crew trims through the turn.
  - Speed closes on its target with a time constant of about 20 s, a little slower when slowing down.
  - Inside the no-go zone the sails give no drive and the boat stops within about 9 s. A tack costs about
    2.5 boat lengths and a gybe a few percent of speed; bearing away costs almost nothing.
  - The wind is sampled along the way.
  - Land, marks, gates and contact between boats are all checked along the arc actually sailed.
- **Wind.** Every intersection has its own direction and strength, a pure function of the map seed and
  the turn number, so all clients and the AI agree (`src/game/wind.ts`). It's made of:
  - a breeze that oscillates and wanders, with each shift travelling downwind with the air, so boats
    further upwind get it first;
  - puffs and lulls carried downwind at about 70% of the wind speed, stretched along the wind and changing
    over a few minutes, with puffs veering and lulls backing (northern hemisphere);
  - a slow, large-scale bias that favours one part of the course;
  - wind shadow behind islands (longer behind higher land, and gusty), wind speeding up between islands and
    round headlands, and wind bending along a shore it blows onto.
- **Maps.** Generated from a seed (`src/game/map.ts`): islands from fractal noise, and either a
  windward–leeward course (1–3 laps) or a loop around the islands with 3–4 marks. The generator clears water
  around every mark and the start line, and checks that the course can be sailed.
- **Course.** Cross the start line upwind, then round each mark on its side, then cross the finish. A mark
  counts once you cross the ray running out from it, away from the course, in the right direction; going
  round the wrong way has to be undone first.
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

## AI

`src/game/ai.ts`. Each turn a backward Dijkstra over (intersection × gates still to cross) gives the time to
finish from everywhere, at polar speed in the current wind. A step that crosses the next gate the right way
moves on to the next layer; crossing it the wrong way isn't allowed. Each AI boat then simulates every
heading with the real physics. It scores a heading by route time from where it lands, plus costs for lost
speed, getting near a mark, and probably fouling another boat (assuming the others hold their course).

- **Easy** looks at fewer headings and helms and trims carelessly.
- **Medium** is more careful.
- **Hard** trims perfectly and looks a turn further ahead, using the next turn's wind.

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
