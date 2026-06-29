"use strict";
  
  const path    = require("path");
  const http    = require("http");
  const https   = require("https");
  const fs      = require("fs");
  const crypto  = require("crypto");
  const express = require("express");
  const { WebSocketServer } = require("ws");
  const bcrypt  = require("bcryptjs");
  const jwt     = require("jsonwebtoken");
  
  // ─── .env loader ─────────────────────────────────────────────────────────────
  (function loadEnv() {
    try {
      const p = path.join(__dirname, ".env");
      if (!fs.existsSync(p)) return;
      for (const raw of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
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
  
  // ─── config ──────────────────────────────────────────────────────────────────
  const PORT           = Number(process.env.PORT)     || 8080;
  const INGEST_TOKEN   = process.env.INGEST_TOKEN     || "TUFFFF31425FW1E2";
  const MAX_LOGS       = Number(process.env.MAX_LOGS) || 1000;
  const DAY_MS         = 24 * 60 * 60 * 1000;
  
  const OWNER_USERNAME = (process.env.OWNER_USERNAME || "owner").trim();
  const OWNER_PASSWORD =  process.env.OWNER_PASSWORD || "changeme123";
  
  const JWT_SECRET = process.env.JWT_SECRET || (() => {
    console.warn("[auth] JWT_SECRET not set – using random secret (sessions will reset on restart).");
    return crypto.randomBytes(48).toString("hex");
  })();
  
  if (OWNER_PASSWORD === "changeme123") {
    console.warn("[auth] WARNING: OWNER_PASSWORD is set to the default. Change it in your .env!");
  }
  
  // ─── user store ──────────────────────────────────────────────────────────────
  const DATA_DIR   = path.join(__dirname, "data");
  const USERS_FILE = path.join(DATA_DIR, "users.json");
  
  function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  
  function loadUsers() {
    try {
      ensureDataDir();
      if (!fs.existsSync(USERS_FILE)) return [];
      return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
    } catch (_) { return []; }
  }
  
  function saveUsers(users) {
    try {
      ensureDataDir();
      fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), "utf8");
    } catch (e) { console.error("[auth] Failed to save users:", e.message); }
  }
  
  // ─── login rate limiter ───────────────────────────────────────────────────────
  // 10 attempts per IP per 15-minute window
  const loginAttempts = new Map();
  
  function checkRateLimit(ip) {
    const now = Date.now();
    const e   = loginAttempts.get(ip);
    if (!e || now > e.resetAt) {
      loginAttempts.set(ip, { count: 1, resetAt: now + 15 * 60 * 1000 });
      return true;
    }
    if (e.count >= 10) return false;
    e.count++;
    return true;
  }
  
  setInterval(() => {
    const now = Date.now();
    for (const [ip, e] of loginAttempts) if (now > e.resetAt) loginAttempts.delete(ip);
  }, 60 * 60 * 1000);
  
  // ─── express app ─────────────────────────────────────────────────────────────
  const app = express();
  app.use(express.json({ limit: "256kb" }));
  app.disable("x-powered-by");
  
  // ─── auth helpers ────────────────────────────────────────────────────────────
  function signToken(payload) {
    return jwt.sign(payload, JWT_SECRET, { expiresIn: "24h" });
  }
  
  function verifyToken(token) {
    try { return jwt.verify(token, JWT_SECRET); }
    catch (_) { return null; }
  }
  
  function extractToken(req) {
    const h = req.get("authorization");
    if (h && h.startsWith("Bearer ")) return h.slice(7);
    return req.query.token || null;
  }
  
  // ─── middleware ───────────────────────────────────────────────────────────────
  function requireAuth(req, res, next) {
    const token = extractToken(req);
    if (!token) return res.status(401).json({ error: "unauthorized" });
    const payload = verifyToken(token);
    if (!payload) return res.status(401).json({ error: "invalid or expired token" });
    req.user = payload;
    next();
  }
  
  function requireOwner(req, res, next) {
    if (!req.user || req.user.role !== "owner")
      return res.status(403).json({ error: "owner access required" });
    next();
  }
  
  // ─── auth routes ─────────────────────────────────────────────────────────────
  app.post("/api/auth/login", async (req, res) => {
    const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
  
    if (!checkRateLimit(ip)) {
      return res.status(429).json({ error: "Too many login attempts. Please wait 15 minutes." });
    }
  
    const { username, password } = req.body || {};
    if (!username || !password || typeof username !== "string" || typeof password !== "string") {
      return res.status(400).json({ error: "username and password are required" });
    }
  
    const uname = username.trim();
  
    // Owner check (plaintext compare from env)
    if (uname.toLowerCase() === OWNER_USERNAME.toLowerCase()) {
      if (password !== OWNER_PASSWORD) {
        return res.status(401).json({ error: "invalid credentials" });
      }
      return res.json({
        token: signToken({ id: "owner", username: OWNER_USERNAME, role: "owner" }),
        user:  { id: "owner", username: OWNER_USERNAME, role: "owner" },
      });
    }
  
    // Regular user check (bcrypt)
    const users = loadUsers();
    const user  = users.find(u => u.username.toLowerCase() === uname.toLowerCase());
  
    if (!user) {
      // Fixed delay to prevent user-enumeration via timing
      await new Promise(r => setTimeout(r, 150 + Math.random() * 100));
      return res.status(401).json({ error: "invalid credentials" });
    }
  
    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return res.status(401).json({ error: "invalid credentials" });
  
    return res.json({
      token: signToken({ id: user.id, username: user.username, role: user.role || "viewer" }),
      user:  { id: user.id, username: user.username, role: user.role || "viewer" },
    });
  });
  
  app.get("/api/auth/me", requireAuth, (req, res) => {
    res.json({ user: { id: req.user.id, username: req.user.username, role: req.user.role } });
  });
  
  // ─── admin routes (owner only) ───────────────────────────────────────────────
  app.get("/api/admin/users", requireAuth, requireOwner, (req, res) => {
    const users = loadUsers();
    res.json({
      users: users.map(u => ({
        id:        u.id,
        username:  u.username,
        role:      u.role,
        createdAt: u.createdAt,
      })),
    });
  });
  
  app.post("/api/admin/users", requireAuth, requireOwner, async (req, res) => {
    const { username, password } = req.body || {};
  
    if (!username || !password || typeof username !== "string" || typeof password !== "string")
      return res.status(400).json({ error: "username and password are required" });
  
    const uname = username.trim();
  
    if (uname.length < 3 || uname.length > 32)
      return res.status(400).json({ error: "username must be 3–32 characters" });
  
    if (!/^[a-zA-Z0-9_.\-]+$/.test(uname))
      return res.status(400).json({ error: "username may only contain letters, numbers, _ . -" });
  
    if (password.length < 8)
      return res.status(400).json({ error: "password must be at least 8 characters" });
  
    if (uname.toLowerCase() === OWNER_USERNAME.toLowerCase())
      return res.status(409).json({ error: "that username is reserved" });
  
    const users = loadUsers();
    if (users.find(u => u.username.toLowerCase() === uname.toLowerCase()))
      return res.status(409).json({ error: "username already exists" });
  
    const passwordHash = await bcrypt.hash(password, 12);
    const newUser = {
      id:           Date.now().toString(36) + crypto.randomBytes(3).toString("hex"),
      username:     uname,
      passwordHash,
      role:         "viewer",
      createdAt:    new Date().toISOString(),
    };
    users.push(newUser);
    saveUsers(users);
  
    return res.status(201).json({
      ok:   true,
      user: { id: newUser.id, username: newUser.username, role: newUser.role, createdAt: newUser.createdAt },
    });
  });
  
  app.delete("/api/admin/users/:id", requireAuth, requireOwner, (req, res) => {
    const users = loadUsers();
    const idx   = users.findIndex(u => u.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: "user not found" });
    users.splice(idx, 1);
    saveUsers(users);
    res.json({ ok: true });
  });
  
  app.put("/api/admin/users/:id/password", requireAuth, requireOwner, async (req, res) => {
    const { password } = req.body || {};
    if (!password || typeof password !== "string" || password.length < 8)
      return res.status(400).json({ error: "new password must be at least 8 characters" });
  
    const users = loadUsers();
    const user  = users.find(u => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: "user not found" });
  
    user.passwordHash = await bcrypt.hash(password, 12);
    saveUsers(users);
    res.json({ ok: true });
  });
  
  // ─── static files ────────────────────────────────────────────────────────────
  app.use(express.static(path.join(__dirname, "public")));
  
  // ─── logs (auth-protected) ───────────────────────────────────────────────────
  /** @type {Array<object>} newest first */
  let logs = [];
  
  function prune() {
    const cutoff = Date.now() - DAY_MS;
    logs = logs.filter(l => l.receivedAt >= cutoff);
    if (logs.length > MAX_LOGS) logs.length = MAX_LOGS;
  }
  
  function computeStats() {
    prune();
    const stats = { total: logs.length, og: 0, dragon: 0, small: 0 };
    for (const l of logs) {
      if      (l.category === "og")     stats.og++;
      else if (l.category === "dragon") stats.dragon++;
      else                              stats.small++;
    }
    return stats;
  }
  
  app.get("/api/logs", requireAuth, (req, res) => {
    prune();
    res.json({ logs, stats: computeStats() });
  });
  
  app.get("/api/health", (req, res) => res.json({ ok: true, uptime: process.uptime() }));
  
  // ─── image proxy (public – only proxies already-public CDN images) ────────────
  app.get("/api/img-proxy", (req, res) => {
    const rawUrl = req.query.url;
    if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) return res.status(400).end();
  
    const PROXY_HEADERS = {
      "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept":          "image/webp,image/apng,image/*,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Referer":         "https://www.roblox.com/",
    };
  
    function fetchUrl(targetUrl, redirectCount) {
      if (redirectCount > 8) return res.status(502).end();
      const mod     = /^https:/i.test(targetUrl) ? https : http;
      const request = mod.get(targetUrl, { timeout: 8000, headers: PROXY_HEADERS }, upstream => {
        if (upstream.statusCode >= 300 && upstream.statusCode < 400 && upstream.headers.location) {
          upstream.resume();
          let next = upstream.headers.location;
          if (next.startsWith("/")) { const p = new URL(targetUrl); next = p.origin + next; }
          return fetchUrl(next, redirectCount + 1);
        }
        if (upstream.statusCode < 200 || upstream.statusCode >= 300) {
          upstream.resume(); return res.status(502).end();
        }
        res.setHeader("Content-Type",  upstream.headers["content-type"] || "image/png");
        res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=3600");
        upstream.pipe(res);
      });
      request.on("error",   () => { if (!res.headersSent) res.status(502).end(); });
      request.on("timeout", () => { request.destroy(); if (!res.headersSent) res.status(504).end(); });
    }
    fetchUrl(rawUrl, 0);
  });
  
  // ─── ingest route (INGEST_TOKEN protected, no JWT required) ──────────────────
  function clampStr(v, n, fallback) {
    if (v === undefined || v === null) return fallback !== undefined ? fallback : null;
    return String(v).slice(0, n);
  }
  
  function normalizeAnimals(arr) {
    if (!Array.isArray(arr)) return [];
    return arr.slice(0, 40).map(a => ({
      name:       clampStr(a && a.name, 80, "?"),
      mutation:   clampStr(a && a.mutation, 40, "Normal") || "Normal",
      generation: a && a.generation ? clampStr(a.generation, 32) : null,
      tier:       Number(a && a.tier) || 1,
      image:      a && a.image ? clampStr(a.image, 500) : null,
    }));
  }
  
  app.post("/api/log", (req, res) => {
    if (INGEST_TOKEN) {
      const tok = req.get("x-ingest-token") || req.query.token;
      if (tok !== INGEST_TOKEN) return res.status(401).json({ error: "invalid token" });
    }
  
    const b        = req.body || {};
    const category = ["og", "dragon", "small"].includes(b.category) ? b.category : "small";
    const animals  = normalizeAnimals(b.animals);
    if (!animals.length) return res.status(400).json({ error: "no animals" });
  
    const ts      = Number(b.timestamp);
    const loggedAt = ts ? (ts > 1e12 ? ts : ts * 1000) : Date.now();
  
    const entry = {
      id:          Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      owner:       clampStr(b.owner, 60, "?") || "?",
      ownerAvatar: b.ownerAvatar ? clampStr(b.ownerAvatar, 500) : null,
      ownerId:     b.ownerId     ? clampStr(b.ownerId, 32)      : null,
      category,
      animals,
      image:       b.image    ? clampStr(b.image, 500)    : animals[0].image,
      joinLink:    b.joinLink ? clampStr(b.joinLink, 500) : null,
      placeId:     clampStr(b.placeId, 32),
      jobId:       clampStr(b.jobId,   80),
      loggedAt,
      receivedAt:  Date.now(),
    };
  
    logs.unshift(entry);
    prune();
    broadcast({ type: "log", entry, stats: computeStats() });
    res.json({ ok: true, id: entry.id });
  });
  
  // ─── WebSocket ────────────────────────────────────────────────────────────────
  const server = http.createServer(app);
  const wss    = new WebSocketServer({ server, path: "/ws" });
  
  function broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const client of wss.clients) {
      if (client.readyState === 1) { try { client.send(data); } catch (_) {} }
    }
  }
  
  wss.on("connection", (ws, req) => {
    // Authenticate via token query param
    try {
      const url   = new URL(req.url, "http://localhost");
      const token = url.searchParams.get("token");
      if (!token || !verifyToken(token)) {
        ws.close(1008, "unauthorized");
        return;
      }
    } catch (_) {
      ws.close(1008, "unauthorized");
      return;
    }
  
    prune();
    try { ws.send(JSON.stringify({ type: "init", logs, stats: computeStats() })); } catch (_) {}
    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });
  });
  
  // Keep-alive ping
  setInterval(() => {
    wss.clients.forEach(ws => {
      if (ws.isAlive === false) return ws.terminate();
      ws.isAlive = false;
      try { ws.ping(); } catch (_) {}
    });
  }, 30 * 1000);
  
  // Periodic stats refresh (keeps 24h counts honest as logs expire)
  setInterval(() => {
    prune();
    broadcast({ type: "stats", stats: computeStats() });
  }, 60 * 1000);
  
  // ─── start ────────────────────────────────────────────────────────────────────
  server.listen(PORT, () => {
    console.log(`Brainrot Logger listening on http://localhost:${PORT}`);
    console.log(`Owner username: ${OWNER_USERNAME}`);
    if (!INGEST_TOKEN) console.warn("[warn] INGEST_TOKEN is not set – anyone can post logs.");
  });
