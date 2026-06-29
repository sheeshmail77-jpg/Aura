"use strict";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_PER_FEED = 80;

const feeds = {
  og: { list: document.getElementById("listOg"), empty: document.getElementById("emptyOg"), count: document.getElementById("countOg") },
  dragon: { list: document.getElementById("listDragon"), empty: document.getElementById("emptyDragon"), count: document.getElementById("countDragon") },
  small: { list: document.getElementById("listSmall"), empty: document.getElementById("emptySmall"), count: document.getElementById("countSmall") },
};
const statEls = {
  total: document.getElementById("statTotal"),
  og: document.getElementById("statOg"),
  dragon: document.getElementById("statDragon"),
  small: document.getElementById("statSmall"),
};
const connEl = document.getElementById("conn");
const connText = document.getElementById("connText");
const cardTpl = document.getElementById("cardTpl");

/** id -> { entry, el, agoEl } */
const items = new Map();

// ---------------- helpers ----------------
function feedOf(cat) { return feeds[cat] || feeds.small; }

function tierLabel(cat) {
  return cat === "og" ? "OG" : cat === "dragon" ? "DRAGON" : "SMALL";
}

function timeAgo(ms) {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 5) return "just now";
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
  statEls.total.textContent = stats.total ?? 0;
  statEls.og.textContent = stats.og ?? 0;
  statEls.dragon.textContent = stats.dragon ?? 0;
  statEls.small.textContent = stats.small ?? 0;
}

// Route an external image URL through the server-side proxy so browsers
// don't hit CORS / redirect-chain issues with wiki/CDN image sources
// (same reason Discord fetches thumbnails server-side for webhook embeds).
function proxyImg(url) {
  if (!url) return null;
  return "/api/img-proxy?url=" + encodeURIComponent(url);
}

// ---------------- rendering ----------------
function buildCard(entry) {
  const node = cardTpl.content.firstElementChild.cloneNode(true);
  node.dataset.cat = entry.category;
  node.dataset.id = entry.id;

  const animals = Array.isArray(entry.animals) && entry.animals.length ? entry.animals : [{ name: "?", mutation: "Normal" }];
  const primary = animals[0];

  // image — proxied through the server just like webhook thumbnail fetching
  const imgWrap = node.querySelector(".card-img");
  const img = imgWrap.querySelector("img");
  const rawImgUrl = entry.image || primary.image;
  if (rawImgUrl) {
    img.src = proxyImg(rawImgUrl);
    img.alt = primary.name;
    img.addEventListener("error", () => imgWrap.classList.add("broken"), { once: true });
  } else {
    imgWrap.classList.add("broken");
  }
  node.querySelector(".card-tier").textContent = tierLabel(entry.category);

  // title
  node.querySelector(".card-title").textContent =
    animals.length > 1 ? `${primary.name}  +${animals.length - 1}` : primary.name;

  // animal rows (name only shown when multiple)
  const rows = node.querySelector(".card-animals");
  animals.forEach((a) => {
    const row = document.createElement("div");
    row.className = "a-row";
    if (animals.length > 1) {
      const nm = document.createElement("span");
      nm.className = "a-name";
      nm.textContent = a.name;
      row.appendChild(nm);
    }
    const mut = document.createElement("span");
    if (isNormal(a.mutation)) {
      mut.className = "badge mut-normal";
      mut.textContent = "Normal";
    } else {
      mut.className = "badge mut";
      mut.textContent = a.mutation;
    }
    row.appendChild(mut);
    if (a.generation) {
      const gen = document.createElement("span");
      gen.className = "badge gen";
      gen.textContent = a.generation;
      row.appendChild(gen);
    }
    rows.appendChild(row);
  });

  // owner
  const owner = entry.owner || "?";
  node.querySelector(".owner-name").textContent = owner;
  const avaEl = node.querySelector(".owner-ava");
  const rawAva = entry.ownerAvatar;
  if (rawAva) {
    const avaImg = document.createElement("img");
    avaImg.src = proxyImg(rawAva);
    avaImg.alt = owner.charAt(0).toUpperCase();
    avaImg.style.cssText = "width:100%;height:100%;border-radius:50%;object-fit:cover;display:block;";
    avaImg.addEventListener("error", () => {
      avaImg.remove();
      avaEl.textContent = owner.charAt(0).toUpperCase();
    }, { once: true });
    avaEl.appendChild(avaImg);
  } else {
    avaEl.textContent = owner.charAt(0).toUpperCase();
  }

  // join button
  const join = node.querySelector(".join-btn");
  if (entry.joinLink) {
    join.href = entry.joinLink;
  } else {
    join.classList.add("disabled");
    join.removeAttribute("href");
  }

  const agoEl = node.querySelector(".ago");
  agoEl.textContent = timeAgo(entry.loggedAt || entry.receivedAt || Date.now());

  return { node, agoEl };
}

