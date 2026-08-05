// ── twitchmap collector ───────────────────────────────────────────────
// Connects anonymously to Twitch IRC, joins the current top-N live
// channels, and records which usernames chat in which channel into Redis
// sets (one set per channel per ISO week). Dynamically joins/parts as
// channels go live/offline. Run this continuously on an always-on host.
// ──────────────────────────────────────────────────────────────────────
import WebSocket from "ws";
import "dotenv/config";
import { redis, isoWeek } from "./redis.js";
import { getTopStreams } from "./twitch.js";

const IRC = "wss://irc-ws.chat.twitch.tv:443";
const PER_CONN = Number(process.env.CHANNELS_PER_CONNECTION) || 350;
const TOP_N = Number(process.env.TOP_N) || 2500;
const REFRESH_MS = 5 * 60 * 1000;     // re-pull the live channel list every 5 min
const JOINS_PER_10S = 18;             // stay safely under Twitch's IRC join limit
const CHATTER_TTL = 8 * 24 * 3600;    // keep each week's sets ~8 days

// One anonymous IRC connection holding up to PER_CONN channels.
class Conn {
  constructor(id) {
    this.id = id;
    this.channels = new Set();
    this.queue = [];
    this.joinsWindow = [];
    this.pumping = false;
    this.connect();
  }
  connect() {
    this.ws = new WebSocket(IRC);
    this.ws.on("open", () => {
      this.ws.send("NICK justinfan" + Math.floor(Math.random() * 90000 + 10000));
      for (const c of this.channels) this.queue.push(c); // re-join after reconnect
      this.pump();
    });
    this.ws.on("message", (d) => this.onData(d.toString()));
    this.ws.on("close", () => setTimeout(() => this.connect(), 2000 + Math.random() * 2000));
    this.ws.on("error", () => { try { this.ws.close(); } catch {} });
  }
  onData(raw) {
    for (const line of raw.split("\r\n")) {
      if (!line) continue;
      if (line.startsWith("PING")) { this.ws.send("PONG :tmi.twitch.tv"); continue; }
      // :user!user@user.tmi.twitch.tv PRIVMSG #channel :message
      const m = line.match(/^:(\w+)!\w+@[\w.]+ PRIVMSG #(\w+) /);
      if (m) record(m[2].toLowerCase(), m[1].toLowerCase());
    }
  }
  add(ch) { if (!this.channels.has(ch)) { this.channels.add(ch); this.queue.push(ch); this.pump(); } }
  remove(ch) { if (this.channels.delete(ch) && this.ws?.readyState === 1) this.ws.send("PART #" + ch); }
  pump() {
    if (this.pumping) return;
    this.pumping = true;
    const step = () => {
      if (!this.queue.length || this.ws?.readyState !== 1) { this.pumping = false; return; }
      const now = Date.now();
      this.joinsWindow = this.joinsWindow.filter((t) => now - t < 10000);
      if (this.joinsWindow.length >= JOINS_PER_10S) { setTimeout(step, 600); return; }
      const ch = this.queue.shift();
      this.ws.send("JOIN #" + ch);
      this.joinsWindow.push(now);
      setTimeout(step, 560);
    };
    step();
  }
}

// ── batched writes to Redis (channel -> set of chatter usernames) ──
let week = isoWeek();
const pending = {};
function record(channel, user) {
  const key = "ch:" + week + ":" + channel;
  (pending[key] = pending[key] || new Set()).add(user);
}
async function flush() {
  week = isoWeek();
  const keys = Object.keys(pending);
  if (!keys.length) return;
  const pipe = redis.pipeline();
  for (const k of keys) {
    const users = [...pending[k]];
    delete pending[k];
    for (let i = 0; i < users.length; i += 1000) pipe.sadd(k, users.slice(i, i + 1000));
    pipe.expire(k, CHATTER_TTL);
  }
  await pipe.exec().catch((e) => console.error("flush", e.message));
}
setInterval(flush, 5000);

// ── connection pool + live-channel refresh ──
const conns = [];
const chanConn = new Map(); // channel -> conn index
function ensureConns(n) { while (conns.length < n) conns.push(new Conn(conns.length)); }

async function refresh() {
  try {
    const streams = await getTopStreams(TOP_N);
    const live = new Set(streams.map((s) => s.login));
    // persist the tracked list + viewer counts for this week (used by snapshot.js)
    await redis.set("tracked:" + isoWeek(), JSON.stringify(streams));
    ensureConns(Math.max(conns.length, Math.ceil(live.size / PER_CONN)));

    for (const [ch, ci] of chanConn) if (!live.has(ch)) { conns[ci]?.remove(ch); chanConn.delete(ch); }
    for (const ch of live) {
      if (chanConn.has(ch)) continue;
      let best = 0, bl = Infinity;
      for (let i = 0; i < conns.length; i++) if (conns[i].channels.size < bl) { bl = conns[i].channels.size; best = i; }
      conns[best].add(ch);
      chanConn.set(ch, best);
    }
    console.log(new Date().toISOString(), "tracking", chanConn.size, "live channels /", conns.length, "connections");
  } catch (e) {
    console.error("refresh", e.message);
  }
}
refresh();
setInterval(refresh, REFRESH_MS);
process.on("SIGINT", async () => { await flush(); process.exit(0); });
