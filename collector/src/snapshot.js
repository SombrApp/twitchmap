// Replaces collector/src/snapshot.js
// Builds the map from the week's chatter sets and publishes data.json to the repo.
import "dotenv/config";
import { redis, isoWeek } from "./redis.js";
import Graph from "graphology";
import louvain from "graphology-communities-louvain";
import forceAtlas2 from "graphology-layout-forceatlas2";

const MIN_SHARED = Number(process.env.MIN_SHARED) || 6;   // noise floor
const LINKS_CAP  = Number(process.env.LINKS_CAP)  || 2500;   // render only the strongest N edges — keeps communities readable
const MAX_NODES  = Number(process.env.MAX_NODES)  || 2500;
const PALETTE = ["#4ade80","#fb7185","#38bdf8","#f472b6","#fbbf24","#a78bfa","#f97316","#22d3ee",
  "#a3e635","#e879f9","#14b8a6","#60a5fa","#f43f5e","#34d399","#c084fc","#fca5a5","#5eead4","#fdba74","#93c5fd","#f0abfc"];

async function putFile(path, contentStr, msg) {
  const repo = process.env.GITHUB_REPO, tok = process.env.GITHUB_TOKEN;
  if (!repo || !tok) { console.log("(no GITHUB_TOKEN/REPO — skipping " + path + ")"); return; }
  const api = `https://api.github.com/repos/${repo}/contents/${path}`;
  const headers = { Authorization: "Bearer " + tok, Accept: "application/vnd.github+json", "User-Agent": "twitchmap" };
  let sha; const g = await fetch(api + "?ref=main", { headers }); if (g.ok) sha = (await g.json()).sha;
  const body = { message: msg || ("update " + path), content: Buffer.from(contentStr).toString("base64"), branch: "main", sha };
  const p = await fetch(api, { method: "PUT", headers, body: JSON.stringify(body) });
  console.log("publish", path, "->", p.status, p.ok ? "ok" : await p.text());
}

async function run() {
  const week = process.env.WEEK || isoWeek();
  const tracked = JSON.parse((await redis.get("tracked:" + week)) || "[]");
  const logins = tracked.map((t) => (typeof t === "string" ? t : t.login));
  if (!logins.length) throw new Error("no tracked channels yet for " + week);

  console.log("loading chatter sets...");
  const chatters = new Map();
  for (const ch of logins) { const u = await redis.smembers("ch:" + week + ":" + ch); if (u.length) chatters.set(ch, u); }
  console.log(chatters.size, "channels have chatters so far");

  let nodes = [...chatters.entries()].map(([login, u]) => ({ login, size: u.length }))
    .sort((a, b) => b.size - a.size).slice(0, MAX_NODES);
  const idx = new Map(nodes.map((n, i) => [n.login, i]));

  console.log("computing overlap...");
  const userChans = new Map();
  for (const n of nodes) for (const u of chatters.get(n.login)) { let a = userChans.get(u); if (!a) userChans.set(u, (a = [])); a.push(idx.get(n.login)); }
  const pair = new Map();
  for (const chs of userChans.values()) { if (chs.length < 2) continue; chs.sort((a, b) => a - b);
    for (let a = 0; a < chs.length; a++) for (let b = a + 1; b < chs.length; b++) { const k = chs[a] * MAX_NODES + chs[b]; pair.set(k, (pair.get(k) || 0) + 1); } }
  let links = []; for (const [k, w] of pair) if (w >= MIN_SHARED) links.push([Math.floor(k / MAX_NODES), k % MAX_NODES, w]);
  links.sort((x, y) => y[2] - x[2]); links = links.slice(0, LINKS_CAP);

  // keep only connected streamers (drop isolated dots so it looks like a map, not confetti)
  const used = new Set(); for (const [a, b] of links) { used.add(a); used.add(b); }
  let keptNodes = [], remap = new Map();
  nodes.forEach((n, i) => { if (used.has(i)) { remap.set(i, keptNodes.length); keptNodes.push(n); } });
  let keptLinks = links.map(([a, b, w]) => [remap.get(a), remap.get(b), w]);
  if (keptNodes.length < 30) { // super-early fallback: show the biggest channels regardless
    keptNodes = nodes.slice(0, Math.min(nodes.length, 150));
    const id2 = new Map(keptNodes.map((n, i) => [n.login, i]));
    keptLinks = links.map(([a, b, w]) => [id2.get(nodes[a].login), id2.get(nodes[b].login), w]).filter(([a, b]) => a != null && b != null);
  }
  nodes = keptNodes; links = keptLinks;
  console.log("mapping", nodes.length, "connected streamers,", links.length, "edges");

  const G = new Graph({ type: "undirected" });
  nodes.forEach((n, i) => G.addNode(i, { size: n.size }));
  for (const [a, b, w] of links) if (!G.hasEdge(a, b)) G.addEdge(a, b, { weight: w });
  const comm = louvain(G, { getEdgeWeight: "weight" });
  const pos = forceAtlas2(G, { iterations: 600, settings: { ...forceAtlas2.inferSettings(G), linLogMode: true, outboundAttractionDistribution: true, gravity: 0.8, scalingRatio: 5, barnesHutOptimize: true } });

  const byComm = new Map(); nodes.forEach((n, i) => { let a = byComm.get(comm[i]); if (!a) byComm.set(comm[i], (a = [])); a.push(i); });
  const order = [...byComm.entries()].sort((A, B) => B[1].reduce((s, i) => s + nodes[i].size, 0) - A[1].reduce((s, i) => s + nodes[i].size, 0));
  const cmap = new Map(), communities = [];
  order.forEach(([c, m], ci) => { cmap.set(c, ci); const big = m.slice().sort((a, b) => nodes[b].size - nodes[a].size)[0]; communities.push({ name: nodes[big].login, color: PALETTE[ci % PALETTE.length] }); });

  const nodesOut = nodes.map((n, i) => ({ n: n.login, c: cmap.get(comm[i]), a: n.size, x: Math.round(pos[i].x * 10) / 10, y: Math.round(pos[i].y * 10) / 10 }));
  const graph = { week, generated: new Date().toISOString(), communities, nodes: nodesOut, links };
  const js = JSON.stringify(graph);
  console.log(`built ${nodesOut.length} nodes, ${links.length} edges, ${communities.length} communities`);

  await putFile("data.json", js, "twitchmap: live data " + week);
  await putFile(`snapshots/data-${week}.json`, js, "twitchmap: snapshot " + week);
  let list = [];
  const gi = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPO}/contents/snapshots/index.json?ref=main`, { headers: { Authorization: "Bearer " + process.env.GITHUB_TOKEN, "User-Agent": "twitchmap" } });
  if (gi.ok) { try { list = JSON.parse(Buffer.from((await gi.json()).content, "base64").toString()); } catch {} }
  if (!list.includes(week)) { list.push(week); list.sort(); await putFile("snapshots/index.json", JSON.stringify(list), "twitchmap: index " + week); }
  console.log("done.");
  process.exit(0);
}
run().catch((e) => { console.error(e); process.exit(1); });
