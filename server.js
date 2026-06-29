"use strict";

const path = require("path");
const http = require("http");
const fs = require("fs");
const express = require("express");
const { WebSocketServer } = require("ws");

// ----- tiny .env loader (no dependency) -----
(function loadEnv() {
  try {
    const envPath = path.join(__dirname, ".env");
    if (!fs.existsSync(envPath)) return;
    for (const raw of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      const val = line.slice(eq + 1).trim();
      if (key && process.env[key] === undefined) process.env[key] = val;
    }
  } catch (_) {}
})();

const PORT = Number(process.env.PORT) || 8080;
const INGEST_TOKEN = process.env.INGEST_TOKEN || "TUFFFF31425FW1E2";
const MAX_LOGS = Number(process.env.MAX_LOGS) || 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const app = express();
app.use(express.json({ limit: "256kb" }));
app.disable("x-powered-by");

/** @type {Array<object>} newest first */
let logs = [];

function prune() {
  const cutoff = Date.now() - DAY_MS;
  logs = logs.filter((l) => l.receivedAt >= cutoff);
  if (logs.length > MAX_LOGS) logs.length = MAX_LOGS;
}

function computeStats() {
  prune();
  const stats = { total: logs.length, og: 0, dragon: 0, small: 0 };
  for (const l of logs) {
    if (l.category === "og") stats.og++;
    else if (l.category === "dragon") stats.dragon++;
    else stats.small++;
  }
  return stats;
}

function clampStr(v, n, fallback) {
  if (v === undefined || v === null) return fallback !== undefined ? fallback : null;
  return String(v).slice(0, n);
}

function normalizeAnimals(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, 40).map((a) => ({
    name: clampStr(a && a.name, 80, "?"),
    mutation: clampStr(a && a.mutation, 40, "Normal") || "Normal",
    generation: a && a.generation ? clampStr(a.generation, 32) : null,
    tier: Number(a && a.tier) || 1,
    image: a && a.image ? clampStr(a.image, 500) : null,
  }));
}

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/logs", (req, res) => {
  prune();
  res.json({ logs, stats: computeStats() });
});

app.get("/api/health", (req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.post("/api/log", (req, res) => {
  if (INGEST_TOKEN) {
    const tok = req.get("x-ingest-token") || req.query.token;
    if (tok !== INGEST_TOKEN) return res.status(401).json({ error: "invalid token" });
  }

  const b = req.body || {};
  const category = ["og", "dragon", "small"].includes(b.category) ? b.category : "small";
  const animals = normalizeAnimals(b.animals);
  if (!animals.length) return res.status(400).json({ error: "no animals" });

  const ts = Number(b.timestamp);
  const loggedAt = ts ? (ts > 1e12 ? ts : ts * 1000) : Date.now();

  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    owner: clampStr(b.owner, 60, "?") || "?",
    category,
    animals,
    image: b.image ? clampStr(b.image, 500) : animals[0].image,
    joinLink: b.joinLink ? clampStr(b.joinLink, 500) : null,
    placeId: clampStr(b.placeId, 32),
    jobId: clampStr(b.jobId, 80),
    loggedAt,
    receivedAt: Date.now(),
  };

  logs.unshift(entry);
  prune();
  broadcast({ type: "log", entry, stats: computeStats() });
  res.json({ ok: true, id: entry.id });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      try { client.send(data); } catch (_) {}
    }
  }
}

wss.on("connection", (ws) => {
  prune();
  try {
    ws.send(JSON.stringify({ type: "init", logs, stats: computeStats() }));
  } catch (_) {}
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });
});

// keep-alive ping + periodic stats refresh (keeps "24h" counts honest as logs expire)
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch (_) {}
  });
}, 30 * 1000);

setInterval(() => {
  prune();
  broadcast({ type: "stats", stats: computeStats() });
}, 60 * 1000);

server.listen(PORT, () => {
  console.log(`Brainrot Logger listening on http://localhost:${PORT}`);
  if (!INGEST_TOKEN) console.log("WARNING: INGEST_TOKEN is not set - anyone can post logs.");
});
