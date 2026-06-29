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
  
  // ─── single-log auth-protected JSON (5-min expiry) ───────────────────────────
  const LOG_VIEW_MS = 5 * 60 * 1000; // 5 minutes

  app.get("/api/log/:id", requireAuth, (req, res) => {
    const entry = logs.find(l => l.id === req.params.id);
    if (!entry) return res.status(404).json({ error: "log not found or expired" });
    if (Date.now() - entry.receivedAt > LOG_VIEW_MS)
      return res.status(410).json({ error: "This find has expired (5 min limit)." });
    res.json({ ok: true, entry });
  });

  // ─── single-log public highlight page ────────────────────────────────────────
  app.get("/log/:id", (req, res) => {
    const id = req.params.id;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Brainrot Find</title>
  <link rel="preconnect" href="https://fonts.googleapis.com"/>
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet"/>
  <style>
    :root {
      --bg: #07070c;
      --panel: rgba(20,20,32,0.85);
      --panel-solid: #13131f;
      --border: rgba(255,255,255,0.09);
      --border-strong: rgba(255,255,255,0.17);
      --text: #f2f3f8;
      --muted: #9aa0b4;
      --faint: #6a7088;
      --og: #ffb43c; --og-2: #ff7a00;
      --dragon: #ff4d4d; --dragon-2: #c01818;
      --small: #38d0ff; --small-2: #1f8fff;
      --radius: 20px;
    }
    *{box-sizing:border-box;margin:0;padding:0}
    html,body{
      min-height:100vh;
      background: radial-gradient(1100px 650px at 60% 0%, #16162a 0%, var(--bg) 60%) fixed var(--bg);
      color:var(--text);
      font-family:"Inter",system-ui,sans-serif;
      -webkit-font-smoothing:antialiased;
      display:flex; flex-direction:column; align-items:center; justify-content:center;
      padding:24px 16px;
    }

    /* orbs */
    .orbs{position:fixed;inset:0;overflow:hidden;pointer-events:none;z-index:0}
    .orb{position:absolute;border-radius:50%;filter:blur(90px)}
    .orb-1{width:420px;height:420px;opacity:.32;top:-100px;left:-60px}
    .orb-2{width:380px;height:380px;opacity:.18;bottom:-120px;right:-80px}

    .wrap{position:relative;z-index:1;width:100%;max-width:480px;display:flex;flex-direction:column;gap:20px}

    /* brand */
    .brand{display:flex;align-items:center;gap:12px}
    .brand-mark{
      width:42px;height:42px;border-radius:12px;
      background:linear-gradient(135deg,var(--og-2),var(--dragon-2));
      display:grid;place-items:center;
      font-weight:900;font-size:16px;color:#fff;
      box-shadow:0 6px 20px rgba(255,90,0,.3);
      flex-shrink:0;
    }
    .brand-title{font-size:18px;font-weight:800}
    .brand-sub{font-size:12px;color:var(--muted);margin-top:2px;font-weight:500}

    /* card */
    .card{
      background:var(--panel-solid);
      border:1px solid var(--border-strong);
      border-radius:var(--radius);
      overflow:hidden;
      box-shadow:0 24px 64px rgba(0,0,0,.55);
      position:relative;
    }
    .card-accent{height:4px;width:100%}
    .card-og     .card-accent{background:linear-gradient(90deg,var(--og),var(--og-2))}
    .card-dragon .card-accent{background:linear-gradient(90deg,var(--dragon),var(--dragon-2))}
    .card-small  .card-accent{background:linear-gradient(90deg,var(--small),var(--small-2))}

    .card-inner{display:flex;gap:18px;padding:20px;align-items:flex-start}

    .card-img{
      width:100px;height:100px;border-radius:14px;flex-shrink:0;
      background:#0c0c16;border:1px solid var(--border);
      overflow:hidden;display:grid;place-items:center;
    }
    .card-img img{width:100%;height:100%;object-fit:cover;display:block}
    .card-img.broken::after{content:"?";font-size:32px;font-weight:800;color:var(--faint)}
    .card-img.broken img{display:none}

    .card-info{flex:1;min-width:0;display:flex;flex-direction:column;gap:8px}

    .tier-badge{
      display:inline-flex;align-items:center;gap:5px;
      font-size:10px;font-weight:900;letter-spacing:.8px;
      padding:3px 9px;border-radius:6px;color:#0a0a0f;width:fit-content;
    }
    .card-og     .tier-badge{background:linear-gradient(135deg,var(--og),var(--og-2))}
    .card-dragon .tier-badge{background:linear-gradient(135deg,var(--dragon),var(--dragon-2));color:#fff}
    .card-small  .tier-badge{background:linear-gradient(135deg,var(--small),var(--small-2));color:#04121c}

    .animal-name{font-size:19px;font-weight:900;letter-spacing:-.3px;line-height:1.15}

    .badges{display:flex;flex-wrap:wrap;gap:5px}
    .badge{
      font-size:11px;font-weight:700;padding:3px 8px;border-radius:6px;
      border:1px solid var(--border-strong);color:var(--text);
    }
    .badge-mut       {color:#ffe7a8;border-color:rgba(255,180,60,.4);background:rgba(255,180,60,.08)}
    .badge-mut-normal{color:var(--faint)}
    .badge-gen       {color:#b8ffd0;border-color:rgba(46,227,122,.35);background:rgba(46,227,122,.08)}

    /* extra animals */
    .extra-animals{display:flex;flex-direction:column;gap:5px;padding:0 20px 16px}
    .extra-row{display:flex;align-items:center;gap:6px;font-size:12.5px;color:var(--muted);font-weight:600}
    .extra-row .badge{font-size:10.5px}

    /* divider */
    .divider{height:1px;background:var(--border);margin:0 20px}

    /* owner + actions */
    .card-footer{display:flex;align-items:center;justify-content:space-between;padding:16px 20px;gap:12px}
    .owner{display:flex;align-items:center;gap:10px;min-width:0}
    .owner-ava{
      width:34px;height:34px;border-radius:50%;flex-shrink:0;
      background:linear-gradient(135deg,#2a2a40,#3a3a5a);
      display:grid;place-items:center;font-size:12px;font-weight:800;color:#cfd2e0;overflow:hidden;
    }
    .owner-ava img{width:100%;height:100%;border-radius:50%;object-fit:cover;display:block}
    .owner-name{font-size:14px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .owner-label{font-size:11px;color:var(--faint);font-weight:500;margin-top:1px}

    .join-btn{
      text-decoration:none;font-size:14px;font-weight:800;
      padding:11px 22px;border-radius:12px;color:#04121c;white-space:nowrap;flex-shrink:0;
      background:linear-gradient(135deg,#4be08a,#1fbf6a);
      box-shadow:0 6px 18px rgba(31,191,106,.32);
      transition:transform .12s,filter .12s;display:flex;align-items:center;gap:7px;
    }
    .join-btn:hover{transform:translateY(-2px);filter:brightness(1.08)}
    .join-btn.disabled{background:#2a2a3a;color:var(--faint);box-shadow:none;pointer-events:none}
    .join-btn svg{flex-shrink:0}

    /* time */
    .card-time{
      text-align:center;padding:0 20px 14px;
      font-size:12px;color:var(--faint);font-weight:600;
    }

    /* states */
    .state{text-align:center;padding:32px 20px;color:var(--muted);font-size:15px;font-weight:600}
    .state.error{color:#ff8080}

    /* back link */
    .back{
      display:flex;align-items:center;gap:6px;
      font-size:13px;font-weight:600;color:var(--faint);
      text-decoration:none;transition:color .12s;
      align-self:flex-start;
    }
    .back:hover{color:var(--muted)}
  </style>
</head>
<body>
  <div class="wrap">
    <a class="back" href="/">
      <svg viewBox="0 0 20 20" fill="currentColor" width="14" height="14"><path fill-rule="evenodd" d="M9.707 16.707a1 1 0 01-1.414 0l-6-6a1 1 0 010-1.414l6-6a1 1 0 011.414 1.414L5.414 9H17a1 1 0 110 2H5.414l4.293 4.293a1 1 0 010 1.414z" clip-rule="evenodd"/></svg>
      Back to feed
    </a>

    <div class="brand">
      <div class="brand-mark">BR</div>
      <div>
        <div class="brand-title">Brainrot Logger</div>
        <div class="brand-sub">Live Plaza Find</div>
      </div>
    </div>

    <div id="root"><div class="state">Loading…</div></div>
  </div>

  <script>
    const LOG_ID = ${JSON.stringify(id)};

    function proxyImg(url) {
      if (!url) return null;
      return "/api/img-proxy?url=" + encodeURIComponent(url);
    }
    function timeAgo(ms) {
      const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
      if (s < 5)  return "just now";
      if (s < 60) return s + "s ago";
      const m = Math.floor(s / 60);
      if (m < 60) return m + "m ago";
      const h = Math.floor(m / 60);
      if (h < 24) return h + "h ago";
      return Math.floor(h / 24) + "d ago";
    }
    function isNormal(m) {
      if (!m) return true;
      const s = String(m).toLowerCase().replace(/\\s+/g,"");
      return s === "" || s === "none" || s === "normal" || s === "base";
    }
    function tierLabel(cat) {
      return cat === "og" ? "OG" : cat === "dragon" ? "DRAGON" : "SMALL";
    }

    function render(entry) {
      const animals  = Array.isArray(entry.animals) && entry.animals.length ? entry.animals : [{name:"?",mutation:"Normal"}];
      const primary  = animals[0];
      const catClass = "card-" + entry.category;
      const rawImg   = entry.image || primary.image;

      // orb colours
      const oc = entry.category === "og" ? ["#ff7a00","#ff4d00"] : entry.category === "dragon" ? ["#ff2d2d","#8b0000"] : ["#1f8fff","#004080"];
      document.querySelector(".orb-1").style.background = oc[0];
      document.querySelector(".orb-2").style.background = oc[1];
      document.title = primary.name + " — Brainrot Logger";

      const extraAnimals = animals.slice(1);
      const extraHtml = extraAnimals.length ? \`
        <div class="extra-animals">
          \${extraAnimals.map(a => \`
            <div class="extra-row">
              <span>\${esc(a.name)}</span>
              \${isNormal(a.mutation)
                ? \`<span class="badge badge-mut-normal">Normal</span>\`
                : \`<span class="badge badge-mut">\${esc(a.mutation)}</span>\`}
              \${a.generation ? \`<span class="badge badge-gen">\${esc(a.generation)}</span>\` : ""}
            </div>
          \`).join("")}
        </div>
        <div class="divider"></div>
      \` : "";

      const joinHref = entry.joinLink || null;
      const when     = entry.loggedAt || entry.receivedAt || Date.now();

      document.getElementById("root").innerHTML = \`
        <div class="card \${catClass}">
          <div class="card-accent"></div>
          <div class="card-inner">
            <div class="card-img" id="imgWrap">
              \${rawImg ? \`<img id="animalImg" src="\${proxyImg(rawImg)}" alt="\${esc(primary.name)}"/>\` : ""}
            </div>
            <div class="card-info">
              <span class="tier-badge">\${tierLabel(entry.category)}</span>
              <div class="animal-name">\${esc(animals.length > 1 ? primary.name + " +" + (animals.length-1) : primary.name)}</div>
              <div class="badges">
                \${isNormal(primary.mutation)
                  ? \`<span class="badge badge-mut-normal">Normal</span>\`
                  : \`<span class="badge badge-mut">\${esc(primary.mutation)}</span>\`}
                \${primary.generation ? \`<span class="badge badge-gen">\${esc(primary.generation)}</span>\` : ""}
              </div>
            </div>
          </div>
          \${extraHtml}
          <div class="divider"></div>
          <div class="card-footer">
            <div class="owner">
              <div class="owner-ava" id="ava">\${esc((entry.owner||"?").charAt(0).toUpperCase())}</div>
              <div>
                <div class="owner-name">\${esc(entry.owner || "?")}</div>
                <div class="owner-label">Owner</div>
              </div>
            </div>
            \${joinHref
              ? \`<a class="join-btn" href="\${esc(joinHref)}" target="_blank" rel="noopener">
                   <svg viewBox="0 0 20 20" fill="currentColor" width="15" height="15"><path d="M11 3a1 1 0 100 2h2.586l-6.293 6.293a1 1 0 101.414 1.414L15 6.414V9a1 1 0 102 0V4a1 1 0 00-1-1h-5z"/><path d="M5 5a2 2 0 00-2 2v8a2 2 0 002 2h8a2 2 0 002-2v-3a1 1 0 10-2 0v3H5V7h3a1 1 0 000-2H5z"/></svg>
                   Join Server
                 </a>\`
              : \`<span class="join-btn disabled">No Link</span>\`}
          </div>
          <div class="card-time" id="agoEl">\${timeAgo(when)}</div>
        </div>
      \`;

      // img error → broken
      if (rawImg) {
        const img = document.getElementById("animalImg");
        if (img) img.addEventListener("error", () => document.getElementById("imgWrap").classList.add("broken"), {once:true});
      } else {
        document.getElementById("imgWrap").classList.add("broken");
      }

      // owner avatar
      if (entry.ownerAvatar) {
        const avaEl = document.getElementById("ava");
        const ai = document.createElement("img");
        ai.src = proxyImg(entry.ownerAvatar);
        ai.alt = (entry.owner||"?").charAt(0).toUpperCase();
        ai.addEventListener("error", () => { ai.remove(); }, {once:true});
        avaEl.appendChild(ai);
      }

      // live timer
      const agoEl = document.getElementById("agoEl");
      setInterval(() => { agoEl.textContent = timeAgo(when); }, 1000);
    }

    function esc(s) {
      return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
    }

    // Auth check – redirect to login if no token stored
    const _token = localStorage.getItem("bl_token");
    if (!_token) {
      window.location.replace("/?next=" + encodeURIComponent(window.location.pathname));
    } else {
      fetch("/api/log/" + LOG_ID, {
        headers: { "Authorization": "Bearer " + _token }
      })
        .then(r => {
          if (r.status === 401 || r.status === 403) {
            window.location.replace("/?next=" + encodeURIComponent(window.location.pathname));
            throw new Error("unauth");
          }
          return r.json();
        })
        .then(d => {
          if (!d.ok) throw new Error(d.error || "not found");
          render(d.entry);
        })
        .catch(err => {
          if (err.message === "unauth") return;
          const isExpired = err.message && err.message.toLowerCase().includes("expired");
          document.getElementById("root").innerHTML = isExpired
            ? '<div class="state error">⏱ This find has expired — links are only valid for 5 minutes.</div>'
            : '<div class="state error">⚠ This log does not exist or has expired.</div>';
        });
    }
  </script>
  <div class="orbs" aria-hidden="true">
    <span class="orb orb-1"></span>
    <span class="orb orb-2"></span>
  </div>
</body>
</html>`);
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
