// Replaces collector/src/collector.js
// Optimized: batches chatters in memory and flushes to Redis infrequently
// with a few big commands instead of many small ones — cuts Redis command
// usage ~10x vs the naive version.
import WebSocket from "ws";
import { redis, isoWeek } from "./redis.js";
import { getTopStreams } from "./twitch.js";

const IRC = "wss://irc-ws.chat.twitch.tv:443";
const TOP_N = Number(process.env.TOP_N) || 1000;              // fewer channels = far fewer writes (set via Railway env)
const PER_CONN = Number(process.env.CHANNELS_PER_CONNECTION) || 400;
const REFRESH_MS = 10 * 60 * 1000;                            // re-pull live list every 10 min
const FLUSH_MS = Number(process.env.FLUSH_MS) || 1800000;     // flush every 30 min (was every 5s) — the biggest cost lever
const JOINS_PER_10S = 18;
const CHATTER_TTL = 10 * 24 * 3600;

class Conn {
  constructor() { this.channels = new Set(); this.queue = []; this.joins = []; this.pumping = false; this.connect(); }
  connect() {
    this.ws = new WebSocket(IRC);
    this.ws.on("open", () => { this.ws.send("NICK justinfan" + Math.floor(Math.random() * 9e4 + 1e4)); for (const c of this.channels) this.queue.push(c); this.pump(); });
    this.ws.on("message", (d) => this.onData(d.toString()));
    this.ws.on("close", () => setTimeout(() => this.connect(), 2500));
    this.ws.on("error", () => { try { this.ws.close(); } catch {} });
  }
  onData(raw) {
    for (const line of raw.split("\r\n")) {
      if (!line) continue;
      if (line.startsWith("PING")) { this.ws.send("PONG :tmi.twitch.tv"); continue; }
      const m = line.match(/^:(\w+)!\w+@[\w.]+ PRIVMSG #(\w+) /);
      if (m) record(m[2].toLowerCase(), m[1].toLowerCase());
    }
  }
  add(ch) { if (!this.channels.has(ch)) { this.channels.add(ch); this.queue.push(ch); this.pump(); } }
  remove(ch) { if (this.channels.delete(ch) && this.ws?.readyState === 1) this.ws.send("PART #" + ch); }
  pump() {
    if (this.pumping) return; this.pumping = true;
    const step = () => {
      if (!this.queue.length || this.ws?.readyState !== 1) { this.pumping = false; return; }
      const now = Date.now(); this.joins = this.joins.filter((t) => now - t < 10000);
      if (this.joins.length >= JOINS_PER_10S) return setTimeout(step, 600);
      this.ws.send("JOIN #" + this.queue.shift()); this.joins.push(now); setTimeout(step, 560);
    };
    step();
  }
}

// in-memory accumulation; flush rarely with big pipelined SADDs
let week = isoWeek();
const pending = new Map();                     // channel -> Set(usernames)
const expired = new Set();                     // keys we've already set a TTL on this week
function record(ch, user) { let s = pending.get(ch); if (!s) pending.set(ch, (s = new Set())); s.add(user); }

async function flush() {
  const w = isoWeek(); if (w !== week) { week = w; expired.clear(); }
  if (!pending.size) return;
  const pipe = redis.pipeline();
  let cmds = 0;
  for (const [ch, set] of pending) {
    const users = [...set]; set.clear();
    const key = "ch:" + week + ":" + ch;
    for (let i = 0; i < users.length; i += 5000) { pipe.sadd(key, users.slice(i, i + 5000)); cmds++; }
    if (!expired.has(key)) { pipe.expire(key, CHATTER_TTL); expired.add(key); cmds++; }   // TTL once, not every flush
    const mc = msgs.get(ch) || 0; if (mc) { pipe.hincrby("msg:" + week, ch, mc); msgs.set(ch, 0); cmds++; }
  }
  if (!expired.has("msg:" + week)) { pipe.expire("msg:" + week, CHATTER_TTL); expired.add("msg:" + week); }
  pending.clear();
  await pipe.exec().catch((e) => console.error("flush", e.message));
  console.log(new Date().toISOString(), "flushed ~" + cmds + " commands");
}
setInterval(flush, FLUSH_MS);

const conns = []; const chanConn = new Map();
async function refresh() {
  try {
    const streams = await getTopStreams(TOP_N);
    const live = new Set(streams.map((s) => s.login));
    await redis.set("tracked:" + isoWeek(), JSON.stringify(streams));
    while (conns.length < Math.ceil(live.size / PER_CONN)) conns.push(new Conn());
    for (const [ch, ci] of chanConn) if (!live.has(ch)) { conns[ci]?.remove(ch); chanConn.delete(ch); }
    for (const ch of live) { if (chanConn.has(ch)) continue; let b = 0, bl = Infinity; for (let i = 0; i < conns.length; i++) if (conns[i].channels.size < bl) { bl = conns[i].channels.size; b = i; } conns[b].add(ch); chanConn.set(ch, b); }
    console.log(new Date().toISOString(), "tracking", chanConn.size, "channels /", conns.length, "conns");
  } catch (e) { console.error("refresh", e.message); }
}
refresh(); setInterval(refresh, REFRESH_MS);
process.on("SIGINT", async () => { await flush(); process.exit(0); });
