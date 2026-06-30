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
  const DATA_DIR   = process.env.DATA_DIR || path.join(__dirname, "data");
  const USERS_FILE = path.join(DATA_DIR, "users.json");
  const KEYS_FILE  = path.join(DATA_DIR, "keys.json");
  const LOGS_FILE  = path.join(DATA_DIR, "logs.json");
  
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

  // ─── key store ───────────────────────────────────────────────────────────────
  function loadKeys() {
    try {
      ensureDataDir();
      if (!fs.existsSync(KEYS_FILE)) return [];
      return JSON.parse(fs.readFileSync(KEYS_FILE, "utf8"));
    } catch (_) { return []; }
  }

  function saveKeys(keys) {
    try {
      ensureDataDir();
      fs.writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2), "utf8");
    } catch (e) { console.error("[keys] Failed to save keys:", e.message); }
  }

  function generateKey() {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const seg = () => Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
    return `AURA-${seg()}-${seg()}-${seg()}`;
  }

  // Parse duration strings like "1h", "30m", "2d", "1h30m", "90" (minutes).
  // Returns milliseconds, or null if unparseable.
  function parseDuration(str) {
    if (!str) return null;
    const s = String(str).trim().toLowerCase();
    const re = /(\d+)\s*([dhm])/gi;
    let ms = 0;
    let matched = false;
    let m;
    while ((m = re.exec(s)) !== null) {
      const n = parseInt(m[1], 10);
      const u = m[2].toLowerCase();
      if      (u === "d") ms += n * 24 * 60 * 60 * 1000;
      else if (u === "h") ms += n * 60 * 60 * 1000;
      else if (u === "m") ms += n * 60 * 1000;
      matched = true;
    }
    if (!matched) {
      const n = parseInt(s, 10);
      if (!isNaN(n) && n > 0) return n * 60 * 1000; // bare number = minutes
      return null;
    }
    return ms > 0 ? ms : null;
  }

  // ─── log persistence ─────────────────────────────────────────────────────────
  function loadLogsFromDisk() {
    try {
      ensureDataDir();
      if (!fs.existsSync(LOGS_FILE)) return [];
      const raw    = JSON.parse(fs.readFileSync(LOGS_FILE, "utf8"));
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      return raw.filter(l => l.receivedAt >= cutoff);
    } catch (_) { return []; }
  }

  let _saveLogsTimer = null;
  function scheduleSaveLogs() {
    if (_saveLogsTimer) return;
    _saveLogsTimer = setTimeout(() => {
      _saveLogsTimer = null;
      try {
        ensureDataDir();
        fs.writeFileSync(LOGS_FILE, JSON.stringify(logs, null, 2), "utf8");
      } catch (e) { console.error("[logs] Failed to save logs:", e.message); }
    }, 3000); // coalesces rapid writes into one disk write
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

  // POST /api/auth/redeem  { key }
  // Validates a generated key and immediately logs the user in as a new viewer.
  app.post("/api/auth/redeem", async (req, res) => {
    const { key } = req.body || {};
    if (!key || typeof key !== "string")
      return res.status(400).json({ error: "key is required" });

    const keyStr = key.trim().toUpperCase();
    const keys   = loadKeys();
    const idx    = keys.findIndex(k => k.key === keyStr);

    if (idx === -1)
      return res.status(400).json({ error: "Invalid key. Double-check and try again." });

    const entry = keys[idx];

    // Expiry check
    if (entry.expiresAt && Date.now() > new Date(entry.expiresAt).getTime()) {
      keys.splice(idx, 1);
      saveKeys(keys);
      return res.status(400).json({ error: "This key has expired." });
    }

    // Uses check
    if (entry.usesLeft <= 0) {
      keys.splice(idx, 1);
      saveKeys(keys);
      return res.status(400).json({ error: "This key has already been fully redeemed." });
    }

    // Consume one use
    entry.usesLeft--;
    if (entry.usesLeft <= 0) keys.splice(idx, 1);
    saveKeys(keys);

    // Create a viewer account for this redemption
    const suffix       = crypto.randomBytes(4).toString("hex");
    const username     = "user_" + suffix;
    const passwordHash = await bcrypt.hash(crypto.randomBytes(16).toString("hex"), 12);

    // Determine access flags based on key plan
    const plan = entry.plan || "all";
    const newUser = {
      id:           Date.now().toString(36) + crypto.randomBytes(3).toString("hex"),
      username,
      passwordHash,
      role:         "viewer",
      createdAt:    new Date().toISOString(),
      expiresAt:    entry.expiresAt || null,
      lockedIp:     null,
      lockedHwid:   null,
      ogAccess:     plan === "all" || plan === "og",
      dragonAccess: plan === "all" || plan === "dragon",
      smallAccess:  plan === "all" || plan === "small",
    };

    const users = loadUsers();
    users.push(newUser);
    saveUsers(users);

    return res.json({
      token: signToken({ id: newUser.id, username: newUser.username, role: "viewer" }),
      user:  { id: newUser.id, username: newUser.username, role: "viewer" },
    });
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
  
  // ─── Discord role routes ─────────────────────────────────────────────────────

  // In-memory code store: discordUserId -> { code, expiresAt, siteUserId }
  const discordCodes = new Map();

  const DISCORD_ROLES = {
    og:     "1520490482856230912",
    dragon: "1520304817669406730",
    small:  "1520304912884563968",
  };

  function discordApiRequest(method, path, body, cb) {
    const token = process.env.DISCORD_BOT_TOKEN;
    if (!token) return cb(new Error("DISCORD_BOT_TOKEN not set"));
    const bodyStr = body ? JSON.stringify(body) : null;
    const options = {
      hostname: "discord.com",
      path:     "/api/v10" + path,
      method,
      headers: {
        "Authorization": "Bot " + token,
        "Content-Type":  "application/json",
        "User-Agent":    "BrainrotLogger/1.0",
        ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {}),
      },
    };
    const req = https.request(options, apiRes => {
      let data = "";
      apiRes.on("data", c => { data += c; });
      apiRes.on("end", () => {
        let parsed = {};
        try { parsed = JSON.parse(data); } catch (_) {}
        // Always log non-2xx Discord responses so you can see exactly what's wrong
        if (apiRes.statusCode < 200 || apiRes.statusCode >= 300) {
          console.error(`[discord] REST ${method} ${path} → HTTP ${apiRes.statusCode}`, parsed);
        }
        cb(null, apiRes.statusCode, parsed);
      });
    });
    req.on("error", e => { console.error(`[discord] REST ${method} ${path} error:`, e.message); cb(e); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  }

  // POST /api/discord/send-code  { discordId }
  // Opens a DM with the user and sends a 6-digit code
  app.post("/api/discord/send-code", requireAuth, (req, res) => {
    const { discordId } = req.body || {};
    if (!discordId || !/^\d{17,20}$/.test(String(discordId).trim())) {
      return res.status(400).json({ error: "Invalid Discord User ID. It should be 17–20 digits." });
    }
    const id = String(discordId).trim();

    // Step 1: create DM channel
    discordApiRequest("POST", "/users/@me/channels", { recipient_id: id }, (err, status, data) => {
      if (err) {
        return res.status(502).json({ error: "Network error contacting Discord. Check your server logs." });
      }
      if (status === 401) {
        return res.status(502).json({ error: "Bot token is invalid or expired. The server owner needs to reset DISCORD_BOT_TOKEN in the .env file." });
      }
      if (status === 400) {
        return res.status(400).json({ error: `Invalid Discord ID or Discord rejected the request: ${data.message || JSON.stringify(data)}` });
      }
      if (status < 200 || status >= 300) {
        return res.status(502).json({ error: `Discord returned an error (HTTP ${status}): ${data.message || JSON.stringify(data)}` });
      }
      const channelId = data.id;
      if (!channelId) return res.status(502).json({ error: "Discord did not return a DM channel." });

      // Step 2: generate code
      const code      = String(Math.floor(100000 + Math.random() * 900000));
      const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

      discordCodes.set(id, { code, expiresAt, siteUserId: req.user.id });

      // Step 3: send DM
      const msg = `🔐 **Brainrot Logger Role Verification**\n\nYour verification code is: **${code}**\n\nEnter this on the site to claim your Discord roles. This code expires in 10 minutes.`;
      discordApiRequest("POST", `/channels/${channelId}/messages`, { content: msg }, (err2, status2, data2) => {
        if (err2 || status2 < 200 || status2 >= 300) {
          discordCodes.delete(id);
          const reason = data2 && data2.message ? data2.message : (err2 ? err2.message : `HTTP ${status2}`);
          return res.status(502).json({ error: `Could not send the DM (${reason}). Make sure your DMs are open from server members.` });
        }
        res.json({ ok: true, message: "Code sent! Check your Discord DMs." });
      });
    });
  });

  // POST /api/discord/verify-code  { discordId, code }
  // Verifies code and assigns roles based on the site user's access flags
  app.post("/api/discord/verify-code", requireAuth, (req, res) => {
    const { discordId, code } = req.body || {};
    if (!discordId || !code) return res.status(400).json({ error: "discordId and code are required" });

    const id    = String(discordId).trim();
    const entry = discordCodes.get(id);

    if (!entry)                          return res.status(400).json({ error: "No pending code for this Discord ID. Request a new one." });
    if (Date.now() > entry.expiresAt)  { discordCodes.delete(id); return res.status(400).json({ error: "Code expired. Request a new one." }); }
    if (entry.siteUserId !== req.user.id) return res.status(403).json({ error: "This code was requested by a different account." });
    if (entry.code !== String(code).trim()) return res.status(400).json({ error: "Incorrect code. Try again." });

    discordCodes.delete(id);

    const guildId = process.env.DISCORD_GUILD_ID || "1517995483719536801";
    if (!guildId) return res.status(503).json({ error: "Discord Guild ID not configured on the server." });

    // Determine which roles this user gets
    const users  = loadUsers();
    const dbUser = req.user.role === "owner" ? null : users.find(u => u.id === req.user.id);
    const isPriv = req.user.role === "owner" || req.user.role === "admin";

    const rolesToAdd = [];
    if (isPriv || (dbUser && dbUser.ogAccess))     rolesToAdd.push({ name: "OG",     id: DISCORD_ROLES.og });
    if (isPriv || (dbUser && dbUser.dragonAccess)) rolesToAdd.push({ name: "Dragon", id: DISCORD_ROLES.dragon });
    if (isPriv || (dbUser && dbUser.smallAccess))  rolesToAdd.push({ name: "Small",  id: DISCORD_ROLES.small });

    if (rolesToAdd.length === 0) {
      return res.status(400).json({ error: "Your account has no access permissions to assign roles for." });
    }

    // First ensure the member is in the guild
    discordApiRequest("PUT", `/guilds/${guildId}/members/${id}`, {
      access_token: undefined,
    }, () => {
      // Assign each role (PUT /guilds/{guildId}/members/{userId}/roles/{roleId})
      let done = 0;
      const assigned = [];
      const failed   = [];

      function assignNext(i) {
        if (i >= rolesToAdd.length) {
          if (assigned.length === 0) {
            return res.status(502).json({ error: "Failed to assign any roles. Make sure the bot has Manage Roles permission and is in the server." });
          }
          return res.json({
            ok: true,
            assigned: assigned.map(r => r.name),
            failed:   failed.map(r => r.name),
          });
        }
        const role = rolesToAdd[i];
        discordApiRequest("PUT", `/guilds/${guildId}/members/${id}/roles/${role.id}`, {}, (err, status) => {
          if (!err && status >= 200 && status < 300) assigned.push(role);
          else failed.push(role);
          assignNext(i + 1);
        });
      }
      assignNext(0);
    });
  });

  // Clean up expired codes every 15 minutes
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of discordCodes) if (now > v.expiresAt) discordCodes.delete(k);
  }, 15 * 60 * 1000);

  // ─── static files ────────────────────────────────────────────────────────────
  app.use(express.static(path.join(__dirname, "public")));
  
  // ─── logs (auth-protected) ────────────────────────────────────────────────────
  /** @type {Array<object>} newest first */
  let logs = loadLogsFromDisk();
  
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

  // Cache resolved Fandom page-image URLs so we don't hit their API on every request.
  const fandomImageCache = new Map(); // pageTitle -> { url, expiresAt }
  const FANDOM_CACHE_MS = 6 * 60 * 60 * 1000; // 6h

  // Extract the wiki page title from a Special:FilePath-style guess URL, e.g.
  // https://stealabr.fandom.com/wiki/Special:FilePath/Garama_and_Madundung.png
  // -> "Garama and Madundung"
  function fandomTitleFromGuessUrl(targetUrl) {
    try {
      const u = new URL(targetUrl);
      if (!/fandom\.com$/i.test(u.hostname)) return null;
      const m = u.pathname.match(/\/wiki\/Special:FilePath\/(.+)$/i);
      if (!m) return null;
      let file = decodeURIComponent(m[1]);
      file = file.replace(/\.(png|jpg|jpeg|webp|gif)$/i, "");
      return file.replace(/_/g, " ");
    } catch (_) { return null; }
  }

  // Ask the wiki's MediaWiki API for the actual current main image of a page.
  // Tries both the short db-name domain and the full vanity domain, since either
  // may be the canonical one depending on how the wiki is configured.
  function resolveFandomPageImage(pageTitle, cb) {
    const cached = fandomImageCache.get(pageTitle);
    if (cached && cached.expiresAt > Date.now()) return cb(cached.url);

    const hosts = ["stealabrainrot.fandom.com", "stealabr.fandom.com"];

    function tryHost(i) {
      if (i >= hosts.length) return cb(null);
      const apiUrl = `https://${hosts[i]}/api.php?action=query&titles=${encodeURIComponent(pageTitle)}&prop=pageimages&piprop=original&format=json`;
      const request = https.get(apiUrl, {
        timeout: 6000,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "Accept": "application/json",
        },
      }, upstream => {
        let body = "";
        upstream.on("data", chunk => { body += chunk; if (body.length > 1e6) upstream.destroy(); });
        upstream.on("end", () => {
          try {
            const data  = JSON.parse(body);
            const pages = data && data.query && data.query.pages;
            const page  = pages && Object.values(pages)[0];
            const url   = page && page.original && page.original.source;
            if (url) {
              fandomImageCache.set(pageTitle, { url, expiresAt: Date.now() + FANDOM_CACHE_MS });
              return cb(url);
            }
          } catch (_) {}
          tryHost(i + 1);
        });
      });
      request.on("error",   () => tryHost(i + 1));
      request.on("timeout", () => { request.destroy(); tryHost(i + 1); });
    }

    tryHost(0);
  }

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
        base.Referer = "https://stealabrainrot.fandom.com/";
      }
      return base;
    }

    function sendNotFound(extra) {
      // Last resort: try resolving the real filename via the Fandom API before giving up.
      const title = fandomTitleFromGuessUrl(rawUrl);
      if (title && !req._fandomFallbackTried) {
        req._fandomFallbackTried = true;
        return resolveFandomPageImage(title, (resolvedUrl) => {
          if (resolvedUrl && resolvedUrl !== rawUrl) {
            return fetchUrl(resolvedUrl, 0);
          }
          res.status(502).json({ error: "image not found, fandom lookup also failed", ...extra });
        });
      }
      res.status(502).json(extra);
    }

    function fetchUrl(targetUrl, redirectCount) {
      if (redirectCount > 8) {
        return sendNotFound({ error: "too many redirects", url: targetUrl });
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
          catch (_) { return sendNotFound({ error: "bad redirect target", location: next }); }
          return fetchUrl(next, redirectCount + 1);
        }

        if (upstream.statusCode < 200 || upstream.statusCode >= 300) {
          upstream.resume();
          return sendNotFound({
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
          return sendNotFound({ error: "unexpected content-encoding from upstream", encoding: enc });
        }
        if (!/^image\//i.test(contentType)) {
          upstream.resume();
          return sendNotFound({ error: "upstream did not return an image", contentType, triedUrl: targetUrl });
        }

        res.setHeader("Content-Type",  contentType);
        res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=3600");
        upstream.pipe(res);
      });

      request.on("error", (err) => {
        if (!res.headersSent) sendNotFound({ error: "fetch failed", message: err.message, triedUrl: targetUrl });
      });
      request.on("timeout", () => {
        request.destroy();
        if (!res.headersSent) sendNotFound({ error: "upstream timed out", triedUrl: targetUrl });
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
    scheduleSaveLogs();
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
  
  // ─── Discord Gateway (bot presence / online status) ─────────────────────────
  // The REST-only approach above sends DMs fine, but the bot never appears
  // "Online" in the server because it hasn't opened a Gateway (WebSocket)
  // connection.  This block opens a minimal Gateway session so the bot shows
  // as Online and can send/receive messages.
  (function startDiscordGateway() {
    const botToken = process.env.DISCORD_BOT_TOKEN;
    if (!botToken) {
      console.warn("[discord] DISCORD_BOT_TOKEN not set – bot will stay offline.");
      return;
    }

    // Only this Discord user ID may use /genkey
    const GENKEY_OWNER_ID = "1345871452447969332";

    const { WebSocket: GWS } = require("ws");
    let gws              = null;
    let hbInterval       = null;
    let seq              = null;
    let sessionId        = null;
    let resumeUrl        = null;
    let appId            = null;  // filled from READY event
    let commandRegistered = false;

    function send(op, d) {
      if (gws && gws.readyState === 1) gws.send(JSON.stringify({ op, d }));
    }

    function identify() {
      send(2, {
        token:   botToken,
        intents: 0, // no privileged intents needed for presence + DMs
        properties: { os: "linux", browser: "brainrot-logger", device: "brainrot-logger" },
      });
    }

    // Register the /genkey slash command for the configured guild.
    // Always re-registers on READY so option changes apply on restart.
    function registerCommand(applicationId) {
      const guildId = process.env.DISCORD_GUILD_ID;
      if (!guildId) { console.warn("[discord] DISCORD_GUILD_ID not set – cannot register /genkey."); return; }

      const cmdDef = {
        name:        "genkey",
        description: "Generate a site redemption key",
        options: [
          {
            name:        "duration",
            description: "How long the key is valid (e.g. 1h, 30m, 2d)",
            type:        3,
            required:    true,
          },
          {
            name:        "plan",
            description: "Which logs the redeemed account can access",
            type:        3,
            required:    true,
            choices: [
              { name: "All (OG + Dragon + Small)", value: "all"    },
              { name: "OG only",                   value: "og"     },
              { name: "Dragon only",               value: "dragon" },
              { name: "Small only",                value: "small"  },
            ],
          },
          {
            name:        "uses",
            description: "How many times the key can be redeemed (default 1)",
            type:        4,
            required:    false,
            min_value:   1,
            max_value:   100,
          },
        ],
      };

      discordApiRequest("POST", `/applications/${applicationId}/guilds/${guildId}/commands`, cmdDef, (err, status) => {
        if (err || status >= 400) {
          console.error("[discord] Failed to register /genkey command:", err && err.message, status);
        } else {
          console.log("[discord] /genkey command registered/updated.");
        }
      });
    }

    // Respond to an interaction via REST.
    function interactionReply(interactionId, interactionToken, content, ephemeral) {
      discordApiRequest(
        "POST",
        `/interactions/${interactionId}/${interactionToken}/callback`,
        { type: 4, data: { content, flags: ephemeral ? 64 : 0 } },
        () => {}
      );
    }

    // Handle /genkey interaction.
    function handleGenkeyInteraction(d) {
      const userId = d.member && d.member.user ? d.member.user.id : (d.user && d.user.id);
      if (userId !== GENKEY_OWNER_ID) {
        return interactionReply(d.id, d.token, "❌ You are not authorised to use this command.", true);
      }

      const opts        = (d.data && d.data.options) || [];
      const durationOpt = opts.find(o => o.name === "duration");
      const planOpt     = opts.find(o => o.name === "plan");
      const usesOpt     = opts.find(o => o.name === "uses");

      const durationStr = durationOpt ? String(durationOpt.value) : null;
      const plan        = planOpt     ? String(planOpt.value)      : "all";
      const usesCount   = usesOpt     ? Math.max(1, parseInt(usesOpt.value, 10) || 1) : 1;

      const durationMs = parseDuration(durationStr);
      if (!durationMs) {
        return interactionReply(d.id, d.token, "❌ Invalid duration. Use formats like `1h`, `30m`, `2d`, `1h30m`.", true);
      }

      const key       = generateKey();
      const expiresAt = new Date(Date.now() + durationMs).toISOString();

      const keys = loadKeys();
      keys.push({ key, expiresAt, usesLeft: usesCount, usesTotal: usesCount, plan, createdAt: new Date().toISOString() });
      saveKeys(keys);

      const expDate   = new Date(expiresAt);
      const expStr    = expDate.toUTCString();
      const planLabel = plan === "all" ? "All (OG + Dragon + Small)" : plan === "og" ? "OG only" : plan === "dragon" ? "Dragon only" : "Small only";

      const msg = [
        `🔑 **Key generated!**`,
        `\`${key}\``,
        `⏱ Expires: ${expStr}`,
        `🔢 Uses: ${usesCount}`,
        `📋 Plan: ${planLabel}`,
        ``,
        `Share this key — whoever redeems it on the site gets instant access.`,
      ].join("\n");

      interactionReply(d.id, d.token, msg, true);
    }

    function connect(url) {
      const target = url || "wss://gateway.discord.gg/?v=10&encoding=json";
      try { gws = new GWS(target); }
      catch (e) { console.error("[discord] Could not create Gateway WS:", e.message); scheduleReconnect(); return; }

      gws.on("open", () => console.log("[discord] Gateway connected."));

      gws.on("message", raw => {
        let msg;
        try { msg = JSON.parse(raw); } catch (_) { return; }
        const { op, d, s, t } = msg;
        if (s != null) seq = s;

        switch (op) {
          case 10: // Hello – start heartbeating then identify / resume
            if (hbInterval) clearInterval(hbInterval);
            hbInterval = setInterval(() => send(1, seq), d.heartbeat_interval);
            if (sessionId && resumeUrl) {
              send(6, { token: botToken, session_id: sessionId, seq });
            } else {
              identify();
            }
            break;

          case 0: // Dispatch
            if (t === "READY") {
              sessionId = d.session_id;
              resumeUrl = d.resume_gateway_url;
              appId     = d.application && d.application.id;
              console.log("[discord] Bot online as", d.user && d.user.username + "#" + d.user.discriminator);
              if (appId) registerCommand(appId);
            }

            if (t === "INTERACTION_CREATE") {
              const cmdName = d.data && d.data.name;
              if (cmdName === "genkey") handleGenkeyInteraction(d);
            }
            break;

          case 1:  // Server-requested heartbeat
            send(1, seq);
            break;

          case 7:  // Reconnect
            gws.close(1000, "reconnect requested");
            break;

          case 9:  // Invalid session
            console.warn("[discord] Invalid session – re-identifying in 3 s…");
            sessionId = null; resumeUrl = null; seq = null;
            setTimeout(identify, 3000 + Math.random() * 2000);
            break;

          case 11: // Heartbeat ACK – all good
            break;
        }
      });

      gws.on("close", code => {
        if (hbInterval) { clearInterval(hbInterval); hbInterval = null; }
        if (code === 4004) { console.error("[discord] Invalid bot token – not reconnecting."); return; }
        if (code === 4014) { console.error("[discord] Disallowed intents – not reconnecting."); return; }
        console.log(`[discord] Gateway closed (${code}). Reconnecting in 5 s…`);
        scheduleReconnect(code === 4000 ? null : resumeUrl); // non-recoverable close → fresh connect
      });

      gws.on("error", err => console.error("[discord] Gateway error:", err.message));
    }

    let reconnTimer = null;
    function scheduleReconnect(url) {
      if (reconnTimer) return;
      reconnTimer = setTimeout(() => { reconnTimer = null; connect(url); }, 5000);
    }

    connect();
  })();

  // ─── start ────────────────────────────────────────────────────────────────────
  server.listen(PORT, () => {
    console.log(`Brainrot Logger listening on http://localhost:${PORT}`);
    console.log(`Owner username: ${OWNER_USERNAME}`);
    if (!INGEST_TOKEN) console.warn("[warn] INGEST_TOKEN is not set – anyone can post logs.");
  });
