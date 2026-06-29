"use strict";
  
  // ═══════════════════════════════════════════════════════════════════════════════
  // AUTH STATE
  // ═══════════════════════════════════════════════════════════════════════════════
  let authToken   = localStorage.getItem("bl_token");
  let currentUser = null;
  
  function saveToken(token) {
    authToken = token;
    localStorage.setItem("bl_token", token);
  }
  
  function clearToken() {
    authToken = null;
    currentUser = null;
    localStorage.removeItem("bl_token");
  }
  
  async function apiFetch(url, opts = {}) {
    const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
    if (authToken) headers["Authorization"] = "Bearer " + authToken;
    const res = await fetch(url, { ...opts, headers });
    if (res.status === 401) { showLoginOverlay(); throw new Error("unauthorized"); }
    return res;
  }
  
  // ═══════════════════════════════════════════════════════════════════════════════
  // BOOT — check session then show the right screen
  // ═══════════════════════════════════════════════════════════════════════════════
  (async function boot() {
    if (!authToken) { showLoginOverlay(); return; }
    try {
      const res  = await fetch("/api/auth/me", {
        headers: { "Authorization": "Bearer " + authToken }
      });
      if (!res.ok) throw new Error("invalid");
      const data = await res.json();
      currentUser = data.user;
      showApp();
    } catch (_) {
      clearToken();
      showLoginOverlay();
    }
  })();
  
  // ═══════════════════════════════════════════════════════════════════════════════
  // LOGIN OVERLAY
  // ═══════════════════════════════════════════════════════════════════════════════
  const loginOverlay = document.getElementById("loginOverlay");
  const appContent   = document.getElementById("appContent");
  const loginForm    = document.getElementById("loginForm");
  const loginError   = document.getElementById("loginError");
  const loginBtn     = document.getElementById("loginBtn");
  const loginBtnText = document.getElementById("loginBtnText");
  const loginSpinner = document.getElementById("loginSpinner");
  const pwToggle     = document.getElementById("pwToggle");
  const pwInput      = document.getElementById("loginPassword");
  
  function showLoginOverlay() {
    loginOverlay.removeAttribute("hidden");
    appContent.setAttribute("hidden", "");
    document.getElementById("loginUsername").focus();
    stopApp();
  }
  
  function showApp() {
    loginOverlay.setAttribute("hidden", "");
    appContent.removeAttribute("hidden");
  
    // Populate user badge
    const uname = currentUser.username;
    document.getElementById("userNameEl").textContent  = uname;
    document.getElementById("userAvatar").textContent  = uname.charAt(0).toUpperCase();
    const roleBadge = document.getElementById("userRoleBadge");
    roleBadge.textContent = currentUser.role === "owner" ? "owner" : "viewer";
    roleBadge.classList.toggle("role-owner", currentUser.role === "owner");
  
    if (currentUser.role === "owner") {
      document.getElementById("adminBtn").removeAttribute("hidden");
    }
  
    startApp();
  }
  
  // Show/hide password toggle
  pwToggle.addEventListener("click", () => {
    const show    = pwInput.type === "password";
    pwInput.type  = show ? "text" : "password";
    pwToggle.style.opacity = show ? "1" : "0.5";
  });
  
  loginForm.addEventListener("submit", async e => {
    e.preventDefault();
    loginError.hidden = true;
  
    const username = document.getElementById("loginUsername").value.trim();
    const password = pwInput.value;
    if (!username || !password) { showLoginErr("Enter your username and password."); return; }
  
    loginBtn.disabled   = true;
    loginBtnText.hidden = true;
    loginSpinner.removeAttribute("hidden");
  
    try {
      const res  = await fetch("/api/auth/login", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ username, password }),
      });
      const data = await res.json();
  
      if (!res.ok) { showLoginErr(data.error || "Login failed."); return; }
  
      saveToken(data.token);
      currentUser = data.user;
      showApp();
    } catch (_) {
      showLoginErr("Network error. Please try again.");
    } finally {
      loginBtn.disabled   = false;
      loginBtnText.hidden = false;
      loginSpinner.setAttribute("hidden", "");
    }
  });
  
  function showLoginErr(msg) {
    loginError.textContent = msg;
    loginError.hidden = false;
  }
  
  // Logout
  document.getElementById("logoutBtn").addEventListener("click", () => {
    clearToken();
    showLoginOverlay();
    // Reset UI
    document.getElementById("userNameEl").textContent = "";
    document.getElementById("userAvatar").textContent = "?";
    document.getElementById("adminBtn").setAttribute("hidden", "");
    document.getElementById("userRoleBadge").textContent = "";
    document.getElementById("loginUsername").value = "";
    pwInput.value = "";
    loginError.hidden = true;
  });
  
  // ═══════════════════════════════════════════════════════════════════════════════
  // ADMIN PANEL
  // ═══════════════════════════════════════════════════════════════════════════════
  const adminOverlay    = document.getElementById("adminOverlay");
  const adminClose      = document.getElementById("adminClose");
  const createUserForm  = document.getElementById("createUserForm");
  const createUserError = document.getElementById("createUserError");
  const createUserOk    = document.getElementById("createUserSuccess");
  const refreshUsersBtn = document.getElementById("refreshUsers");
  const userListEl      = document.getElementById("userList");
  
  // Reset password nested modal
  const resetPwOverlay  = document.getElementById("resetPwOverlay");
  const resetPwLabel    = document.getElementById("resetPwLabel");
  const resetPwInput    = document.getElementById("resetPwInput");
  const resetPwError    = document.getElementById("resetPwError");
  const resetPwConfirm  = document.getElementById("resetPwConfirm");
  const resetPwCancel   = document.getElementById("resetPwCancel");
  let   resetPwUserId   = null;
  
  document.getElementById("adminBtn").addEventListener("click", () => {
    adminOverlay.removeAttribute("hidden");
    fetchUsers();
  });
  
  adminClose.addEventListener("click", () => adminOverlay.setAttribute("hidden", ""));
  adminOverlay.addEventListener("click", e => { if (e.target === adminOverlay) adminOverlay.setAttribute("hidden", ""); });
  
  refreshUsersBtn.addEventListener("click", fetchUsers);
  
  createUserForm.addEventListener("submit", async e => {
    e.preventDefault();
    createUserError.hidden = true;
    createUserOk.hidden    = true;
  
    const username = document.getElementById("newUsername").value.trim();
    const password = document.getElementById("newPassword").value;
  
    if (!username || !password) {
      showAdminErr("Username and password are required.");
      return;
    }
  
    try {
      const res  = await apiFetch("/api/admin/users", {
        method: "POST",
        body:   JSON.stringify({ username, password }),
      });
      const data = await res.json();
  
      if (!res.ok) { showAdminErr(data.error || "Failed to create user."); return; }
  
      createUserOk.textContent = `✓ Login created: ${data.user.username}`;
      createUserOk.hidden = false;
      document.getElementById("newUsername").value = "";
      document.getElementById("newPassword").value = "";
      fetchUsers();
    } catch (err) {
      if (err.message !== "unauthorized") showAdminErr("Network error.");
    }
  });
  
  function showAdminErr(msg) {
    createUserError.textContent = msg;
    createUserError.hidden = false;
  }
  
  async function fetchUsers() {
    userListEl.innerHTML = '<div class="user-list-empty">Loading…</div>';
    try {
      const res  = await apiFetch("/api/admin/users");
      const data = await res.json();
      if (!res.ok) { userListEl.innerHTML = `<div class="user-list-empty">Error: ${data.error}</div>`; return; }
      renderUsers(data.users);
    } catch (err) {
      if (err.message !== "unauthorized")
        userListEl.innerHTML = '<div class="user-list-empty">Failed to load users.</div>';
    }
  }
  
  function renderUsers(users) {
    if (!users.length) {
      userListEl.innerHTML = '<div class="user-list-empty">No viewer accounts yet.</div>';
      return;
    }
  
    userListEl.innerHTML = "";
    for (const u of users) {
      const row = document.createElement("div");
      row.className = "user-row";
      row.dataset.id = u.id;
  
      const created = u.createdAt
        ? new Date(u.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
        : "—";
  
      row.innerHTML = `
        <div class="user-info">
          <span class="user-row-avatar">${u.username.charAt(0).toUpperCase()}</span>
          <div>
            <div class="user-row-name">${escHtml(u.username)}</div>
            <div class="user-row-meta">viewer &middot; created ${created}</div>
          </div>
        </div>
        <div class="user-row-actions">
          <button class="btn-ghost btn-sm" data-action="reset" data-id="${u.id}" data-name="${escHtml(u.username)}">Reset PW</button>
          <button class="btn-danger btn-sm" data-action="delete" data-id="${u.id}" data-name="${escHtml(u.username)}">Delete</button>
        </div>
      `;
      userListEl.appendChild(row);
    }
  
    userListEl.querySelectorAll("[data-action='delete']").forEach(btn => {
      btn.addEventListener("click", () => deleteUser(btn.dataset.id, btn.dataset.name));
    });
    userListEl.querySelectorAll("[data-action='reset']").forEach(btn => {
      btn.addEventListener("click", () => openResetPw(btn.dataset.id, btn.dataset.name));
    });
  }
  
  async function deleteUser(id, name) {
    if (!confirm(`Delete login for "${name}"? This cannot be undone.`)) return;
    try {
      const res = await apiFetch(`/api/admin/users/${id}`, { method: "DELETE" });
      if (!res.ok) { const d = await res.json(); alert(d.error || "Failed to delete."); return; }
      fetchUsers();
    } catch (err) {
      if (err.message !== "unauthorized") alert("Network error.");
    }
  }
  
  function openResetPw(id, name) {
    resetPwUserId          = id;
    resetPwLabel.textContent = `Set a new password for "${name}".`;
    resetPwInput.value     = "";
    resetPwError.hidden    = true;
    resetPwOverlay.removeAttribute("hidden");
    resetPwInput.focus();
  }
  
  resetPwCancel.addEventListener("click", () => resetPwOverlay.setAttribute("hidden", ""));
  
  resetPwConfirm.addEventListener("click", async () => {
    resetPwError.hidden = true;
    const pw = resetPwInput.value;
    if (!pw || pw.length < 8) {
      resetPwError.textContent = "Password must be at least 8 characters.";
      resetPwError.hidden = false;
      return;
    }
    try {
      const res  = await apiFetch(`/api/admin/users/${resetPwUserId}/password`, {
        method: "PUT",
        body:   JSON.stringify({ password: pw }),
      });
      const data = await res.json();
      if (!res.ok) {
        resetPwError.textContent = data.error || "Failed to reset password.";
        resetPwError.hidden = false;
        return;
      }
      resetPwOverlay.setAttribute("hidden", "");
      resetPwUserId = null;
    } catch (err) {
      if (err.message !== "unauthorized") {
        resetPwError.textContent = "Network error.";
        resetPwError.hidden = false;
      }
    }
  });
  
  function escHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  
  // ═══════════════════════════════════════════════════════════════════════════════
  // MAIN APP (log feed)  — same as original but with auth headers + WS token
  // ═══════════════════════════════════════════════════════════════════════════════
  const DAY_MS      = 24 * 60 * 60 * 1000;
  const MAX_PER_FEED = 80;
  
  const feeds = {
    og:     { list: document.getElementById("listOg"),     empty: document.getElementById("emptyOg"),     count: document.getElementById("countOg") },
    dragon: { list: document.getElementById("listDragon"), empty: document.getElementById("emptyDragon"), count: document.getElementById("countDragon") },
    small:  { list: document.getElementById("listSmall"),  empty: document.getElementById("emptySmall"),  count: document.getElementById("countSmall") },
  };
  const statEls = {
    total:  document.getElementById("statTotal"),
    og:     document.getElementById("statOg"),
    dragon: document.getElementById("statDragon"),
    small:  document.getElementById("statSmall"),
  };
  const connEl   = document.getElementById("conn");
  const connText = document.getElementById("connText");
  const cardTpl  = document.getElementById("cardTpl");
  
  /** id -> { entry, el, agoEl } */
  const items = new Map();
  
  let ws             = null;
  let reconnectTimer = null;
  let pollTimer      = null;
  let timerTick      = null;
  let appRunning     = false;
  
  function feedOf(cat) { return feeds[cat] || feeds.small; }
  function tierLabel(cat) { return cat === "og" ? "OG" : cat === "dragon" ? "DRAGON" : "SMALL"; }
  
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
  
  function isNormal(mut) {
    if (!mut) return true;
    const s = String(mut).toLowerCase().replace(/\s+/g, "");
    return s === "" || s === "none" || s === "normal" || s === "base";
  }
  
  function setCounts() {
    const c = { og: 0, dragon: 0, small: 0 };
    for (const { entry } of items.values()) c[entry.category] = (c[entry.category] || 0) + 1;
    for (const cat of Object.keys(feeds)) {
      feeds[cat].count.textContent = c[cat] || 0;
      feeds[cat].empty.style.display = (c[cat] || 0) === 0 ? "" : "none";
    }
  }
  
  function updateStats(stats) {
    if (!stats) return;
    statEls.total.textContent  = stats.total  ?? 0;
    statEls.og.textContent     = stats.og     ?? 0;
    statEls.dragon.textContent = stats.dragon ?? 0;
    statEls.small.textContent  = stats.small  ?? 0;
  }
  
  function proxyImg(url) {
    if (!url) return null;
    return "/api/img-proxy?url=" + encodeURIComponent(url);
  }
  
  function buildCard(entry) {
    const node    = cardTpl.content.firstElementChild.cloneNode(true);
    node.dataset.cat = entry.category;
    node.dataset.id  = entry.id;
  
    const animals = Array.isArray(entry.animals) && entry.animals.length
      ? entry.animals
      : [{ name: "?", mutation: "Normal" }];
    const primary = animals[0];
  
    const imgWrap = node.querySelector(".card-img");
    const img     = imgWrap.querySelector("img");
    const rawUrl  = entry.image || primary.image;
    if (rawUrl) {
      img.src = proxyImg(rawUrl);
      img.alt = primary.name;
      img.addEventListener("error", () => imgWrap.classList.add("broken"), { once: true });
    } else {
      imgWrap.classList.add("broken");
    }
    node.querySelector(".card-tier").textContent = tierLabel(entry.category);
    node.querySelector(".card-title").textContent =
      animals.length > 1 ? `${primary.name}  +${animals.length - 1}` : primary.name;
  
    const rows = node.querySelector(".card-animals");
    animals.forEach(a => {
      const row = document.createElement("div");
      row.className = "a-row";
      if (animals.length > 1) {
        const nm = document.createElement("span");
        nm.className   = "a-name";
        nm.textContent = a.name;
        row.appendChild(nm);
      }
      const mut = document.createElement("span");
      if (isNormal(a.mutation)) { mut.className = "badge mut-normal"; mut.textContent = "Normal"; }
      else                       { mut.className = "badge mut";        mut.textContent = a.mutation; }
      row.appendChild(mut);
      if (a.generation) {
        const gen = document.createElement("span");
        gen.className   = "badge gen";
        gen.textContent = a.generation;
        row.appendChild(gen);
      }
      rows.appendChild(row);
    });
  
    const owner = entry.owner || "?";
    node.querySelector(".owner-name").textContent = owner;
    const avaEl  = node.querySelector(".owner-ava");
    const rawAva = entry.ownerAvatar;
    if (rawAva) {
      const avaImg = document.createElement("img");
      avaImg.src      = proxyImg(rawAva);
      avaImg.alt      = owner.charAt(0).toUpperCase();
      avaImg.style.cssText = "width:100%;height:100%;border-radius:50%;object-fit:cover;display:block;";
      avaImg.addEventListener("error", () => { avaImg.remove(); avaEl.textContent = owner.charAt(0).toUpperCase(); }, { once: true });
      avaEl.appendChild(avaImg);
    } else {
      avaEl.textContent = owner.charAt(0).toUpperCase();
    }
  
    const join = node.querySelector(".join-btn");
    if (entry.joinLink) { join.href = entry.joinLink; }
    else                { join.classList.add("disabled"); join.removeAttribute("href"); }
  
    const agoEl = node.querySelector(".ago");
    agoEl.textContent = timeAgo(entry.loggedAt || entry.receivedAt || Date.now());
  
    return { node, agoEl };
  }
  
  function addEntry(entry, isNew) {
    if (!entry || !entry.id || items.has(entry.id)) return;
    const when = entry.loggedAt || entry.receivedAt || Date.now();
    if (Date.now() - when > DAY_MS) return;
  
    const feed = feedOf(entry.category);
    const { node, agoEl } = buildCard(entry);
    if (isNew) node.classList.add("flash");
  
    feed.list.insertBefore(node, feed.list.firstChild === feed.empty ? feed.empty.nextSibling : feed.list.firstChild);
    items.set(entry.id, { entry, el: node, agoEl });
  
    const cards = feed.list.querySelectorAll(".card");
    if (cards.length > MAX_PER_FEED) {
      const last = cards[cards.length - 1];
      items.delete(last.dataset.id);
      last.remove();
    }
    setCounts();
  }
  
  function tickTimers() {
    const now = Date.now();
    for (const [id, it] of items) {
      const when = it.entry.loggedAt || it.entry.receivedAt;
      if (now - when > DAY_MS) { it.el.remove(); items.delete(id); continue; }
      it.agoEl.textContent = timeAgo(when);
    }
    setCounts();
  }
  
  function setConn(state) {
    connEl.classList.remove("live", "down");
    if      (state === "live") { connEl.classList.add("live"); connText.textContent = "live"; }
    else if (state === "down") { connEl.classList.add("down"); connText.textContent = "reconnecting…"; }
    else                        { connText.textContent = "connecting…"; }
  }
  
  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(loadSnapshot, 6000);
  }
  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }
  
  async function loadSnapshot() {
    if (!authToken) return;
    try {
      const res = await apiFetch("/api/logs", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      (data.logs || []).slice().reverse().forEach(e => addEntry(e, false));
      updateStats(data.stats);
    } catch (_) {}
  }
  
  function connect() {
    if (!authToken) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url   = `${proto}://${location.host}/ws?token=${encodeURIComponent(authToken)}`;
    try { ws = new WebSocket(url); } catch (_) { scheduleReconnect(); return; }
  
    ws.addEventListener("open", () => { setConn("live"); stopPolling(); });
  
    ws.addEventListener("message", ev => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      if      (msg.type === "init")  { (msg.logs || []).slice().reverse().forEach(e => addEntry(e, false)); updateStats(msg.stats); }
      else if (msg.type === "log")   { addEntry(msg.entry, true); updateStats(msg.stats); }
      else if (msg.type === "stats") { updateStats(msg.stats); }
    });
  
    ws.addEventListener("close", ev => {
      // 1008 = policy violation (bad token) — don't reconnect
      if (ev.code === 1008) { clearToken(); showLoginOverlay(); return; }
      setConn("down");
      scheduleReconnect();
    });
    ws.addEventListener("error", () => { try { ws.close(); } catch (_) {} });
  }
  
  function scheduleReconnect() {
    startPolling();
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 3000);
  }
  
  function stopApp() {
    appRunning = false;
    if (ws)             { try { ws.close(); } catch (_) {} ws = null; }
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (pollTimer)      { clearInterval(pollTimer); pollTimer = null; }
    if (timerTick)      { clearInterval(timerTick); timerTick = null; }
    // Clear feed
    for (const { el } of items.values()) el.remove();
    items.clear();
    setCounts();
    updateStats({ total: 0, og: 0, dragon: 0, small: 0 });
    setConn("connecting");
  }
  
  function startApp() {
    if (appRunning) return;
    appRunning = true;
    setConn("connecting");
    loadSnapshot();
    connect();
setInterval(tickTimers, 1000);
