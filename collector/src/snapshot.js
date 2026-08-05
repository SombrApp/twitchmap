// ── snapshot / compute job ────────────────────────────────────────────
// Reads a week's chatter sets, computes shared-chatter overlap between
// channels, detects communities (Louvain) and lays them out (ForceAtlas2),
// then writes data.json in the EXACT shape twitchmap's front-end reads:
//   { communities:[{name,color}], nodes:[{n,c,a,x,y}], links:[[s,t,w]] }
// Also archives snapshots/data-<week>.json for the timeline scrubber.
// Run weekly (cron):  node src/snapshot.js
// ──────────────────────────────────────────────────────────────────────
import "dotenv/config";
import fs from "fs";
import path from "path";
import { redis, isoWeek } from "./redis.js";
import Graph from "graphology";
import louvain from "graphology-communities-louvain";
import forceAtlas2 from "graphology-layout-forceatlas2";

const OUT = process.env.OUT_DIR || "./out";
const MIN_SHARED = Number(process.env.MIN_SHARED) || 25;
const LINKS_CAP = Number(process.env.LINKS_CAP) || 12000;
const MAX_NODES = Number(process.env.MAX_NODES) || 2500;
const PALETTE = ["#4ade80","#fb7185","#38bdf8","#f472b6","#fbbf24","#a78bfa","#f97316","#22d3ee",
  "#a3e635","#e879f9","#14b8a6","#60a5fa","#f43f5e","#34d399","#c084fc","#fca5a5","#5eead4","#fdba74","#93c5fd","#f0abfc"];

async function run() {
  const week = process.env.WEEK || isoWeek();
  const tracked = JSON.parse((await redis.get("tracked:" + week)) || "[]");
  if (!tracked.length) throw new Error("no tracked channels for " + week + " — is the collector running?");
  const logins = tracked.map((t) => (typeof t === "string" ? t : t.login));

  console.log("loading chatter sets…");
  const chatters = new Map();
  for (const ch of logins) {
    const users = await redis.smembers("ch:" + week + ":" + ch);
    if (users.length) chatters.set(ch, users);
  }

  // top N channels by unique chatter count
  const nodes = [...chatters.entries()].map(([login, u]) => ({ login, size: u.length }))
    .sort((a, b) => b.size - a.size).slice(0, MAX_NODES);
  const idx = new Map(nodes.map((n, i) => [n.login, i]));

  // invert: user -> [channel indices], then count co-occurrence pairs (efficient)
  console.log("computing overlap…");
  const userChans = new Map();
  for (const n of nodes) for (const u of chatters.get(n.login)) {
    let arr = userChans.get(u); if (!arr) userChans.set(u, (arr = []));
    arr.push(idx.get(n.login));
  }
  const pair = new Map();
  for (const chs of userChans.values()) {
    if (chs.length < 2) continue;
    chs.sort((a, b) => a - b);
    for (let a = 0; a < chs.length; a++)
      for (let b = a + 1; b < chs.length; b++) {
        const k = chs[a] * MAX_NODES + chs[b];
        pair.set(k, (pair.get(k) || 0) + 1);
      }
  }

  // thresholded, strongest-first, capped
  let links = [];
  for (const [k, w] of pair) if (w >= MIN_SHARED) links.push([Math.floor(k / MAX_NODES), k % MAX_NODES, w]);
  links.sort((x, y) => y[2] - x[2]);
  links = links.slice(0, LINKS_CAP);

  // community detection + layout
  const G = new Graph({ type: "undirected" });
  nodes.forEach((n, i) => G.addNode(i, { size: n.size }));
  for (const [a, b, w] of links) if (!G.hasEdge(a, b)) G.addEdge(a, b, { weight: w });
  console.log("louvain…");
  const comm = louvain(G, { getEdgeWeight: "weight" });
  console.log("forceatlas2…");
  const settings = forceAtlas2.inferSettings(G);
  const pos = forceAtlas2(G, { iterations: 400, settings: { ...settings, gravity: 1, scalingRatio: 12, barnesHutOptimize: true } });

  // remap communities → contiguous, ordered by total size; color + name each
  const byComm = new Map();
  nodes.forEach((n, i) => { const c = comm[i]; let a = byComm.get(c); if (!a) byComm.set(c, (a = [])); a.push(i); });
  const order = [...byComm.entries()].sort((A, B) =>
    B[1].reduce((s, i) => s + nodes[i].size, 0) - A[1].reduce((s, i) => s + nodes[i].size, 0));
  const cmap = new Map(), communities = [];
  order.forEach(([c, members], ci) => {
    cmap.set(c, ci);
    const big = members.slice().sort((a, b) => nodes[b].size - nodes[a].size)[0];
    communities.push({ name: nodes[big].login, color: PALETTE[ci % PALETTE.length] });
  });

  const nodesOut = nodes.map((n, i) => ({
    n: n.login, c: cmap.get(comm[i]), a: n.size,
    x: Math.round(pos[i].x * 10) / 10, y: Math.round(pos[i].y * 10) / 10,
  }));
  const graph = { week, generated: new Date().toISOString(), communities, nodes: nodesOut, links };

  fs.mkdirSync(path.join(OUT, "snapshots"), { recursive: true });
  fs.writeFileSync(path.join(OUT, "data.json"), JSON.stringify(graph));           // latest (what the map fetches)
  fs.writeFileSync(path.join(OUT, "snapshots", `data-${week}.json`), JSON.stringify(graph)); // archive for timeline
  const snaps = fs.readdirSync(path.join(OUT, "snapshots"))
    .filter((f) => /^data-.*\.json$/.test(f)).map((f) => f.slice(5, -5)).sort();
  fs.writeFileSync(path.join(OUT, "snapshots", "index.json"), JSON.stringify(snaps));

  console.log(`done: ${nodesOut.length} nodes, ${links.length} edges, ${communities.length} communities -> ${OUT}/data.json`);
  process.exit(0);
}
run().catch((e) => { console.error(e); process.exit(1); });
