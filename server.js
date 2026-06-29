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
    console.warn("[auth] JWT_SECRET not set – using random secret (sessions reset on restart).");
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
  
  // ─── helpers ──────────────────────────────────────────────────────────────────
  function getClientIp(req) {
    return (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown")
      .split(",")[0].trim();
  }
  
  function maskHwid(hwid) {
    if (!hwid) return null;
    if (hwid.length <= 10) return hwid;
    return hwid.slice(0, 6) + "…" + hwid.slice(-4);
  }
  
  // ─── login rate limiter ───────────────────────────────────────────────────────
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
  
    // Owner bypasses DB lookup
    if (payload.role === "owner") {
      req.user = payload;
      return next();
    }
  
    // ── For all regular users: verify they still exist and are valid ──────────
    // This ensures deleted users are immediately locked out even with a live token.
    const users = loadUsers();
    const user  = users.find(u => u.id === payload.id);
  
    if (!user) {
      return res.status(401).json({ error: "account not found" });
    }
  
    // Check account expiry
    if (user.expiresAt && Date.now() > new Date(user.expiresAt).getTime()) {
      return res.status(401).json({ error: "account expired" });
    }
  
    // Use fresh role from DB so role changes take effect without re-login
    req.user = { ...payload, role: user.role || "viewer" };
    next();
  }
  
  function requireAdminOrOwner(req, res, next) {
    if (!req.user || (req.user.role !== "owner" && req.user.role !== "admin"))
      return res.status(403).json({ error: "admin access required" });
    next();
  }
  
  function requireOwner(req, res, next) {
    if (!req.user || req.user.role !== "owner")
      return res.status(403).json({ error: "owner access required" });
    next();
  }
  
  // Can the acting user modify the target user?
  function canModify(actorRole, targetRole) {
    if (actorRole === "owner") return true;
    if (actorRole === "admin" && targetRole === "viewer") return true;
    return false; // admin cannot touch other admins
  }
  
  // ─── auth routes ─────────────────────────────────────────────────────────────
  app.post("/api/auth/login", async (req, res) => {
    const ip = getClientIp(req);
  
    if (!checkRateLimit(ip)) {
      return res.status(429).json({ error: "Too many login attempts. Please wait 15 minutes." });
    }
  
    const { username, password, hwid } = req.body || {};
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
      await new Promise(r => setTimeout(r, 150 + Math.random() * 100));
      return res.status(401).json({ error: "invalid credentials" });
    }
  
    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return res.status(401).json({ error: "invalid credentials" });
  
    // ── Expiry check ─────────────────────────────────────────────────────────
    if (user.expiresAt && Date.now() > new Date(user.expiresAt).getTime()) {
      return res.status(403).json({ error: "Your account has expired. Contact an admin." });
    }
  
    // ── IP lock ───────────────────────────────────────────────────────────────
    if (user.lockedIp) {
      if (user.lockedIp !== ip) {
        return res.status(403).json({
          error: `Login blocked: IP address mismatch. This account is locked to a different IP.`,
        });
      }
    } else {
      // First login: lock to this IP
      user.lockedIp = ip;
    }
  
    // ── HWID / Device ID lock ─────────────────────────────────────────────────
    const clientHwid = hwid && typeof hwid === "string" ? hwid.slice(0, 128) : null;
    if (user.lockedHwid) {
      if (!clientHwid || user.lockedHwid !== clientHwid) {
        return res.status(403).json({
          error: "Login blocked: device not recognized. Contact an admin to reset your device lock.",
        });
      }
    } else if (clientHwid) {
      // First login with HWID: lock to this device
      user.lockedHwid = clientHwid;
    }
  
    // Persist any lock updates
    saveUsers(users);
  
    return res.json({
      token: signToken({ id: user.id, username: user.username, role: user.role || "viewer" }),
      user:  { id: user.id, username: user.username, role: user.role || "viewer" },
    });
  });
  
  app.get("/api/auth/me", requireAuth, (req, res) => {
    res.json({ user: { id: req.user.id, username: req.user.username, role: req.user.role } });
  });
  
  // ─── admin routes ─────────────────────────────────────────────────────────────
  
  // GET all users
  app.get("/api/admin/users", requireAuth, requireAdminOrOwner, (req, res) => {
    const users   = loadUsers();
    const isOwner = req.user.role === "owner";
  
    const list = users
      .filter(u => isOwner || u.role !== "admin") // admins cannot see other admins
      .map(u => ({
        id:           u.id,
        username:     u.username,
        role:         u.role || "viewer",
        createdAt:    u.createdAt,
        expiresAt:    u.expiresAt  || null,
        lockedIp:     u.lockedIp   || null,
        hwidMasked:   u.lockedHwid ? maskHwid(u.lockedHwid) : null,
        hasHwid:      !!u.lockedHwid,
        ogAccess:     !!u.ogAccess,
        dragonAccess: !!u.dragonAccess,
        smallAccess:  !!u.smallAccess,
      }));
  
    res.json({ users: list });
  });
  
  // PUT set access permissions
  app.put("/api/admin/users/:id/access", requireAuth, requireAdminOrOwner, (req, res) => {
    const { ogAccess, dragonAccess, smallAccess } = req.body || {};
    const users = loadUsers();
    const user  = users.find(u => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: "user not found" });

    if (!canModify(req.user.role, user.role))
      return res.status(403).json({ error: "you do not have permission to modify this account" });

    user.ogAccess     = !!ogAccess;
    user.dragonAccess = !!dragonAccess;
    user.smallAccess  = !!smallAccess;
    saveUsers(users);
    res.json({ ok: true, ogAccess: user.ogAccess, dragonAccess: user.dragonAccess, smallAccess: user.smallAccess });
  });

  // POST create user
  app.post("/api/admin/users", requireAuth, requireAdminOrOwner, async (req, res) => {
    const { username, password, role, expiresAt, ogAccess, dragonAccess, smallAccess } = req.body || {};
  
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
  
    // Only owner can create admin accounts
    const targetRole = (role === "admin" && req.user.role === "owner") ? "admin" : "viewer";
  
    // Validate expiresAt
    let expiry = null;
    if (expiresAt) {
      const d = new Date(expiresAt);
      if (isNaN(d.getTime())) return res.status(400).json({ error: "invalid expiresAt date" });
      expiry = d.toISOString();
    }
  
    const users = loadUsers();
    if (users.find(u => u.username.toLowerCase() === uname.toLowerCase()))
      return res.status(409).json({ error: "username already exists" });
  
    const passwordHash = await bcrypt.hash(password, 12);
    const newUser = {
      id:           Date.now().toString(36) + crypto.randomBytes(3).toString("hex"),
      username:     uname,
      passwordHash,
      role:         targetRole,
      createdAt:    new Date().toISOString(),
      expiresAt:    expiry,
      lockedIp:     null,
      lockedHwid:   null,
      ogAccess:     !!ogAccess,
      dragonAccess: !!dragonAccess,
      smallAccess:  !!smallAccess,
    };
    users.push(newUser);
    saveUsers(users);
  
    return res.status(201).json({
      ok:   true,
      user: {
        id:        newUser.id,
        username:  newUser.username,
        role:      newUser.role,
        createdAt: newUser.createdAt,
        expiresAt: newUser.expiresAt,
      },
    });
  });
  
  // DELETE user
  app.delete("/api/admin/users/:id", requireAuth, requireAdminOrOwner, (req, res) => {
    const users = loadUsers();
    const idx   = users.findIndex(u => u.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: "user not found" });
  
    const target = users[idx];
    if (!canModify(req.user.role, target.role))
      return res.status(403).json({ error: "you do not have permission to delete this account" });
  
    users.splice(idx, 1);
    saveUsers(users);
    res.json({ ok: true });
  });
  
  // PUT reset password
  app.put("/api/admin/users/:id/password", requireAuth, requireAdminOrOwner, async (req, res) => {
    const { password } = req.body || {};
    if (!password || typeof password !== "string" || password.length < 8)
      return res.status(400).json({ error: "new password must be at least 8 characters" });
  
    const users = loadUsers();
    const user  = users.find(u => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: "user not found" });
  
    if (!canModify(req.user.role, user.role))
      return res.status(403).json({ error: "you do not have permission to modify this account" });
  
    user.passwordHash = await bcrypt.hash(password, 12);
    saveUsers(users);
    res.json({ ok: true });
  });
  
  // PUT set/clear expiry
  app.put("/api/admin/users/:id/expiry", requireAuth, requireAdminOrOwner, (req, res) => {
    const { expiresAt } = req.body;
    const users = loadUsers();
    const user  = users.find(u => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: "user not found" });
  
    if (!canModify(req.user.role, user.role))
      return res.status(403).json({ error: "you do not have permission to modify this account" });
  
    if (expiresAt === null || expiresAt === "" || expiresAt === undefined) {
      user.expiresAt = null;
    } else {
      const d = new Date(expiresAt);
      if (isNaN(d.getTime())) return res.status(400).json({ error: "invalid date" });
      user.expiresAt = d.toISOString();
    }
  
    saveUsers(users);
    res.json({ ok: true, expiresAt: user.expiresAt });
  });
  
  // PUT change role (owner only)
  app.put("/api/admin/users/:id/role", requireAuth, requireOwner, (req, res) => {
    const { role } = req.body || {};
    if (!["admin", "viewer"].includes(role))
      return res.status(400).json({ error: "role must be 'admin' or 'viewer'" });
  
    const users = loadUsers();
    const user  = users.find(u => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: "user not found" });
  
    user.role = role;
    saveUsers(users);
    res.json({ ok: true, role: user.role });
  });
  
  // POST reset IP lock
  app.post("/api/admin/users/:id/reset-ip", requireAuth, requireAdminOrOwner, (req, res) => {
    const users = loadUsers();
    const user  = users.find(u => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: "user not found" });
  
    if (!canModify(req.user.role, user.role))
      return res.status(403).json({ error: "you do not have permission to modify this account" });
  
    user.lockedIp = null;
    saveUsers(users);
    res.json({ ok: true });
  });
  
  // POST reset HWID lock
  app.post("/api/admin/users/:id/reset-hwid", requireAuth, requireAdminOrOwner, (req, res) => {
    const users = loadUsers();
    const user  = users.find(u => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: "user not found" });
  
    if (!canModify(req.user.role, user.role))
      return res.status(403).json({ error: "you do not have permission to modify this account" });
  
    user.lockedHwid = null;
    saveUsers(users);
    res.json({ ok: true });
  });
  
  // ─── static files ────────────────────────────────────────────────────────────
  app.use(express.static(path.join(__dirname, "public")));
  
  // ─── logs (auth-protected) ────────────────────────────────────────────────────
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
  
  function userCanSeeCategory(user, category) {
    if (!user) return false;
    if (user.role === "owner" || user.role === "admin") return true;
    // Check DB for access flags
    const users = loadUsers();
    const dbUser = users.find(u => u.id === user.id);
    if (!dbUser) return false;
    if (category === "og")     return !!dbUser.ogAccess;
    if (category === "dragon") return !!dbUser.dragonAccess;
    if (category === "small")  return !!dbUser.smallAccess;
    return false;
  }

  function filterLogsForUser(logList, user) {
    if (!user) return [];
    if (user.role === "owner" || user.role === "admin") return logList;
    const users = loadUsers();
    const dbUser = users.find(u => u.id === user.id);
    if (!dbUser) return [];
    return logList.filter(l => {
      if (l.category === "og")     return !!dbUser.ogAccess;
      if (l.category === "dragon") return !!dbUser.dragonAccess;
      if (l.category === "small")  return !!dbUser.smallAccess;
      return false;
    });
  }

  app.get("/api/logs", requireAuth, (req, res) => {
    prune();
    const filtered = filterLogsForUser(logs, req.user);
    const stats = { total: filtered.length, og: 0, dragon: 0, small: 0 };
    for (const l of filtered) {
      if      (l.category === "og")     stats.og++;
      else if (l.category === "dragon") stats.dragon++;
      else                              stats.small++;
    }
    res.json({ logs: filtered, stats });
  });
  
  app.get("/api/health", (req, res) => res.json({ ok: true, uptime: process.uptime() }));
  
  // ─── image proxy (public) ─────────────────────────────────────────────────────
  app.get("/api/img-proxy", (req, res) => {
    const rawUrl = req.query.url;
    if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) {
      return res.status(400).json({ error: "missing or invalid ?url=" });
    }

    // Per-target headers. Fandom (stealabr.fandom.com / static.wikia.nocookie.net)
    // doesn't want a Roblox referer — a plain browser-like request works best.
    // Roblox CDN hosts (rbxcdn.com / roblox.com) are fine with a Roblox referer.
    function headersFor(targetUrl) {
      let host = "";
      try { host = new URL(targetUrl).hostname.toLowerCase(); } catch (_) {}

      const base = {
        "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept":          "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        // Explicitly do NOT request br/gzip — we pipe the raw body straight to the
        // browser with a Content-Type header, so a compressed body would render broken.
        "Accept-Encoding": "identity",
      };

      if (host.endsWith("roblox.com") || host.endsWith("rbxcdn.com")) {
        base.Referer = "https://www.roblox.com/";
      } else if (host.endsWith("fandom.com") || host.endsWith("wikia.nocookie.net")) {
        base.Referer = "https://stealabr.fandom.com/";
      }
      return base;
    }

    function fetchUrl(targetUrl, redirectCount) {
      if (redirectCount > 8) {
        return res.status(502).json({ error: "too many redirects", url: targetUrl });
      }

      let mod;
      try { mod = /^https:/i.test(targetUrl) ? https : http; }
      catch (_) { return res.status(400).json({ error: "bad url" }); }

      const request = mod.get(targetUrl, { timeout: 8000, headers: headersFor(targetUrl) }, upstream => {
        // Follow redirects, including relative paths with query strings.
        if (upstream.statusCode >= 300 && upstream.statusCode < 400 && upstream.headers.location) {
          upstream.resume();
          let next = upstream.headers.location;
          try { next = new URL(next, targetUrl).toString(); }
          catch (_) { return res.status(502).json({ error: "bad redirect target", location: next }); }
          return fetchUrl(next, redirectCount + 1);
        }

        if (upstream.statusCode < 200 || upstream.statusCode >= 300) {
          upstream.resume();
          return res.status(502).json({
            error:      "upstream returned an error",
            upstream:   upstream.statusCode,
            triedUrl:   targetUrl,
          });
        }

        const contentType = upstream.headers["content-type"] || "image/png";
        // Guard against upstream ignoring Accept-Encoding: identity and sending a
        // compressed body anyway — fail loudly instead of piping garbage as "image/png".
        const enc = (upstream.headers["content-encoding"] || "").toLowerCase();
        if (enc && enc !== "identity") {
          upstream.resume();
          return res.status(502).json({ error: "unexpected content-encoding from upstream", encoding: enc });
        }
        if (!/^image\//i.test(contentType)) {
          upstream.resume();
          return res.status(502).json({ error: "upstream did not return an image", contentType, triedUrl: targetUrl });
        }

        res.setHeader("Content-Type",  contentType);
        res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=3600");
        upstream.pipe(res);
      });

      request.on("error", (err) => {
        if (!res.headersSent) res.status(502).json({ error: "fetch failed", message: err.message, triedUrl: targetUrl });
      });
      request.on("timeout", () => {
        request.destroy();
        if (!res.headersSent) res.status(504).json({ error: "upstream timed out", triedUrl: targetUrl });
      });
    }

    fetchUrl(rawUrl, 0);
  });
  
  // ─── ingest route (INGEST_TOKEN protected) ────────────────────────────────────
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
  
    const ts       = Number(b.timestamp);
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
    broadcastLog(entry);
    res.json({ ok: true, id: entry.id });
  });
  
  // ─── WebSocket ────────────────────────────────────────────────────────────────
  const server = http.createServer(app);
  const wss    = new WebSocketServer({ server, path: "/ws" });
  
  function computeStatsForLogs(logList) {
    const stats = { total: logList.length, og: 0, dragon: 0, small: 0 };
    for (const l of logList) {
      if      (l.category === "og")     stats.og++;
      else if (l.category === "dragon") stats.dragon++;
      else                              stats.small++;
    }
    return stats;
  }

  // Broadcast a new log entry to each connected client filtered by their access
  function broadcastLog(entry) {
    for (const client of wss.clients) {
      if (client.readyState !== 1) continue;
      try {
        const wsUser = client._wsUser;
        if (!wsUser) continue;
        const filtered = filterLogsForUser([entry], wsUser);
        if (!filtered.length) continue;
        // Recompute stats for this client from their visible full log set
        const visibleLogs = filterLogsForUser(logs, wsUser);
        client.send(JSON.stringify({ type: "log", entry, stats: computeStatsForLogs(visibleLogs) }));
      } catch (_) {}
    }
  }

  function broadcastStats() {
    for (const client of wss.clients) {
      if (client.readyState !== 1) continue;
      try {
        const wsUser = client._wsUser;
        if (!wsUser) continue;
        const visibleLogs = filterLogsForUser(logs, wsUser);
        client.send(JSON.stringify({ type: "stats", stats: computeStatsForLogs(visibleLogs) }));
      } catch (_) {}
    }
  }

  wss.on("connection", (ws, req) => {
    let wsUser = null;
    try {
      const url   = new URL(req.url, "http://localhost");
      const token = url.searchParams.get("token");
      if (!token) { ws.close(1008, "unauthorized"); return; }

      const payload = verifyToken(token);
      if (!payload) { ws.close(1008, "unauthorized"); return; }

      // For non-owner, verify still exists
      if (payload.role !== "owner") {
        const users = loadUsers();
        const user  = users.find(u => u.id === payload.id);
        if (!user) { ws.close(1008, "unauthorized"); return; }
        if (user.expiresAt && Date.now() > new Date(user.expiresAt).getTime()) {
          ws.close(1008, "unauthorized"); return;
        }
      }
      wsUser = payload;
    } catch (_) {
      ws.close(1008, "unauthorized"); return;
    }

    ws._wsUser = wsUser;
    prune();
    const filtered = filterLogsForUser(logs, wsUser);
    try { ws.send(JSON.stringify({ type: "init", logs: filtered, stats: computeStatsForLogs(filtered) })); } catch (_) {}
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
  
  // Periodic stats refresh
  setInterval(() => {
    prune();
    broadcastStats();
  }, 60 * 1000);
  
  // ─── start ────────────────────────────────────────────────────────────────────
  server.listen(PORT, () => {
    console.log(`Brainrot Logger listening on http://localhost:${PORT}`);
    console.log(`Owner username: ${OWNER_USERNAME}`);
    if (!INGEST_TOKEN) console.warn("[warn] INGEST_TOKEN is not set – anyone can post logs.");
  });
