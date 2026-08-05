# twitchmap collector

Builds the live data behind twitchmap by observing Twitch chat, computing
shared-chatter overlap between channels, and emitting the graph JSON the map
front-end reads. Adapted from the proven approach of Kiran Gershenfeld's
*VisualizingTwitchCommunities* and snoww's *TwitchOverlap* (both MIT), rebuilt
in Node for the post-2023 API reality (the old chatters endpoint is gone, so we
observe chat over IRC).

## How it works

    Helix Get Streams ──▶ top ~2,500 live channels
             │
             ▼
    collector.js  ──▶  joins each channel's chat anonymously over IRC,
                       records which usernames chat where, into Redis sets
                       (one set per channel per ISO week)
             │
             ▼   (run weekly)
    snapshot.js   ──▶  overlap between every channel pair  ▶  Louvain communities
                       ▶  ForceAtlas2 layout  ▶  out/data.json  (+ weekly archive)
             │
             ▼
    twitchmap  ──▶  fetches data.json and renders it

`data.json` is written in the exact shape the map already reads:

    { "communities":[{"name","color"}], "nodes":[{"n","c","a","x","y"}], "links":[[s,t,w]] }

so it drops straight in with no transform.

## One-time setup

1. **Twitch app** — create one at https://dev.twitch.tv/console/apps to get a
   Client ID + Secret (used only for the Get Streams API; no chat scope needed
   because we read chat anonymously over IRC).
2. **Redis** — local (`brew install redis` / `apt install redis`) or a hosted
   instance (Upstash, Railway, etc.).
3. `cp .env.example .env` and fill in the values.
4. `npm install`  (Node 18+ required — uses built-in fetch).

## Run

    npm run channels     # sanity check: prints the top live channels
    npm run collect      # start the collector (leave running 24/7)
    npm run snapshot     # build out/data.json from the week so far

Let `collect` run for at least a few days before the first `snapshot` so the
chatter sets are meaningful. Then schedule `snapshot` weekly (cron):

    0 12 * * 1  cd /path/to/collector && /usr/bin/node src/snapshot.js >> snapshot.log 2>&1

## Deploy

- **collector.js** needs an always-on host (it holds live websockets): a small
  VPS, Railway, or Fly.io. ~$5–20/mo plus Redis.
- **snapshot.js** is a scheduled job on the same box.
- Publish `out/data.json` where the site can fetch it — commit it to the
  twitchmap repo (Cloudflare Pages redeploys on push), or push to R2/a bucket.

## Wiring the map to live data

Today the map embeds its data as `const GRAPH = {…}`. To go live, replace that
with a fetch:

    const GRAPH = await (await fetch("/data.json")).json();

(run `init()` after it resolves). The `out/snapshots/` folder + `index.json`
list is what the **timeline scrubber** reads later — each week is one file, so
the slider just loads the selected week's snapshot.

## Tuning knobs (.env)

- `TOP_N` — how many top channels to track (2500 default).
- `MIN_SHARED` — drop channel pairs sharing fewer than N chatters (noise floor).
- `LINKS_CAP` — max edges kept (keeps the map light; strongest win).
- `CHANNELS_PER_CONNECTION` — IRC sharding; more connections = faster joins.

## Notes & risks

- **Chatters ≠ viewers.** Only people who type are counted — the same proxy the
  famous atlases use.
- **IRC is on a leash.** Twitch is tightening IRC join limits to push chat onto
  EventSub. Stay under the limits (the collector rate-limits joins); if it ever
  gets cut, the fallback is per-broadcaster EventSub opt-in — which doubles as
  the "claim your channel" feature.
- **Be a good citizen.** Reading public chat is standard, but you're storing
  usernames at scale — mind Twitch's Developer Agreement as this grows.
