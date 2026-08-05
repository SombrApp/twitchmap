import "dotenv/config";

// --- App access token (client-credentials), cached until near expiry ---
let token = null, tokenExp = 0;
async function appToken() {
  if (token && Date.now() < tokenExp - 60000) return token;
  const r = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.TWITCH_CLIENT_ID,
      client_secret: process.env.TWITCH_CLIENT_SECRET,
      grant_type: "client_credentials",
    }),
  });
  if (!r.ok) throw new Error("token " + r.status + " " + (await r.text()));
  const j = await r.json();
  token = j.access_token;
  tokenExp = Date.now() + j.expires_in * 1000;
  return token;
}

// --- Top live channels via Helix Get Streams (sorted by viewers, no special scope) ---
export async function getTopStreams(topN = 2500) {
  const tok = await appToken();
  const headers = { "Client-Id": process.env.TWITCH_CLIENT_ID, Authorization: "Bearer " + tok };
  const out = [];
  let cursor = null;
  while (out.length < topN) {
    const url = new URL("https://api.twitch.tv/helix/streams");
    url.searchParams.set("first", "100");
    url.searchParams.set("type", "live");
    if (cursor) url.searchParams.set("after", cursor);
    const r = await fetch(url, { headers });
    if (r.status === 429) { await new Promise((s) => setTimeout(s, 2000)); continue; }
    if (!r.ok) throw new Error("streams " + r.status + " " + (await r.text()));
    const j = await r.json();
    for (const s of j.data)
      out.push({ login: s.user_login.toLowerCase(), id: s.user_id, viewers: s.viewer_count, game: s.game_name });
    cursor = j.pagination?.cursor;
    if (!cursor || !j.data.length) break;
  }
  return out.slice(0, topN);
}

// quick manual test:  node src/twitch.js
if (import.meta.url === `file://${process.argv[1]}`) {
  getTopStreams(Number(process.env.TOP_N) || 2500)
    .then((s) => { console.log("live channels:", s.length, "| top 5:", s.slice(0, 5).map((x) => x.login)); process.exit(0); })
    .catch((e) => { console.error(e); process.exit(1); });
}