function addEntry(entry, isNew) {
  if (!entry || !entry.id || items.has(entry.id)) return;
  const when = entry.loggedAt || entry.receivedAt || Date.now();
  if (Date.now() - when > DAY_MS) return; // older than 24h, skip

  const feed = feedOf(entry.category);
  const { node, agoEl } = buildCard(entry);
  if (isNew) node.classList.add("flash");

  feed.list.insertBefore(node, feed.list.firstChild === feed.empty ? feed.empty.nextSibling : feed.list.firstChild);
  items.set(entry.id, { entry, el: node, agoEl });

  // cap per feed
  const cards = feed.list.querySelectorAll(".card");
  if (cards.length > MAX_PER_FEED) {
    const last = cards[cards.length - 1];
    const id = last.dataset.id;
    last.remove();
    items.delete(id);
  }
  setCounts();
}

function tickTimers() {
  const now = Date.now();
  for (const [id, it] of items) {
    const when = it.entry.loggedAt || it.entry.receivedAt;
    if (now - when > DAY_MS) {
      it.el.remove();
      items.delete(id);
      continue;
    }
    it.agoEl.textContent = timeAgo(when);
  }
  setCounts();
}

// ---------------- connection ----------------
function setConn(state) {
  connEl.classList.remove("live", "down");
  if (state === "live") { connEl.classList.add("live"); connText.textContent = "live"; }
  else if (state === "down") { connEl.classList.add("down"); connText.textContent = "reconnecting…"; }
  else { connText.textContent = "connecting…"; }
}

let ws = null;
let reconnectTimer = null;
let pollTimer = null;

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(loadSnapshot, 6000);
}
function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

async function loadSnapshot() {
  try {
    const r = await fetch("/api/logs", { cache: "no-store" });
    if (!r.ok) return;
    const data = await r.json();
    (data.logs || []).slice().reverse().forEach((e) => addEntry(e, false));
    updateStats(data.stats);
  } catch (_) {}
}

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const url = `${proto}://${location.host}/ws`;
  try { ws = new WebSocket(url); } catch (_) { scheduleReconnect(); return; }

  ws.addEventListener("open", () => {
    setConn("live");
    stopPolling();
  });

  ws.addEventListener("message", (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (_) { return; }
    if (msg.type === "init") {
      (msg.logs || []).slice().reverse().forEach((e) => addEntry(e, false));
      updateStats(msg.stats);
    } else if (msg.type === "log") {
      addEntry(msg.entry, true);
      updateStats(msg.stats);
    } else if (msg.type === "stats") {
      updateStats(msg.stats);
    }
  });

  ws.addEventListener("close", () => { setConn("down"); scheduleReconnect(); });
  ws.addEventListener("error", () => { try { ws.close(); } catch (_) {} });
}

function scheduleReconnect() {
  startPolling(); // keep data flowing while the socket is down
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 3000);
}

// ---------------- boot ----------------
setConn("connecting");
loadSnapshot();
connect();
setInterval(tickTimers, 1000);
