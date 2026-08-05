# twitchmap

The living map of Twitch — every streamer as a light, pulled together by the
chat they share. A single static page (`index.html`) plus a data collector
(`/collector`) that will feed it live data later.

Repo layout:

    index.html        the whole site (map, UI, embedded seed data)
    og.png            social-share preview image
    collector/        Node service that builds live data (see collector/README.md)

---

## Part 1 — Put the site live (free, ~15 min)

You need three free accounts: **GitHub**, **Cloudflare**, and your domain
registrar (you already own twitchmap.com). Optional: **Ko-fi** for donations.

1. **Create the repo.** On github.com, New repository → name it `twitchmap`,
   Public → Create. Upload every file in this folder (drag them into the
   "uploading an existing file" box, or use git — see bottom). Commit.

2. **Deploy on Cloudflare Pages.** At dash.cloudflare.com → Workers & Pages →
   Create → Pages → Connect to Git → pick `twitchmap`. Leave the build command
   and output directory **blank** (it's a static site). Save and Deploy. In ~1
   minute you get a live `something.pages.dev` URL — open it, the map should be
   there.

3. **Point your domain at it.** Still in Cloudflare: add your site
   (Add a site → twitchmap.com) and change your nameservers at your registrar
   to the two Cloudflare gives you (propagation can take a few hours). Then in
   the Pages project → Custom domains → add `twitchmap.com` and `www`. HTTPS is
   automatic.

4. **Turn on analytics.** Cloudflare → Web Analytics → enable for twitchmap.com.
   Free, no code.

5. **Wire up donations.** Make a Ko-fi at ko-fi.com, then in `index.html` find
   `href="https://ko-fi.com/twitchmap"` and replace it with your real Ko-fi URL.
   Commit — Cloudflare redeploys automatically.

That's the whole launch. Every `git push` (or edit-and-commit on github.com)
redeploys in about a minute.

---

## Part 2 — Go live with fresh data (later)

The site currently ships with a real but dated (Dec 2022) seed snapshot embedded
in `index.html`. To make it current, stand up the collector — full instructions
in **collector/README.md**. In short:

1. Create a Twitch dev app (dev.twitch.tv) for an API key.
2. Get a Redis instance (local or hosted).
3. Run `collector.js` 24/7 on a small always-on host (Railway / Fly / a VPS).
4. Run `snapshot.js` weekly to produce `out/data.json`.
5. Publish that `data.json` to this repo, and flip the map from embedded data to
   a fetch (one-line change, described in collector/README.md). Weekly snapshots
   also power the timeline scrubber.

Part 1 needs nothing from Part 2 — launch the site now, add live data whenever.

---

## Using git instead of drag-and-drop

    cd twitchmap
    git init && git add . && git commit -m "twitchmap"
    git branch -M main
    git remote add origin https://github.com/YOUR_USERNAME/twitchmap.git
    git push -u origin main
