"use strict";

  // ═══════════════════════════════════════════════════════════════════════════════
  // DEVICE ID (used as HWID — generated once per browser, stored in localStorage)
  // ═══════════════════════════════════════════════════════════════════════════════
  function getOrCreateDeviceId() {
    let id = localStorage.getItem("bl_device_id");
    if (!id) {
      id = (typeof crypto !== "undefined" && crypto.randomUUID)
        ? crypto.randomUUID()
        : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
            const r = Math.random() * 16 | 0;
            return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
          });
      localStorage.setItem("bl_device_id", id);
    }
    return id;
  }
  
  const DEVICE_ID = getOrCreateDeviceId();
  
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
  // BOOT
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
  // LOGIN
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

  // ── Login tab switching ───────────────────────────────────────────────────────
  const tabSignin   = document.getElementById("tabSignin");
  const tabRedeem   = document.getElementById("tabRedeem");
  const panelSignin = document.getElementById("panelSignin");
  const panelRedeem = document.getElementById("panelRedeem");

  function switchTab(tab) {
    if (tab === "redeem") {
      tabSignin.classList.remove("login-tab-active");
      tabRedeem.classList.add("login-tab-active");
      tabSignin.setAttribute("aria-selected", "false");
      tabRedeem.setAttribute("aria-selected", "true");
      panelSignin.setAttribute("hidden", "");
      panelRedeem.removeAttribute("hidden");
      document.getElementById("loginBrandSub").textContent = "Redeem your key to get access";
      document.getElementById("redeemKey").focus();
    } else {
      tabRedeem.classList.remove("login-tab-active");
      tabSignin.classList.add("login-tab-active");
      tabRedeem.setAttribute("aria-selected", "false");
      tabSignin.setAttribute("aria-selected", "true");
      panelRedeem.setAttribute("hidden", "");
      panelSignin.removeAttribute("hidden");
      document.getElementById("loginBrandSub").textContent = "Sign in to view the live feed";
      document.getElementById("loginUsername").focus();
    }
  }

  tabSignin.addEventListener("click", () => switchTab("signin"));
  tabRedeem.addEventListener("click", () => switchTab("redeem"));
  
  function showLoginOverlay() {
    loginOverlay.removeAttribute("hidden");
    appContent.setAttribute("hidden", "");
    document.getElementById("loginUsername").focus();
    stopApp();
  }
  
  function showApp() {
    loginOverlay.setAttribute("hidden", "");
    appContent.removeAttribute("hidden");
  
    const uname = currentUser.username;
    document.getElementById("userNameEl").textContent  = uname;
    document.getElementById("userAvatar").textContent  = uname.charAt(0).toUpperCase();
  
    const roleBadge = document.getElementById("userRoleBadge");
    roleBadge.textContent = currentUser.role;
    roleBadge.className   = "user-role-badge";
    if (currentUser.role === "owner") roleBadge.classList.add("role-owner");
    if (currentUser.role === "admin") roleBadge.classList.add("role-admin");
    if (currentUser.role === "mod")   roleBadge.classList.add("role-mod");

    // Show admin panel button for owner, admin, and mod
    if (currentUser.role === "owner" || currentUser.role === "admin" || currentUser.role === "mod") {
      document.getElementById("adminBtn").removeAttribute("hidden");
    }
  
    startApp();
  }
  
  pwToggle.addEventListener("click", () => {
    const show   = pwInput.type === "password";
    pwInput.type = show ? "text" : "password";
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
        body:    JSON.stringify({ username, password, hwid: DEVICE_ID }),
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
  
  document.getElementById("logoutBtn").addEventListener("click", () => {
    clearToken();
    showLoginOverlay();
    document.getElementById("userNameEl").textContent = "";
    document.getElementById("userAvatar").textContent = "?";
    document.getElementById("adminBtn").setAttribute("hidden", "");
    document.getElementById("userRoleBadge").textContent = "";
    document.getElementById("loginUsername").value = "";
    pwInput.value = "";
    loginError.hidden = true;
    // Reset to sign-in tab on logout
    switchTab("signin");
  });

  // ── Redeem Key form ───────────────────────────────────────────────────────────
  const redeemForm    = document.getElementById("redeemForm");
  const redeemError   = document.getElementById("redeemError");
  const redeemBtn     = document.getElementById("redeemBtn");
  const redeemBtnText = document.getElementById("redeemBtnText");
  const redeemSpinner = document.getElementById("redeemSpinner");
  const redeemKeyInp  = document.getElementById("redeemKey");

  redeemForm.addEventListener("submit", async e => {
    e.preventDefault();
    redeemError.hidden = true;

    const key = redeemKeyInp.value.trim();
    if (!key) { redeemError.textContent = "Enter your redemption key."; redeemError.hidden = false; return; }

    redeemBtn.disabled    = true;
    redeemBtnText.hidden  = true;
    redeemSpinner.removeAttribute("hidden");

    try {
      const res  = await fetch("/api/auth/redeem", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ key }),
      });
      const data = await res.json();

      if (!res.ok) { redeemError.textContent = data.error || "Redemption failed."; redeemError.hidden = false; return; }

      saveToken(data.token);
      currentUser = data.user;
      redeemKeyInp.value = "";
      showApp();
    } catch (_) {
      redeemError.textContent = "Network error. Please try again.";
      redeemError.hidden = false;
    } finally {
      redeemBtn.disabled    = false;
      redeemBtnText.hidden  = false;
      redeemSpinner.setAttribute("hidden", "");
    }
  });
  
  // ═══════════════════════════════════════════════════════════════════════════════
  // SOUND NOTIFICATIONS
  // ═══════════════════════════════════════════════════════════════════════════════
  let soundEnabled = localStorage.getItem("bl_sound") !== "off";

  const soundToggleBtn   = document.getElementById("soundToggleBtn");
  const soundIconOn      = document.getElementById("soundIconOn");
  const soundIconOff     = document.getElementById("soundIconOff");
  const soundToggleLabel = document.getElementById("soundToggleLabel");

  function applySoundUI() {
    if (soundEnabled) {
      soundIconOn.removeAttribute("hidden");
      soundIconOff.setAttribute("hidden", "");
      soundToggleBtn.title = "Sound on — click to mute";
      soundToggleLabel.textContent = "Sound";
      soundToggleBtn.style.opacity = "1";
    } else {
      soundIconOn.setAttribute("hidden", "");
      soundIconOff.removeAttribute("hidden");
      soundToggleBtn.title = "Sound off — click to unmute";
      soundToggleLabel.textContent = "Muted";
      soundToggleBtn.style.opacity = "0.55";
    }
  }
  applySoundUI();

  soundToggleBtn.addEventListener("click", () => {
    soundEnabled = !soundEnabled;
    localStorage.setItem("bl_sound", soundEnabled ? "on" : "off");
    applySoundUI();
  });

  // Soft bell chime — two notes a perfect 5th apart, each with a bell-like
  // inharmonic partial. Sounds like a gentle marimba notification.
  let _audioCtx = null;
  function playLogSound() {
    if (!soundEnabled) return;
    try {
      if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const ctx = _audioCtx;

      // Transparent limiter — prevents clipping if multiple logs arrive quickly
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -6;
      limiter.ratio.value     = 20;
      limiter.attack.value    = 0.001;
      limiter.release.value   = 0.1;
      limiter.connect(ctx.destination);

      // E5 (659 Hz) then B5 (988 Hz) — a perfect 5th, very consonant
      [{ freq: 659.25, t: 0.00 }, { freq: 987.77, t: 0.11 }].forEach(({ freq, t }) => {
        const now = ctx.currentTime + t;

        // Helper: one sine partial with fast attack and natural exponential decay
        function partial(f, vol, decayTc, stopAt) {
          const osc  = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = "sine";
          osc.frequency.value = f;
          osc.connect(gain);
          gain.connect(limiter);
          gain.gain.setValueAtTime(0, now);
          gain.gain.linearRampToValueAtTime(vol, now + 0.006); // 6 ms attack
          gain.gain.setTargetAtTime(0.0001, now + 0.006, decayTc); // smooth tail
          osc.start(now);
          osc.stop(now + stopAt);
        }

        partial(freq,        0.28, 0.14, 0.8); // fundamental — medium bell decay
        partial(freq * 2.76, 0.07, 0.03, 0.2); // inharmonic overtone — fast decay (gives the "ding" click)
      });
    } catch (_) {}
  }
  // ═══════════════════════════════════════════════════════════════════════════════
  // TOAST NOTIFICATIONS
  // ═══════════════════════════════════════════════════════════════════════════════
  (function initToastContainer() {
    const el = document.createElement("div");
    el.className = "toast-container";
    el.id = "toastContainer";
    document.body.appendChild(el);
  })();

  function showToast(title, sub) {
    const container = document.getElementById("toastContainer");
    if (!container) return;

    const toast = document.createElement("div");
    toast.className = "toast";
    toast.innerHTML = `<span class="toast-title">${title}</span>`
      + (sub ? `<span class="toast-sub">${sub}</span>` : "");

    container.appendChild(toast);

    // Remove after animation completes (2.6s fade + 0.28s out = ~2.9s)
    setTimeout(() => toast.remove(), 2950);
  }

  const DatePicker = (() => {
    const el         = document.getElementById("dpPopover");
    let _cb          = null;
    let _selDate     = null;
    let _dispYear    = 0;
    let _dispMonth   = 0;
    let _triggerEl   = null;
  
    function show(triggerEl, currentIso, callback) {
      _cb        = callback;
      _triggerEl = triggerEl;
      _selDate   = currentIso ? new Date(currentIso) : null;
      const ref  = _selDate || new Date();
      _dispYear  = ref.getFullYear();
      _dispMonth = ref.getMonth();
      document.getElementById("dpDaysInput").value = "";
      _render();
      // Position first (internally shows/hides the element to measure its size),
      // then reveal it — otherwise _position's measurement cleanup leaves it hidden.
      _position(triggerEl);
      el.removeAttribute("hidden");
    }
  
    function hide() {
      el.setAttribute("hidden", "");
      _cb        = null;
      _triggerEl = null;
    }
  
    function _position(anchor) {
      const r = anchor.getBoundingClientRect();
      let top  = r.bottom + window.scrollY + 6;
      let left = r.left   + window.scrollX;
      el.style.visibility = "hidden";
      el.removeAttribute("hidden");
      const popW = el.offsetWidth  || 272;
      const popH = el.offsetHeight || 380;
      el.setAttribute("hidden", "");
      el.style.visibility = "";
      if (left + popW > window.innerWidth - 8) left = window.innerWidth - popW - 8;
      if (left < 8) left = 8;
      if (top + popH > window.innerHeight + window.scrollY - 8)
        top = r.top + window.scrollY - popH - 6;
      el.style.top  = top  + "px";
      el.style.left = left + "px";
    }
  
    function _render() {
      const lbl = new Date(_dispYear, _dispMonth, 1)
        .toLocaleDateString("en-US", { month: "long", year: "numeric" });
      document.getElementById("dpMonthLabel").textContent = lbl;
  
      const grid    = document.getElementById("dpGrid");
      grid.innerHTML = "";
  
      const first   = new Date(_dispYear, _dispMonth, 1).getDay();
      const days    = new Date(_dispYear, _dispMonth + 1, 0).getDate();
      const today   = new Date();
      const todayD  = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      const selStr  = _selDate
        ? new Date(_selDate.getFullYear(), _selDate.getMonth(), _selDate.getDate()).toDateString()
        : null;
  
      for (let i = 0; i < first; i++) {
        const c = document.createElement("div");
        c.className = "dp-cell dp-empty";
        grid.appendChild(c);
      }
      for (let d = 1; d <= days; d++) {
        const date = new Date(_dispYear, _dispMonth, d);
        const c    = document.createElement("div");
        c.className   = "dp-cell";
        c.textContent = d;
        if (date < todayD)        c.classList.add("dp-past");
        if (date.toDateString() === today.toDateString()) c.classList.add("dp-today");
        if (date.toDateString() === selStr) c.classList.add("dp-selected");
        c.addEventListener("click", () => {
          _selDate = new Date(_dispYear, _dispMonth, d, 23, 59, 59);
          _render();
        });
        grid.appendChild(c);
      }
    }
  
    document.getElementById("dpPrev").addEventListener("click", e => {
      e.stopPropagation();
      _dispMonth--;
      if (_dispMonth < 0) { _dispMonth = 11; _dispYear--; }
      _render();
    });
    document.getElementById("dpNext").addEventListener("click", e => {
      e.stopPropagation();
      _dispMonth++;
      if (_dispMonth > 11) { _dispMonth = 0; _dispYear++; }
      _render();
    });
  
    document.querySelectorAll(".dp-preset").forEach(btn => {
      btn.addEventListener("click", e => {
        e.stopPropagation();
        const days = parseInt(btn.dataset.days, 10);
        const d = new Date();
        d.setDate(d.getDate() + days);
        d.setHours(23, 59, 59, 0);
        _selDate   = d;
        _dispYear  = d.getFullYear();
        _dispMonth = d.getMonth();
        _render();
      });
    });
  
    document.getElementById("dpDaysInput").addEventListener("input", e => {
      const n = parseInt(e.target.value, 10);
      if (n > 0 && n <= 3650) {
        const d = new Date();
        d.setDate(d.getDate() + n);
        d.setHours(23, 59, 59, 0);
        _selDate   = d;
        _dispYear  = d.getFullYear();
        _dispMonth = d.getMonth();
        _render();
      }
    });
  
    document.getElementById("dpClear").addEventListener("click", e => {
      e.stopPropagation();
      const cb = _cb;
      hide();
      if (cb) cb(null);
    });
  
    document.getElementById("dpApply").addEventListener("click", e => {
      e.stopPropagation();
      const cb = _cb;
      let iso = null;
      if (_selDate) {
        // Apply the time from the time input field
        const timeVal = document.getElementById("dpTimeInput").value || "23:59";
        const [hh, mm] = timeVal.split(":").map(Number);
        const d = new Date(_selDate);
        d.setHours(hh || 23, mm || 59, 59, 0);
        iso = d.toISOString();
      }
      hide();
      if (cb) cb(iso);
    });
  
    document.addEventListener("click", e => {
      if (!el.hasAttribute("hidden") &&
          !el.contains(e.target) &&
          !e.target.closest(".expiry-trigger")) {
        hide();
      }
    });
  
    return { show, hide };
  })();
  
  // ═══════════════════════════════════════════════════════════════════════════════
  // DATE FORMAT HELPERS
  // ═══════════════════════════════════════════════════════════════════════════════
  function fmtExpiry(iso) {
    if (!iso) return "No expiry";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "Invalid";
    const now = Date.now();
    if (d.getTime() < now) return "EXPIRED";
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }
  
  function isExpired(iso) {
    if (!iso) return false;
    return new Date(iso).getTime() < Date.now();
  }
  
  function escHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  
  // ═══════════════════════════════════════════════════════════════════════════════
  // ADMIN PANEL
  // ═══════════════════════════════════════════════════════════════════════════════
  const adminOverlay   = document.getElementById("adminOverlay");
  const adminClose     = document.getElementById("adminClose");
  const createUserForm = document.getElementById("createUserForm");
  const createUserErr  = document.getElementById("createUserError");
  const createUserOk   = document.getElementById("createUserSuccess");
  const userListEl     = document.getElementById("userList");
  
  // Reset password nested modal
  const resetPwOverlay = document.getElementById("resetPwOverlay");
  const resetPwLabel   = document.getElementById("resetPwLabel");
  const resetPwInput   = document.getElementById("resetPwInput");
  const resetPwError   = document.getElementById("resetPwError");
  const resetPwConfirm = document.getElementById("resetPwConfirm");
  const resetPwCancel  = document.getElementById("resetPwCancel");
  let   resetPwUserId  = null;
  
  // ── Create form expiry picker ─────────────────────────────────────────────────
  const createExpiryBtn   = document.getElementById("createExpiryBtn");
  const createExpiryClear = document.getElementById("createExpiryClear");
  const newExpiresAtInput = document.getElementById("newExpiresAt");
  const createExpiryLabel = document.getElementById("createExpiryLabel");
  
  createExpiryBtn.addEventListener("click", e => {
    e.stopPropagation();
    DatePicker.show(createExpiryBtn, newExpiresAtInput.value || null, iso => {
      newExpiresAtInput.value = iso || "";
      createExpiryLabel.textContent = fmtExpiry(iso);
      createExpiryClear.hidden = !iso;
    });
  });
  
  createExpiryClear.addEventListener("click", e => {
    e.stopPropagation();
    newExpiresAtInput.value = "";
    createExpiryLabel.textContent = "No expiry";
    createExpiryClear.hidden = true;
    DatePicker.hide();
  });
  
  // ── All Access toggle wires up the 3 individual toggles ────────────────────
  const accessOgEl     = document.getElementById("accessOg");
  const accessDragonEl = document.getElementById("accessDragon");
  const accessSmallEl  = document.getElementById("accessSmall");
  const accessAllEl    = document.getElementById("accessAll");

  function updateAllAccessState() {
    accessAllEl.checked = accessOgEl.checked && accessDragonEl.checked && accessSmallEl.checked;
  }

  [accessOgEl, accessDragonEl, accessSmallEl].forEach(el => {
    el.addEventListener("change", updateAllAccessState);
  });

  accessAllEl.addEventListener("change", () => {
    const v = accessAllEl.checked;
    accessOgEl.checked = v;
    accessDragonEl.checked = v;
    accessSmallEl.checked = v;
  });

  // ── Hide role selector for non-owners ────────────────────────────────────────
  document.getElementById("adminBtn").addEventListener("click", () => {
    // Show role field only for owner
    const roleWrap = document.getElementById("roleFieldWrap");
    if (currentUser && currentUser.role === "owner") {
      roleWrap.removeAttribute("hidden");
    } else {
      roleWrap.setAttribute("hidden", "");
    }
    adminOverlay.removeAttribute("hidden");
    fetchUsers();
  });
  
  adminClose.addEventListener("click", () => adminOverlay.setAttribute("hidden", ""));
  adminOverlay.addEventListener("click", e => {
    if (e.target === adminOverlay) adminOverlay.setAttribute("hidden", "");
  });
  
  document.getElementById("refreshUsers").addEventListener("click", fetchUsers);
  
  // ── Create user ───────────────────────────────────────────────────────────────
  createUserForm.addEventListener("submit", async e => {
    e.preventDefault();
    createUserErr.hidden = true;
    createUserOk.hidden  = true;
  
    const username     = document.getElementById("newUsername").value.trim();
    const password     = document.getElementById("newPassword").value;
    const role         = document.getElementById("newRole").value;
    const expiresAt    = newExpiresAtInput.value || null;
    const ogAccess     = accessOgEl.checked;
    const dragonAccess = accessDragonEl.checked;
    const smallAccess  = accessSmallEl.checked;
  
    if (!username || !password) {
      showCreateErr("Username and password are required.");
      return;
    }
  
    try {
      const res  = await apiFetch("/api/admin/users", {
        method: "POST",
        body:   JSON.stringify({ username, password, role, expiresAt, ogAccess, dragonAccess, smallAccess }),
      });
      const data = await res.json();
      if (!res.ok) { showCreateErr(data.error || "Failed to create user."); return; }
  
      const expStr = data.user.expiresAt ? ` · expires ${fmtExpiry(data.user.expiresAt)}` : "";
      createUserOk.textContent = `✓ Created: ${data.user.username} (${data.user.role})${expStr}`;
      createUserOk.hidden = false;
  
      document.getElementById("newUsername").value = "";
      document.getElementById("newPassword").value = "";
      document.getElementById("newRole").value = "viewer";
      newExpiresAtInput.value = "";
      createExpiryLabel.textContent = "No expiry";
      createExpiryClear.hidden = true;
      accessOgEl.checked = false;
      accessDragonEl.checked = false;
      accessSmallEl.checked = false;
      accessAllEl.checked = false;
  
      fetchUsers();
    } catch (err) {
      if (err.message !== "unauthorized") showCreateErr("Network error.");
    }
  });
  
  function showCreateErr(msg) {
    createUserErr.textContent = msg;
    createUserErr.hidden = false;
  }
  
  // ── Fetch and render user list ────────────────────────────────────────────────
  async function fetchUsers() {
    userListEl.innerHTML = '<div class="user-list-empty">Loading…</div>';
    try {
      const res  = await apiFetch("/api/admin/users");
      const data = await res.json();
      if (!res.ok) {
        userListEl.innerHTML = `<div class="user-list-empty">Error: ${escHtml(data.error)}</div>`;
        return;
      }
      renderUsers(data.users);
    } catch (err) {
      if (err.message !== "unauthorized")
        userListEl.innerHTML = '<div class="user-list-empty">Failed to load users.</div>';
    }
  }
  
  function renderUsers(users) {
    if (!users.length) {
      userListEl.innerHTML = '<div class="user-list-empty">No accounts yet.</div>';
      return;
    }

    userListEl.innerHTML = "";
    const isOwner = currentUser && currentUser.role === "owner";
    const isMod   = currentUser && currentUser.role === "mod";
  
    for (const u of users) {
      const row = document.createElement("div");
      row.className = "user-row";
      row.dataset.id   = u.id;
      row.dataset.role = u.role;
  
      const created = u.createdAt
        ? new Date(u.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
        : "—";
  
      const expired     = isExpired(u.expiresAt);
      const expiryTxt   = fmtExpiry(u.expiresAt);
      const expiryClass = !u.expiresAt ? "expiry-none" : expired ? "expiry-expired" : "expiry-active";
  
      const ipDisplay   = u.lockedIp   ? u.lockedIp   : (u.hasIp  ? "••••" : "—");
      const hwidDisplay = u.hwidMasked ? u.hwidMasked : (u.hasHwid ? "••••" : "—");
  
      // Role badge
      const roleCls = u.role === "admin"  ? "role-badge-admin"  :
                      u.role === "mod"    ? "role-badge-mod"    :
                      u.role === "owner"  ? "role-badge-owner"  : "role-badge-viewer";

      // Owner cycles roles: viewer → admin → mod → viewer
      const nextRoleLabel = u.role === "admin" ? "→ Mod" : u.role === "mod" ? "→ Viewer" : "→ Admin";
      const roleToggleBtn = isOwner
        ? `<button class="btn-role btn-sm" data-action="toggle-role" data-id="${u.id}" data-role="${u.role}">${nextRoleLabel}</button>`
        : "";

      // Access badges — mods see read-only
      const bOpts = isMod ? ' style="cursor:default;pointer-events:none;opacity:0.6"' : '';
      const accessBadges = `
        <div class="access-badges">
          <span class="access-badge ${u.ogAccess ? 'access-badge-og' : 'access-badge-off'}" data-access="og" data-id="${u.id}" data-state="${u.ogAccess}" title="OG Access"${bOpts}>OG</span>
          <span class="access-badge ${u.dragonAccess ? 'access-badge-dragon' : 'access-badge-off'}" data-access="dragon" data-id="${u.id}" data-state="${u.dragonAccess}" title="Mid Highlight Access"${bOpts}>MID</span>
          <span class="access-badge ${u.smallAccess ? 'access-badge-small' : 'access-badge-off'}" data-access="small" data-id="${u.id}" data-state="${u.smallAccess}" title="Newbie Highlights"${bOpts}>NEW</span>
        </div>`;
  
      row.innerHTML = `
        <div class="user-row-header">
          <div class="user-row-identity">
            <span class="user-row-avatar">${escHtml(u.username.charAt(0).toUpperCase())}</span>
            <div class="user-row-ident">
              <span class="user-row-name">${escHtml(u.username)}</span>
              <span class="user-row-created">Created ${created}</span>
            </div>
          </div>
          <div class="user-row-badges">
            <span class="role-badge ${roleCls}">${u.role}</span>
            <button class="expiry-trigger expiry-edit-btn ${expiryClass}" data-action="edit-expiry" data-id="${u.id}" data-expiry="${escHtml(u.expiresAt || "")}">
              <svg viewBox="0 0 20 20" fill="currentColor" width="11" height="11" style="flex-shrink:0"><path fill-rule="evenodd" d="M6 2a1 1 0 00-1 1v1H4a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V6a2 2 0 00-2-2h-1V3a1 1 0 10-2 0v1H7V3a1 1 0 00-1-1zm0 5a1 1 0 000 2h8a1 1 0 100-2H6z" clip-rule="evenodd"/></svg>
              ${expired ? "⚠ " : ""}${expiryTxt}
            </button>
          </div>
        </div>

        <div class="user-row-access">
          ${accessBadges}
        </div>
  
        <div class="user-row-security">
          <div class="sec-item">
            <svg class="sec-icon" viewBox="0 0 20 20" fill="currentColor" width="12" height="12"><path fill-rule="evenodd" d="M4.083 9h1.946c.089-1.546.383-2.97.837-4.118A6.004 6.004 0 004.083 9zM10 2a8 8 0 100 16A8 8 0 0010 2zm0 2c-.076 0-.232.032-.465.262-.238.234-.497.623-.737 1.182-.389.907-.673 2.142-.766 3.556h3.936c-.093-1.414-.377-2.649-.766-3.556-.24-.56-.5-.948-.737-1.182C10.232 4.032 10.076 4 10 4zm3.971 5c-.089-1.546-.383-2.97-.837-4.118A6.004 6.004 0 0115.917 9h-1.946zm-2.003 2H8.032c.093 1.414.377 2.649.766 3.556.24.56.5.948.737 1.182.233.23.389.262.465.262.076 0 .232-.032.465-.262.238-.234.498-.623.737-1.182.389-.907.673-2.142.766-3.556zm1.166 4.118c.454-1.147.748-2.572.837-4.118h1.946a6.004 6.004 0 01-2.783 4.118zm-6.268 0C6.412 13.97 6.118 12.546 6.03 11H4.083a6.004 6.004 0 002.783 4.118z" clip-rule="evenodd"/></svg>
            <span class="sec-label">IP</span>
            <span class="sec-value ${(u.lockedIp || u.hasIp) ? "" : "sec-empty"}">${escHtml(ipDisplay)}</span>
            ${(u.lockedIp || u.hasIp) ? `<button class="btn-micro" data-action="reset-ip" data-id="${u.id}">Reset</button>` : ""}
          </div>
          <div class="sec-item">
            <svg class="sec-icon" viewBox="0 0 20 20" fill="currentColor" width="12" height="12"><path fill-rule="evenodd" d="M18 8a6 6 0 01-7.743 5.743L10 14l-1 1-1 1H6v2H2v-4l4.257-4.257A6 6 0 1118 8zm-6-4a1 1 0 100 2 2 2 0 012 2 1 1 0 102 0 4 4 0 00-4-4z" clip-rule="evenodd"/></svg>
            <span class="sec-label">Device</span>
            <span class="sec-value ${u.hasHwid ? "" : "sec-empty"}">${escHtml(hwidDisplay)}</span>
            ${u.hasHwid ? `<button class="btn-micro" data-action="reset-hwid" data-id="${u.id}">Reset</button>` : ""}
          </div>
        </div>
  
        <div class="user-row-actions">
          ${roleToggleBtn}
          ${!isMod ? `<button class="btn-ghost btn-sm" data-action="reset-pw" data-id="${u.id}" data-name="${escHtml(u.username)}">Reset PW</button>` : ""}
          ${!isMod ? `<button class="btn-danger btn-sm" data-action="delete" data-id="${u.id}" data-name="${escHtml(u.username)}">Delete</button>` : ""}
        </div>
      `;
  
      userListEl.appendChild(row);
    }
  
    // ── Bind actions ────────────────────────────────────────────────────────────
    userListEl.querySelectorAll("[data-action='delete']").forEach(btn => {
      btn.addEventListener("click", () => deleteUser(btn.dataset.id, btn.dataset.name));
    });
    userListEl.querySelectorAll("[data-action='reset-pw']").forEach(btn => {
      btn.addEventListener("click", () => openResetPw(btn.dataset.id, btn.dataset.name));
    });
    userListEl.querySelectorAll("[data-action='reset-ip']").forEach(btn => {
      btn.addEventListener("click", () => resetIp(btn.dataset.id));
    });
    userListEl.querySelectorAll("[data-action='reset-hwid']").forEach(btn => {
      btn.addEventListener("click", () => resetHwid(btn.dataset.id));
    });
    userListEl.querySelectorAll("[data-action='toggle-role']").forEach(btn => {
      btn.addEventListener("click", () => toggleRole(btn.dataset.id, btn.dataset.role));
    });
    userListEl.querySelectorAll("[data-action='edit-expiry']").forEach(btn => {
      btn.addEventListener("click", e => {
        e.stopPropagation();
        DatePicker.show(btn, btn.dataset.expiry || null, async iso => {
          await setExpiry(btn.dataset.id, iso);
        });
      });
    });
    // Access badge toggles
    userListEl.querySelectorAll(".access-badge[data-access]").forEach(badge => {
      badge.addEventListener("click", () => toggleAccessBadge(badge));
    });
  }
  
  async function toggleAccessBadge(badge) {
    const id       = badge.dataset.id;
    const access   = badge.dataset.access; // "og" | "dragon" | "small"
    const current  = badge.dataset.state === "true";
    const newState = !current;

    // Find the row and read all current access states
    const row = badge.closest(".user-row");
    const ogBadge  = row.querySelector("[data-access='og']");
    const drBadge  = row.querySelector("[data-access='dragon']");
    const smBadge  = row.querySelector("[data-access='small']");

    const payload = {
      ogAccess:     ogBadge  ? ogBadge.dataset.state  === "true" : false,
      dragonAccess: drBadge  ? drBadge.dataset.state  === "true" : false,
      smallAccess:  smBadge  ? smBadge.dataset.state  === "true" : false,
    };
    if (access === "og")     payload.ogAccess     = newState;
    if (access === "dragon") payload.dragonAccess = newState;
    if (access === "small")  payload.smallAccess  = newState;

    try {
      const res = await apiFetch(`/api/admin/users/${id}/access`, {
        method: "PUT",
        body:   JSON.stringify(payload),
      });
      if (!res.ok) { const d = await res.json(); alert(d.error || "Failed to update access."); return; }
      fetchUsers();
    } catch (err) {
      if (err.message !== "unauthorized") alert("Network error.");
    }
  }

  // ── Admin API actions ─────────────────────────────────────────────────────────
  async function deleteUser(id, name) {
    if (!confirm(`Delete login for "${name}"?\nThis cannot be undone.`)) return;
    try {
      const res = await apiFetch(`/api/admin/users/${id}`, { method: "DELETE" });
      if (!res.ok) { const d = await res.json(); alert(d.error || "Failed to delete."); return; }
      fetchUsers();
    } catch (err) {
      if (err.message !== "unauthorized") alert("Network error.");
    }
  }
  
  async function resetIp(id) {
    if (!confirm("Reset IP lock for this user?\nThey will be re-locked on next login.")) return;
    try {
      const res = await apiFetch(`/api/admin/users/${id}/reset-ip`, { method: "POST" });
      if (!res.ok) { const d = await res.json(); alert(d.error || "Failed."); return; }
      fetchUsers();
    } catch (err) {
      if (err.message !== "unauthorized") alert("Network error.");
    }
  }
  
  async function resetHwid(id) {
    if (!confirm("Reset device lock for this user?\nThey will be re-locked on next login.")) return;
    try {
      const res = await apiFetch(`/api/admin/users/${id}/reset-hwid`, { method: "POST" });
      if (!res.ok) { const d = await res.json(); alert(d.error || "Failed."); return; }
      fetchUsers();
    } catch (err) {
      if (err.message !== "unauthorized") alert("Network error.");
    }
  }
  
  async function setExpiry(id, iso) {
    try {
      const res  = await apiFetch(`/api/admin/users/${id}/expiry`, {
        method:  "PUT",
        body:    JSON.stringify({ expiresAt: iso || null }),
      });
      if (!res.ok) { const d = await res.json(); alert(d.error || "Failed."); return; }
      fetchUsers();
    } catch (err) {
      if (err.message !== "unauthorized") alert("Network error.");
    }
  }
  
  async function toggleRole(id, currentRole) {
    // Cycle: viewer → admin → mod → viewer
    const newRole = currentRole === "viewer" ? "admin" : currentRole === "admin" ? "mod" : "viewer";
    const label   = newRole === "admin" ? "promote to Admin" : newRole === "mod" ? "promote to Mod" : "demote to Viewer";
    if (!confirm(`Are you sure you want to ${label}?`)) return;
    try {
      const res  = await apiFetch(`/api/admin/users/${id}/role`, {
        method: "PUT",
        body:   JSON.stringify({ role: newRole }),
      });
      if (!res.ok) { const d = await res.json(); alert(d.error || "Failed."); return; }
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
  
  // ═══════════════════════════════════════════════════════════════════════════════
  // PLAYER ONLINE TRACKER
  // A player is considered "online" when they appear in a log within the last
  // ONLINE_THRESHOLD_MS (5 minutes). Status dots auto-update every 30 seconds.
  // ═══════════════════════════════════════════════════════════════════════════════
  const ONLINE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

  // Map<lowerCaseUsername, { lastSeenAt: number, ownerId: string|null }>
  const playerTracker = new Map();

  /** Update or insert a player's last-seen timestamp. */
  function trackPlayer(owner, ownerId, when) {
    if (!owner) return;
    const key      = owner.toLowerCase();
    const existing = playerTracker.get(key);
    if (!existing || when > existing.lastSeenAt) {
      playerTracker.set(key, { lastSeenAt: when, ownerId: ownerId || null });
    }
  }

  /** Compute online/offline state for one player. */
  function playerOnlineState(owner) {
    const info = playerTracker.get((owner || "").toLowerCase());
    if (!info) return { status: "unknown", info: null };
    const online = Date.now() - info.lastSeenAt < ONLINE_THRESHOLD_MS;
    return { status: online ? "online" : "offline", info };
  }

  /** Refresh the class + tooltip of a single status dot element. */
  function refreshStatusDot(dot) {
    const owner = dot.dataset.player;
    const { status, info } = playerOnlineState(owner);
    dot.className = "player-status " + status;
    if (status === "online") {
      dot.title = "🟢 Online";
    } else if (status === "offline" && info) {
      dot.title = "🔴 Last seen " + timeAgo(info.lastSeenAt);
    } else {
      dot.title = "Status unknown";
    }
  }

  /** Walk every status dot in the DOM and refresh it. Called on a 30s interval. */
  function updateAllStatusDots() {
    document.querySelectorAll(".player-status[data-player]").forEach(refreshStatusDot);
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // MAIN APP (log feed)
  // ═══════════════════════════════════════════════════════════════════════════════
  const DAY_MS       = 24 * 60 * 60 * 1000;
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
  
  const items = new Map();
  
  let ws             = null;
  let reconnectTimer = null;
  let pollTimer      = null;
  let timerTick      = null;
  let statusTick     = null;   // 30-second interval to refresh online/offline dots
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

  function fallbackCopy(text, onDone) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      document.execCommand("copy");
      ta.remove();
      onDone();
    } catch (_) { /* clipboard unavailable, fail silently */ }
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
      img.addEventListener("error", () => {
        imgWrap.classList.add("broken");
        imgWrap.dataset.fallback = (primary.name || "?").charAt(0).toUpperCase();
        // Re-fetch the proxy URL directly so the real failure reason (404, upstream
        // error, bad content-type, etc.) shows up in the console instead of just
        // a generic broken-image icon with no explanation.
        fetch(img.src).then(r => {
          if (!r.ok) return r.json().catch(() => null).then(body => {
            console.warn("[image] failed to load:", { animal: primary.name, sourceUrl: rawUrl, status: r.status, ...body });
          });
        }).catch(err => console.warn("[image] proxy request failed:", { animal: primary.name, sourceUrl: rawUrl, error: err.message }));
      }, { once: true });
    } else {
      imgWrap.classList.add("broken");
      imgWrap.dataset.fallback = (primary.name || "?").charAt(0).toUpperCase();
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
    const nameEl = node.querySelector(".owner-name");
    nameEl.textContent = owner;
    nameEl.href = entry.ownerId
      ? `https://www.roblox.com/users/${entry.ownerId}/profile`
      : `https://www.roblox.com/search/users?keyword=${encodeURIComponent(owner)}`;
    nameEl.title = entry.ownerId ? "Open Roblox profile" : "Search this username on Roblox";

    // ── Player online status dot ─────────────────────────────────────────────
    const statusDot = document.createElement("span");
    statusDot.className   = "player-status";
    statusDot.dataset.player = owner;
    refreshStatusDot(statusDot);
    nameEl.insertAdjacentElement("afterend", statusDot);

    const copyBtn = node.querySelector(".owner-copy");
    copyBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const flash = () => { copyBtn.classList.add("copied"); setTimeout(() => copyBtn.classList.remove("copied"), 1200); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(owner).then(flash).catch(() => fallbackCopy(owner, flash));
      } else {
        fallbackCopy(owner, flash);
      }
    });

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

    // ── Copy Script button ───────────────────────────────────────────────────
    // Copies the full esp.lua script with TARGET_PLAYER and TARGET_ANIMALS
    // injected from this log entry — ready to paste straight into an executor.
    const copyScriptBtn   = node.querySelector(".copy-script-btn");
    const copyScriptLabel = node.querySelector(".copy-script-label");
    copyScriptBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();

      const flash = (ok) => {
        copyScriptLabel.textContent = ok ? "Copied!" : "Failed";
        copyScriptBtn.classList.add(ok ? "copied" : "failed");
        setTimeout(() => {
          copyScriptLabel.textContent = "Copy Script";
          copyScriptBtn.classList.remove("copied", "failed");
        }, 1400);
      };

      // Escape values for Lua string literals
      const escapedOwner = owner.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const animalLines  = animals.map(a => {
        const n = a.name.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        const parts = [`  "${n}"`];
        if (a.mutation && !isNormal(a.mutation)) parts.push(`-- ${a.mutation}`);
        if (a.generation) parts.push(`-- ${a.generation}`);
        return parts.join(" ");
      });
      const animalTable = "{\n" + animalLines.join(",\n") + "\n}";

      // Full esp.lua with the two config lines replaced
      const script = ESP_TEMPLATE
        .replace('local TARGET_PLAYER  = ""', `local TARGET_PLAYER  = "${escapedOwner}"`)
        .replace("local TARGET_ANIMALS = {}", `local TARGET_ANIMALS = ${animalTable}`);

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(script).then(() => flash(true)).catch(() => fallbackCopy(script, () => flash(true)));
      } else {
        fallbackCopy(script, () => flash(true));
      }
    });
  
    // ── Info button ──────────────────────────────────────────────────────────
    node.querySelector(".info-btn-mini").addEventListener("click", e => {
      e.preventDefault();
      e.stopPropagation();
      openInfoModal(entry);
    });

    const agoEl = node.querySelector(".ago");
    agoEl.textContent = timeAgo(entry.loggedAt || entry.receivedAt || Date.now());
  
    return { node, agoEl };
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // INFO MODAL — animal trait breakdown
  // ═══════════════════════════════════════════════════════════════════════════════
  const INFO_OVERLAY = document.getElementById("infoOverlay");
  const INFO_TITLE   = document.getElementById("infoModalTitle");
  const INFO_BODY    = document.getElementById("infoModalBody");
  document.getElementById("infoClose").addEventListener("click", () => INFO_OVERLAY.setAttribute("hidden", ""));
  INFO_OVERLAY.addEventListener("click", e => { if (e.target === INFO_OVERLAY) INFO_OVERLAY.setAttribute("hidden", ""); });

  // Mutation multipliers (community-known values for Steal a Brainrot)
  const MUTATION_MULTI = {
    "normal":     { mult: 1,    label: "Normal",     color: "#9aa0b4" },
    "shiny":      { mult: 3,    label: "Shiny",      color: "#ffe033" },
    "golden":     { mult: 5,    label: "Golden",     color: "#ffc800" },
    "gold":       { mult: 5,    label: "Gold",       color: "#ffc800" },
    "frozen":     { mult: 4,    label: "Frozen",     color: "#64c8ff" },
    "crystal":    { mult: 6,    label: "Crystal",    color: "#64dcff" },
    "dark":       { mult: 4,    label: "Dark",       color: "#b450ff" },
    "corrupted":  { mult: 6,    label: "Corrupted",  color: "#a000ff" },
    "rainbow":    { mult: 10,   label: "Rainbow",    color: "#ff50ff" },
    "prismatic":  { mult: 15,   label: "Prismatic",  color: "#ff50ff" },
  };

  function getMutationInfo(raw) {
    if (!raw) return MUTATION_MULTI["normal"];
    const key = String(raw).trim().toLowerCase();
    return MUTATION_MULTI[key] || { mult: "?", label: raw, color: "#ffffff" };
  }

  // Parse generation string — e.g. "Gen 3", "3", "Generation 2" → number
  function parseGen(raw) {
    if (!raw) return null;
    const m = String(raw).match(/(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  }

  function openInfoModal(entry) {
    const animals = Array.isArray(entry.animals) && entry.animals.length
      ? entry.animals
      : [{ name: "?", mutation: "Normal", generation: null, tier: 1 }];

    const catLabel = entry.category === "og" ? "OG" : entry.category === "dragon" ? "Dragon" : "Small";
    const when = entry.loggedAt || entry.receivedAt || Date.now();
    const timeStr = new Date(when).toLocaleString(undefined, {
      month: "short", day: "numeric", year: "numeric",
      hour: "numeric", minute: "2-digit",
    });

    INFO_TITLE.textContent = animals.length === 1 ? animals[0].name : `${animals[0].name} +${animals.length - 1}`;

    let html = `
      <div class="info-meta-row">
        <span class="info-chip info-chip-cat info-chip-${entry.category}">${catLabel}</span>
        <span class="info-chip">👤 ${escHtml(entry.owner || "?")}</span>
        <span class="info-chip">🕐 ${timeStr}</span>
      </div>`;

    for (const animal of animals) {
      const mut  = getMutationInfo(animal.mutation);
      const gen  = parseGen(animal.generation);
      const tier = Number(animal.tier) || 1;

      // Effective multiplier = mutation mult × generation
      const genMult    = gen ? gen : 1;
      const totalMult  = mut.mult !== "?" ? (mut.mult * genMult) : "?";
      const totalLabel = totalMult !== "?" ? `${totalMult}×` : "unknown";

      html += `
        <div class="info-animal-card">
          <div class="info-animal-header">
            <span class="info-animal-name">${escHtml(animal.name)}</span>
            <span class="info-tier-badge">Tier ${tier}</span>
          </div>
          <div class="info-rows">
            <div class="info-row">
              <span class="info-row-label">Mutation</span>
              <span class="info-row-value" style="color:${mut.color}">${escHtml(mut.label)}</span>
              <span class="info-row-right info-mult">${mut.mult}×</span>
            </div>
            <div class="info-row">
              <span class="info-row-label">Generation</span>
              <span class="info-row-value">${gen ? `Gen ${gen}` : (animal.generation ? escHtml(animal.generation) : "—")}</span>
              <span class="info-row-right info-mult">${gen ? `${gen}×` : "—"}</span>
            </div>
            <div class="info-row info-row-total">
              <span class="info-row-label">Combined Mult</span>
              <span class="info-row-value info-row-value-em">${mut.mult !== "?" && gen ? `${mut.mult} × ${gen}` : "—"}</span>
              <span class="info-row-right info-mult info-mult-total">${totalLabel}</span>
            </div>
          </div>
        </div>`;
    }

    if (entry.placeId) {
      html += `
        <div class="info-footer-row">
          <span class="info-foot-label">Place ID</span>
          <code class="info-foot-val">${escHtml(entry.placeId)}</code>
        </div>`;
    }
    if (entry.jobId) {
      html += `
        <div class="info-footer-row">
          <span class="info-foot-label">Server (Job ID)</span>
          <code class="info-foot-val info-foot-mono">${escHtml(entry.jobId)}</code>
        </div>`;
    }

    INFO_BODY.innerHTML = html;
    INFO_OVERLAY.removeAttribute("hidden");
  }

  function addEntry(entry, isNew) {
    if (!entry || !entry.id || items.has(entry.id)) return;
    const when = entry.loggedAt || entry.receivedAt || Date.now();
    if (Date.now() - when > DAY_MS) return;

    // Keep player tracker up to date so status dots are accurate
    if (entry.owner) trackPlayer(entry.owner, entry.ownerId, when);

    const feed = feedOf(entry.category);
    const { node, agoEl } = buildCard(entry);
    if (isNew) { node.classList.add("flash"); playLogSound(); }
  
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
    if (statusTick)     { clearInterval(statusTick); statusTick = null; }
    for (const { el } of items.values()) el.remove();
    items.clear();
    playerTracker.clear();
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
    timerTick  = setInterval(tickTimers, 1000);
    // Refresh online/offline status dots every 30 seconds
    statusTick = setInterval(updateAllStatusDots, 30000);
  }

// ═══════════════════════════════════════════════════════════════════════════════
// GET ROLE (Discord verification)
// ═══════════════════════════════════════════════════════════════════════════════
(function initGetRole() {
  const overlay       = document.getElementById("getRoleOverlay");
  const getRoleBtn    = document.getElementById("getRoleBtn");
  const closeBtn      = document.getElementById("getRoleClose");
  const step1         = document.getElementById("grStep1");
  const step2         = document.getElementById("grStep2");
  const step1Ind      = document.getElementById("grStep1Ind");
  const step2Ind      = document.getElementById("grStep2Ind");
  const discordIdInp  = document.getElementById("grDiscordId");
  const codeInp       = document.getElementById("grCode");
  const sendBtn       = document.getElementById("grSendCode");
  const sendBtnText   = document.getElementById("grSendCodeText");
  const sendSpinner   = document.getElementById("grSendSpinner");
  const verifyBtn     = document.getElementById("grVerifyCode");
  const verifyText    = document.getElementById("grVerifyText");
  const verifySpinner = document.getElementById("grVerifySpinner");
  const backBtn       = document.getElementById("grBack");
  const err1          = document.getElementById("grStep1Error");
  const err2          = document.getElementById("grStep2Error");
  const success       = document.getElementById("grSuccess");

  let pendingDiscordId = null;

  function openModal() {
    overlay.removeAttribute("hidden");
    showStep(1);
    discordIdInp.value = "";
    codeInp.value      = "";
    err1.hidden = true;
    err2.hidden = true;
    success.hidden = true;
    discordIdInp.focus();
  }

  function closeModal() {
    overlay.setAttribute("hidden", "");
    pendingDiscordId = null;
  }

  function showStep(n) {
    if (n === 1) {
      step1.removeAttribute("hidden");
      step2.setAttribute("hidden", "");
      step1Ind.classList.remove("gr-step-inactive");
      step2Ind.classList.add("gr-step-inactive");
    } else {
      step1.setAttribute("hidden", "");
      step2.removeAttribute("hidden");
      step1Ind.classList.add("gr-step-inactive");
      step2Ind.classList.remove("gr-step-inactive");
      codeInp.focus();
    }
  }

  function showErr(el, msg) {
    el.textContent = msg;
    el.hidden = false;
  }

  // Open / close
  getRoleBtn.addEventListener("click", openModal);
  closeBtn.addEventListener("click", closeModal);
  overlay.addEventListener("click", e => { if (e.target === overlay) closeModal(); });

  // Step 1: send code
  sendBtn.addEventListener("click", async () => {
    const id = discordIdInp.value.trim();
    err1.hidden = true;

    if (!id) { showErr(err1, "Please enter your Discord User ID."); return; }
    if (!/^\d{17,20}$/.test(id)) { showErr(err1, "Invalid Discord ID — it should be 17–20 digits."); return; }

    sendBtn.disabled    = true;
    sendBtnText.hidden  = true;
    sendSpinner.removeAttribute("hidden");

    try {
      const res  = await apiFetch("/api/discord/send-code", {
        method: "POST",
        body:   JSON.stringify({ discordId: id }),
      });
      const data = await res.json();

      if (!res.ok) { showErr(err1, data.error || "Failed to send code."); return; }

      pendingDiscordId = id;
      showStep(2);
    } catch (_) {
      showErr(err1, "Network error. Please try again.");
    } finally {
      sendBtn.disabled    = false;
      sendBtnText.hidden  = false;
      sendSpinner.setAttribute("hidden", "");
    }
  });

  // Step 2: back
  backBtn.addEventListener("click", () => {
    err2.hidden    = true;
    success.hidden = true;
    showStep(1);
  });

  // Step 2: verify
  verifyBtn.addEventListener("click", async () => {
    const code = codeInp.value.trim();
    err2.hidden    = true;
    success.hidden = true;

    if (!code) { showErr(err2, "Please enter the 6-digit code."); return; }
    if (!/^\d{6}$/.test(code)) { showErr(err2, "Code must be exactly 6 digits."); return; }

    verifyBtn.disabled    = true;
    verifyText.hidden     = true;
    verifySpinner.removeAttribute("hidden");

    try {
      const res  = await apiFetch("/api/discord/verify-code", {
        method: "POST",
        body:   JSON.stringify({ discordId: pendingDiscordId, code }),
      });
      const data = await res.json();

      if (!res.ok) { showErr(err2, data.error || "Verification failed."); return; }

      const rolesText = data.assigned && data.assigned.length
        ? data.assigned.join(", ")
        : "your roles";
      const failText  = data.failed && data.failed.length
        ? `  (Could not assign: ${data.failed.join(", ")})` : "";

      success.textContent = `✅ Roles assigned: ${rolesText}${failText}`;
      success.hidden      = false;
      codeInp.value       = "";

      // Auto-close after 3 seconds
      setTimeout(closeModal, 3500);
    } catch (_) {
      showErr(err2, "Network error. Please try again.");
    } finally {
      verifyBtn.disabled    = false;
      verifyText.hidden     = false;
      verifySpinner.setAttribute("hidden", "");
    }
  });

  // Allow pressing Enter in code field to submit
  codeInp.addEventListener("keydown", e => { if (e.key === "Enter") verifyBtn.click(); });
  discordIdInp.addEventListener("keydown", e => { if (e.key === "Enter") sendBtn.click(); });
})();

// ═══════════════════════════════════════════════════════════════════════════════
// PURCHASE MODAL — multi-step crypto payment flow
//   Step 1 → pick plan
//   Step 2 → pick coin (SOL / LTC)
//   Step 3 → show wallet + amount, accept TX hash
//   Step 4 → success screen with generated credentials
// ═══════════════════════════════════════════════════════════════════════════════
(() => {
  // ── DOM refs ─────────────────────────────────────────────────────────────
  const overlay      = document.getElementById("purchaseOverlay");
  const purchaseBtn  = document.getElementById("purchaseBtn");
  const closeBtn     = document.getElementById("purchaseClose");
  const modalTitle   = document.getElementById("purchaseModalTitle");

  const step1El = document.getElementById("puStep1");
  const step2El = document.getElementById("puStep2");
  const step3El = document.getElementById("puStep3");
  const step4El = document.getElementById("puStep4");

  const ind1 = document.getElementById("puInd1");
  const ind2 = document.getElementById("puInd2");
  const ind3 = document.getElementById("puInd3");

  // Step 2
  const planLabel  = document.getElementById("puSelectedPlanLabel");
  const priceSol   = document.getElementById("puPriceSol");
  const priceLtc   = document.getElementById("puPriceLtc");

  // Step 3
  const summaryPlan   = document.getElementById("puSummaryPlan");
  const summaryAmount = document.getElementById("puSummaryAmount");
  const summaryAddr   = document.getElementById("puSummaryAddr");
  const copyAddrBtn   = document.getElementById("puCopyAddr");
  const txHashInput   = document.getElementById("puTxHash");
  const verifyError   = document.getElementById("puVerifyError");
  const verifyBtn     = document.getElementById("puVerifyBtn");
  const verifyBtnText = document.getElementById("puVerifyBtnText");
  const verifySpinner = document.getElementById("puVerifySpinner");

  // Step 4
  const credUser      = document.getElementById("puCredUser");
  const credPass      = document.getElementById("puCredPass");
  const loginWithCreds= document.getElementById("puLoginWithCreds");

  // ── state ─────────────────────────────────────────────────────────────────
  let config    = null;  // fetched from /api/purchase/config
  let selPlan   = null;
  let selCoin   = null;
  let savedCreds= null;  // { username, password } after purchase

  const PLAN_NAMES = { small: "Small Plan", mid: "Mid Plan", high: "High Plan" };
  const COIN_NAMES = { sol: "SOL", ltc: "LTC" };

  // ── step navigation ───────────────────────────────────────────────────────
  function showStep(n) {
    [step1El, step2El, step3El, step4El].forEach((el, i) => {
      el.hidden = (i + 1 !== n);
    });
    [ind1, ind2, ind3].forEach((el, i) => {
      el.className = "pu-step " + (i + 1 <= n ? "pu-step-active" : "pu-step-inactive");
    });
    const titles = ["Choose a Plan", "Choose Payment Coin", "Send Payment", "Access Granted!"];
    modalTitle.textContent = titles[n - 1] || "Purchase";
  }

  // ── fetch config (prices + wallet addresses) ──────────────────────────────
  let configLoading = false;
  async function loadConfig() {
    if (configLoading) return;
    configLoading = true;
    try {
      const r = await fetch("/api/purchase/config");
      if (!r.ok) throw new Error("not configured");
      config = await r.json();
    } catch (_) {
      config = null;
    } finally {
      configLoading = false;
    }
  }
  // Eager load so prices are ready before the user opens the modal
  loadConfig();

  // ── open / close ──────────────────────────────────────────────────────────
  function openModal() {
    showStep(1);
    selPlan = selCoin = savedCreds = null;
    verifyError.hidden = true;
    txHashInput.value  = "";
    overlay.removeAttribute("hidden");
    if (!config) loadConfig(); // retry if eager load failed
  }
  function closeModal() { overlay.setAttribute("hidden", ""); }

  // Purchase system is disabled — show a "COMING SOON" notice instead of opening the modal
  purchaseBtn.addEventListener("click", () => {
    showToast("🚧 COMING SOON", "The purchase system is not available yet.");
  });
  closeBtn.addEventListener("click", closeModal);
  overlay.addEventListener("click", e => { if (e.target === overlay) closeModal(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !overlay.hidden) closeModal(); });

  // ── Step 1: plan selection ─────────────────────────────────────────────
  step1El.querySelectorAll(".plan-buy-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      selPlan = btn.dataset.plan;

      // Ensure config is loaded before showing prices
      if (!config) await loadConfig();

      planLabel.textContent = PLAN_NAMES[selPlan] || selPlan;

      if (config) {
        const ps = config.prices[selPlan];
        const ws = config.wallets;
        priceSol.textContent = (ps && ps.sol > 0 && ws.sol) ? `${ps.sol} SOL` : "—";
        priceLtc.textContent = (ps && ps.ltc > 0 && ws.ltc) ? `${ps.ltc} LTC` : "—";

        // Disable coin buttons if not configured
        step2El.querySelectorAll(".pu-coin-btn").forEach(cb => {
          const coin = cb.dataset.coin;
          const hasWallet = !!config.wallets[coin];
          const hasPrice  = config.prices[selPlan][coin] > 0;
          cb.disabled = !(hasWallet && hasPrice);
          cb.style.opacity = (hasWallet && hasPrice) ? "" : "0.35";
        });
      } else {
        priceSol.textContent = "N/A";
        priceLtc.textContent = "N/A";
      }

      showStep(2);
    });
  });

  // ── Step 2: coin selection ─────────────────────────────────────────────
  const coinErrorEl = document.getElementById("puCoinError");
  step2El.querySelectorAll(".pu-coin-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (btn.disabled) return;
      selCoin = btn.dataset.coin;

      // If config still null, try one more time before giving up
      if (!config) {
        await loadConfig();
      }
      if (!config) {
        coinErrorEl.textContent = "Could not load pricing info. Check that wallet addresses and prices are set in .env, then refresh.";
        coinErrorEl.hidden = false;
        return;
      }
      coinErrorEl.hidden = true;

      const price  = config.prices[selPlan][selCoin];
      const wallet = config.wallets[selCoin];
      const ticker = COIN_NAMES[selCoin];

      summaryPlan.textContent   = `${PLAN_NAMES[selPlan]} · ${ticker}`;
      summaryAmount.textContent = `${price} ${ticker}`;
      summaryAddr.textContent   = wallet;

      verifyError.hidden = true;
      txHashInput.value  = "";
      showStep(3);
    });
  });

  document.getElementById("puBackToStep1").addEventListener("click", () => showStep(1));
  document.getElementById("puBackToStep2").addEventListener("click", () => showStep(2));

  // ── Step 3: copy address ───────────────────────────────────────────────
  copyAddrBtn.addEventListener("click", () => {
    const addr = config && config.wallets[selCoin];
    if (!addr) return;
    navigator.clipboard.writeText(addr).then(() => {
      copyAddrBtn.classList.add("copied");
      setTimeout(() => copyAddrBtn.classList.remove("copied"), 1800);
    }).catch(() => {});
  });

  // ── Step 3: verify TX ──────────────────────────────────────────────────
  function showErr(msg) {
    verifyError.textContent = msg;
    verifyError.hidden = false;
  }

  verifyBtn.addEventListener("click", async () => {
    const hash = txHashInput.value.trim();
    if (!hash) { showErr("Please paste your transaction hash."); return; }

    verifyError.hidden   = true;
    verifyBtn.disabled   = true;
    verifyBtnText.hidden = true;
    verifySpinner.removeAttribute("hidden");

    try {
      const r = await fetch("/api/purchase/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ txHash: hash, coin: selCoin, plan: selPlan }),
      });
      const data = await r.json();

      if (!r.ok) { showErr(data.error || "Verification failed. Please try again."); return; }

      // Success — show credentials
      savedCreds = { username: data.username, password: data.password };
      credUser.textContent = data.username;
      credPass.textContent = data.password;
      showStep(4);

    } catch (_) {
      showErr("Network error. Please check your connection and try again.");
    } finally {
      verifyBtn.disabled   = false;
      verifyBtnText.hidden = false;
      verifySpinner.setAttribute("hidden", "");
    }
  });

  txHashInput.addEventListener("keydown", e => { if (e.key === "Enter") verifyBtn.click(); });

  // ── Step 4: copy credentials ───────────────────────────────────────────
  step4El.querySelectorAll(".pu-copy-cred").forEach(btn => {
    btn.addEventListener("click", () => {
      if (!savedCreds) return;
      const val = btn.dataset.copy === "user" ? savedCreds.username : savedCreds.password;
      navigator.clipboard.writeText(val).then(() => {
        btn.classList.add("copied");
        setTimeout(() => btn.classList.remove("copied"), 1800);
      }).catch(() => {});
    });
  });

  // ── Step 4: auto-fill login form + close modal ─────────────────────────
  loginWithCreds.addEventListener("click", () => {
    if (!savedCreds) { closeModal(); return; }
    // Pre-fill the sign-in form if it's visible
    const unEl = document.getElementById("loginUsername");
    const pwEl = document.getElementById("loginPassword");
    if (unEl) unEl.value = savedCreds.username;
    if (pwEl) pwEl.value = savedCreds.password;
    // Switch to sign-in tab if on redeem tab
    const signinTab = document.getElementById("tabSignin");
    if (signinTab) signinTab.click();
    closeModal();
  });
})();
