// Replaces collector/src/snapshot.js
import "dotenv/config";
import { redis, isoWeek } from "./redis.js";
import Graph from "graphology";
import louvain from "graphology-communities-louvain";
import forceAtlas2 from "graphology-layout-forceatlas2";

const MIN_SHARED = Number(process.env.MIN_SHARED) || 6;
const LINKS_CAP  = Number(process.env.LINKS_CAP)  || 2500;
const TOP_KEEP   = Number(process.env.TOP_KEEP)   || 1000;   // show the top-N by ACCUMULATED audience (stable)
const BUILT_BY   = process.env.BUILT_BY || "bachelur";
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

// --- Twitch helpers ---
let _tok = null, _exp = 0;
async function appToken() {
  if (_tok && Date.now() < _exp - 60000) return _tok;
  const r = await fetch("https://id.twitch.tv/oauth2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: process.env.TWITCH_CLIENT_ID, client_secret: process.env.TWITCH_CLIENT_SECRET, grant_type: "client_credentials" }) });
  if (!r.ok) throw new Error("token " + r.status); const j = await r.json(); _tok = j.access_token; _exp = Date.now() + j.expires_in * 1000; return _tok;
}
async function helix(pathq) {
  const tok = await appToken(); const headers = { "Client-Id": process.env.TWITCH_CLIENT_ID, Authorization: "Bearer " + tok };
  const r = await fetch("https://api.twitch.tv/helix/" + pathq, { headers }); if (!r.ok) throw new Error("helix " + r.status); return r.json();
}
async function getAvatars(logins) {
  const map = {}; if (!process.env.TWITCH_CLIENT_ID) return map;
  try { for (let i = 0; i < logins.length; i += 100) { const q = "users?" + logins.slice(i, i + 100).map(l => "login=" + encodeURIComponent(l)).join("&"); const j = await helix(q); for (const u of j.data) map[u.login.toLowerCase()] = u.profile_image_url; } console.log("fetched", Object.keys(map).length, "avatars"); } catch (e) { console.error("avatars", e.message); }
  return map;
}
async function getBuiltBy(login) {
  const out = { name: login, url: "https://twitch.tv/" + login, color: "#9146FF" };
  if (!process.env.TWITCH_CLIENT_ID) return out;
  try { const u = (await helix("users?login=" + encodeURIComponent(login))).data[0]; if (u) { out.name = u.display_name || login; out.avatar = u.profile_image_url; try { const c = (await helix("chat/color?user_id=" + u.id)).data[0]; if (c && c.color) out.color = c.color; } catch {} } } catch (e) { console.error("builtby", e.message); }
  return out;
}
async function scanChannels(week) {
  const chans = []; let cursor = "0"; const pre = "ch:" + week + ":";
  do { const res = await redis.scan(cursor, "MATCH", pre + "*", "COUNT", 1000); cursor = res[0]; for (const k of res[1]) chans.push(k.slice(pre.length)); } while (cursor !== "0");
  return chans;
}

async function run() {
  const week = process.env.WEEK || isoWeek();
  const logins = await scanChannels(week);
  if (!logins.length) throw new Error("no channel data yet for " + week + " — is the collector running?");
  console.log("channels in window:", logins.length);

  const chatters = new Map();
  for (const ch of logins) { const u = await redis.smembers("ch:" + week + ":" + ch); if (u.length) chatters.set(ch, u); }
  const msgCounts = (await redis.hgetall("msg:" + week).catch(() => ({}))) || {};

  // STABLE top-N: rank by accumulated chatters over the whole window
  const nodes = [...chatters.entries()].map(([login, u]) => ({ login, size: u.length })).sort((a, b) => b.size - a.size).slice(0, TOP_KEEP);
  const idx = new Map(nodes.map((n, i) => [n.login, i]));
  const STRIDE = TOP_KEEP + 1;

  console.log("computing overlap for top", nodes.length, "...");
  const userChans = new Map();
  for (const n of nodes) for (const u of chatters.get(n.login)) { let a = userChans.get(u); if (!a) userChans.set(u, (a = [])); a.push(idx.get(n.login)); }
  const pair = new Map();
  for (const chs of userChans.values()) { if (chs.length < 2) continue; chs.sort((a, b) => a - b); for (let a = 0; a < chs.length; a++) for (let b = a + 1; b < chs.length; b++) { const k = chs[a] * STRIDE + chs[b]; pair.set(k, (pair.get(k) || 0) + 1); } }
  let links = []; for (const [k, w] of pair) if (w >= MIN_SHARED) links.push([Math.floor(k / STRIDE), k % STRIDE, w]);
  links.sort((x, y) => y[2] - x[2]); links = links.slice(0, LINKS_CAP);
  console.log("mapping", nodes.length, "streamers,", links.length, "edges");

  const G = new Graph({ type: "undirected" });
  nodes.forEach((n, i) => G.addNode(i, { size: n.size }));
  for (const [a, b, w] of links) if (!G.hasEdge(a, b)) G.addEdge(a, b, { weight: w });
  const comm = louvain(G, { getEdgeWeight: "weight" });
  const pos = forceAtlas2(G, { iterations: 500, settings: { ...forceAtlas2.inferSettings(G), linLogMode: true, outboundAttractionDistribution: true, gravity: 0.5, scalingRatio: 10, barnesHutOptimize: true } });

  const byComm = new Map(); nodes.forEach((n, i) => { let a = byComm.get(comm[i]); if (!a) byComm.set(comm[i], (a = [])); a.push(i); });
  const order = [...byComm.entries()].sort((A, B) => B[1].reduce((s, i) => s + nodes[i].size, 0) - A[1].reduce((s, i) => s + nodes[i].size, 0));
  const cmap = new Map(), communities = [], commCount = [];
  order.forEach(([c, m], ci) => { cmap.set(c, ci); const big = m.slice().sort((a, b) => nodes[b].size - nodes[a].size)[0]; communities.push({ name: nodes[big].login, color: PALETTE[ci % PALETTE.length] }); commCount.push(m.length); });

  const avatars = await getAvatars(nodes.map(n => n.login));
  const nodesOut = nodes.map((n, i) => { const o = { n: n.login, c: cmap.get(comm[i]), a: n.size, x: Math.round(pos[i].x * 10) / 10, y: Math.round(pos[i].y * 10) / 10 }; if (avatars[n.login]) o.p = avatars[n.login]; return o; });

  // stats
  const chattersTracked = nodes.reduce((s, n) => s + n.size, 0);
  let mostActive = null, mostActiveMsgs = 0;
  for (const [ch, c] of Object.entries(msgCounts)) { const v = +c; if (v > mostActiveMsgs) { mostActiveMsgs = v; mostActive = ch; } }
  if (!mostActive && nodes.length) mostActive = nodes[0].login;
  const messages = Object.values(msgCounts).reduce((s, c) => s + (+c || 0), 0);
  const stats = { streamers: nodesOut.length, communities: communities.length, biggestCluster: communities[0]?.name || "", biggestClusterN: commCount[0] || 0, chattersTracked, messages, mostActive, mostActiveMsgs, channelsTracked: logins.length };
  const builtBy = await getBuiltBy(BUILT_BY);

  const graph = { week, generated: new Date().toISOString(), communities, nodes: nodesOut, links, meta: { stats, builtBy } };
  const js = JSON.stringify(graph);
  console.log(`built ${nodesOut.length} nodes, ${links.length} edges, ${communities.length} communities`);

  await putFile("data.json", js, "twitchmap: live data " + week);
  await putFile(`snapshots/data-${week}.json`, js, "twitchmap: snapshot " + week);
  let list = []; const gi = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPO}/contents/snapshots/index.json?ref=main`, { headers: { Authorization: "Bearer " + process.env.GITHUB_TOKEN, "User-Agent": "twitchmap" } });
  if (gi.ok) { try { list = JSON.parse(Buffer.from((await gi.json()).content, "base64").toString()); } catch {} }
  if (!list.includes(week)) { list.push(week); list.sort(); await putFile("snapshots/index.json", JSON.stringify(list), "twitchmap: index " + week); }
  console.log("done.");
  process.exit(0);
}
run().catch((e) => { console.error(e); process.exit(1); });
