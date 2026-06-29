# Brainrot Logger

A real-time website for your Brainrot Plaza finds. Every time your scanner logs an
animal, it appears instantly on the site, split into **Recent OGs**, **Recent Dragons**
and **Recent Small**, each card showing:

- the animal **image**
- the **OG / Dragon / Small** tag
- a **mutation** tag (or `Normal`)
- the **generation** (e.g. `$1.2M/s`)
- the owner's **username** + a **Join** button
- a **live timer** ("12s ago") that keeps counting

Plus a **Last 24 Hours** stats bar (Total / OGs / Dragons / Small). Logs older than
24 hours disappear automatically.

> No friends list, followers, or join date are shown — just the item, username and join button.

---

## 1. Run it locally (test first)

You need [Node.js 18+](https://nodejs.org).

```bash
npm install
npm start
```

Open http://localhost:3000 — you'll see the empty dashboard.

Send a fake log to make sure it works (PowerShell):

```powershell
curl -Method POST http://localhost:3000/api/log -ContentType "application/json" -Body '{"owner":"TestUser","category":"og","animals":[{"name":"Strawberry Elephant","mutation":"Gold","generation":"$1.2M/s","tier":3}],"joinLink":"https://www.roblox.com/games/start?placeId=1&gameInstanceId=1"}'
```

A gold OG card should pop in instantly.

---

## 2. Host it online (so it works from any server)

The site needs to be **always online** to receive logs. Pick one (all have free tiers):

### Option A — Render.com (easiest, recommended)
1. Push this folder to a **GitHub** repo (or use Render's "Deploy from local").
2. Go to https://render.com -> **New** -> **Web Service**.
3. Connect the repo. Render auto-detects Node.
   - **Build command:** `npm install`
   - **Start command:** `npm start`
4. Under **Environment**, add:
   - `INGEST_TOKEN` = a long random password (e.g. `kw_9f3kд82hsmZ...`)
5. Deploy. You get a URL like `https://brainrot-logger.onrender.com`.

> Render's free tier sleeps after ~15 min idle and wakes on the next request (a few
> seconds). For an always-on feed, use a paid instance or Railway/Fly.

### Option B — Railway.app
1. https://railway.app -> **New Project** -> **Deploy from GitHub repo**.
2. Add variable `INGEST_TOKEN`.
3. Railway gives you a public domain under **Settings -> Networking**.

### Option C — Fly.io / a VPS
Any host that runs `node server.js` and exposes the `PORT` works. WebSockets are
supported out of the box (no extra config).

---

## 3. Connect your scanner

Open your scanner script (`nkgeeaeae.lua`) and set the two values near the top:

```lua
local LOG_API_URL   = "https://YOUR-APP.onrender.com/api/log"  -- your site URL + /api/log
local LOG_API_TOKEN = "the-same-INGEST_TOKEN-you-set"          -- must match the server
```

That's it. The scanner already posts to the site automatically whenever it logs a find
(in addition to Discord). Leave `LOG_API_URL` blank to disable the website feed.

---

## Environment variables

| Variable       | Default | Description                                                        |
| -------------- | ------- | ------------------------------------------------------------------ |
| `PORT`         | `3000`  | Port to listen on (most hosts set this for you).                   |
| `INGEST_TOKEN` | _(none)_| Shared secret. If set, posts must send header `x-ingest-token`.    |
| `MAX_LOGS`     | `1000`  | Max logs kept in memory (also pruned to the last 24h).             |

---

## How it works

- `server.js` — Express server. `POST /api/log` ingests a find, keeps the last 24h in
  memory, and pushes it to every connected browser over a WebSocket (`/ws`).
  `GET /api/logs` returns the current snapshot (used on first load + as a polling
  fallback if the socket drops).
- `public/` — the dashboard (vanilla HTML/CSS/JS, no build step).

### Log payload shape
```json
{
  "owner": "Username",
  "category": "og | dragon | small",
  "animals": [
    { "name": "Strawberry Elephant", "mutation": "Gold", "generation": "$1.2M/s", "tier": 3, "image": "https://..." }
  ],
  "image": "https://... (thumbnail, optional)",
  "joinLink": "https://www.roblox.com/games/start?placeId=...&gameInstanceId=...",
  "placeId": "78906538690694",
  "jobId": "server-job-id",
  "timestamp": 1730000000
}
```

> Data is stored **in memory** only, so a restart/redeploy clears the feed (the last
> 24h is what matters here). Ask if you want persistent storage (SQLite/Postgres).
