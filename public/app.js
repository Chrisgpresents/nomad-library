// Nomad Library: any BiblioCommons library's movies on one browsable shelf.
// The server only relays the library's catalog. Ratings, sorting and your lists
// all happen here in the browser, which keeps the site free to run.
import { readCatalogLink, searchLink, isReaderLib, readerId, readerCatalog, readerUrl } from "/catalog.js";

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const TOP_PAGES = 36;

// ---- state ------------------------------------------------------------------

const store = {
  get() { try { return JSON.parse(localStorage.getItem("nl") || "{}"); } catch { return {}; } },
  set(v) { try { localStorage.setItem("nl", JSON.stringify(v)); } catch {} },
};
let S = Object.assign({ lib: null, libName: "", fmt: "all", shelf: "all", sort: "", onShelf: false, faves: {}, watch: null,
  genres: [], coll: "", plat: "", y0: 0, y1: 0, minR: 0 }, store.get());
if (!Array.isArray(S.genres)) S.genres = [];
delete S.ages;                            // the age-rating filter (11.1.26) was taken back out
if ("genre" in S) {                       // saved before genres could be combined
  if (S.genre && !S.genres.length) S.genres = [S.genre];
  delete S.genre; store.set(S);
}
// Several library cards (Chris 11.1.26): every library someone opens is kept in S.libs ({ lib, name, guest? }), and
// MINE is the combined shelf of all the readable ones. Guest (unreadable) libraries join as "Check at" buttons.
const MINE = "mine";
if (!Array.isArray(S.libs)) S.libs = [];
let me = { uid: null, passkeys: 0 };
let saveTimer = null;

function save() {
  store.set(S);
  if (!me.uid) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 3000);
}
function flushSave() {
  if (!saveTimer) return;
  clearTimeout(saveTimer); saveTimer = null;
  if (!me.uid) return;
  fetch("/api/me", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ data: synced() }), keepalive: true })
    .catch(() => {});
}
addEventListener("pagehide", flushSave);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushSave(); });
const synced = () => ({ ...(S.demo ? {} : { lib: S.lib, libName: S.libName, ...(S.lib === "shelf" ? { guest: S.guest } : {}) }), libs: S.libs, fmt: S.fmt, faves: S.faves, watch: S.watch });

function toast(msg) {
  const t = document.createElement("div");
  t.className = "toast"; t.textContent = msg;
  document.body.append(t);
  setTimeout(() => t.remove(), 2600);
}

// ---- IMDb ratings, matched in the browser -------------------------------------

const ART = /^(the|a|an|le|la|les|el|los|il)\s+/i;
function norm(t) {
  t = String(t || "").toLowerCase().trim();
  t = t.replace(/\s*[:(\[].*$/, "").replace(/&/g, " and ").replace(/[^a-z0-9 ]+/g, " ").replace(ART, "");
  return t.replace(/\s+/g, " ").trim();
}
// Keeps the part after a colon: "Alien: Covenant" -> "alien covenant".
function normFull(t) {
  t = String(t || "").toLowerCase().replace(/\(.*?\)|\[.*?\]/g, " ").replace(/&/g, " and ").replace(/[^a-z0-9 ]+/g, " ").replace(ART, "");
  return t.replace(/\s+/g, " ").trim();
}
const shardKey = k => (k + "_").slice(0, 2).replace(/ /g, "_");
const shards = new Map();
function shard(k) {
  const s = shardKey(k);
  if (!shards.has(s)) shards.set(s, fetch(`/ix/${s}.json`).then(r => (r.ok ? r.json() : {})).catch(() => ({})));
  return shards.get(s);
}
// The library lists the DISC year (The Shining shows up as 2010), so the year is
// only a ceiling. Among what's left, the most-voted title wins.
function pick(c, { disc, tv, year }) {
  if (!c?.length) return null;
  if (year) { const e = c.filter(r => Math.abs(r[3] - year) <= 1); if (e.length) c = e; }
  else if (disc) {
    const ok = c.filter(r => !r[3] || r[3] <= disc + 1); if (ok.length) c = ok;
    const recent = c.filter(r => r[3] && disc - r[3] <= 2 && r[2] >= c[0][2] * 0.15);
    if (recent.length) c = recent;
  }
  const typed = c.filter(r => r[4] === (tv ? "s" : "m"));
  if (typed.length && typed[0][2] >= c[0][2] * 0.2) c = typed;
  const r = c[0];
  return { imdb: r[0], r: r[1], v: r[2], fy: r[3] || null };
}
const EDITION = /edition|widescreen|full ?screen|collector|anniversary|season|series|volume|vol\.|director|cut|remaster|restored|special|deluxe|criterion|blu-?ray|dvd|4k|uhd|motion picture|film|movie/i;
async function rate(rows) {
  await Promise.all(rows.map(async row => {
    if (row.imdb !== undefined) return;
    const k = norm(row.title);
    row.imdb = null;
    if (!k) return;
    const sub = (row.sub || "").replace(/\s*\/.*$/, "").trim();
    const tail = [row.title.includes(":") ? row.title.split(":").slice(1).join(" ") : "", sub].join(" ").trim();
    if (tail) {
      const k2 = normFull(row.title + " " + sub);
      const m2 = pick((await shard(k2))[k2], { disc: row.disc, tv: row.tv });
      if (m2) return Object.assign(row, m2);
      // "Star Wars: The Mandalorian and Grogu" is not Star Wars. Only edition notes fall back.
      if (!EDITION.test(tail)) return;
    }
    const m = pick((await shard(k))[k], { disc: row.disc, tv: row.tv });
    if (m) Object.assign(row, m);
  }));
  return rows;
}

// ---- api ----------------------------------------------------------------------

const BUSY = "Nomad Library is extra busy right now. Please try again in a little while.";
async function api(path, opts) {
  let r;
  try { r = await fetch(path, { signal: AbortSignal.timeout(20000), ...opts }); }
  catch (e) { throw Object.assign(new Error(e.name === "TimeoutError" ? "That request took too long. Please try again." : "You seem to be offline. Check your connection and try again."), { data: {} }); }
  const d = await r.json().catch(() => null);
  if (!d) throw Object.assign(new Error(r.status >= 500 || r.status === 429 ? BUSY : "Something went wrong. Try again."), { data: {}, status: r.status });
  if (!r.ok) {
    // A passkey whose account is gone: ask the device to forget it, where browsers support that.
    if (d.unknown && window.PublicKeyCredential?.signalUnknownCredential)
      PublicKeyCredential.signalUnknownCredential({ rpId: d.rpID, credentialId: d.unknown }).catch(() => {});
    throw Object.assign(new Error(d.error || "Something went wrong. Try again."), { data: d, status: r.status });
  }
  return d;
}
const searchUrl = (page, sort) => {
  const p = new URLSearchParams({ lib: S.lib, fmt: S.fmt, shelf: S.shelf, page, sort: sort ?? S.sort });
  const q = $("#q").value.trim();
  if (q) p.set("q", q);
  return "/api/search?" + p;
};

// ---- rendering ----------------------------------------------------------------

const favKey = r => `${r.lib || S.lib}:${r.rid || r.id}`;
const isFav = r => !!S.faves[favKey(r)];
const filmYear = r => r.fy || r.disc || "";

const badgeHTML = r => (r.r && r.v >= 50 ? `<span class="badge"><b>★</b> ${r.r.toFixed(1)}</span>` : "");
// Guest mode: the visitor's library is one we cannot read yet, so they browse the nationwide shelf and check titles at their library.
const GUEST = "shelf";
const isGuest = () => S.lib === GUEST;
const isMine = () => S.lib === MINE;
// no shelf status to show: guests, and copies from catalogs that don't report it (snap "na", e.g. older LS2 PAC)
const noAvail = () => isGuest() || (!isMine() && SNAP?.lib === S.lib && !!SNAP?.na);
const libKey = e => e.lib === GUEST ? "shelf:" + (e.guest?.catalog?.host || e.guest?.host || e.name || "") : e.lib;
const readableLibs = () => S.libs.filter(e => e.lib !== GUEST);
const guestLibs = () => S.libs.filter(e => e.lib === GUEST && e.guest?.catalog?.url);
const shortName = n => String(n || "").replace(/^the\s+/i, "").replace(/\s+(public|county|free|city|regional|district|area)?\s*(public\s+)?library.*$/i, "").trim() || n;
const libUrlOf = lib => S.libs.find(e => e.lib === lib)?.url || (lib === S.lib ? S.libUrl : "") || "";
const libNameOf = lib => S.libs.find(e => e.lib === lib)?.name || (lib === S.lib ? S.libName : lib);
// The library being shown joins the saved list (Seattle's "try it" demo never does).
function rememberLib() {
  if (!S.lib || S.demo || isMine()) return;
  const e = { lib: S.lib, name: S.libName || "" };
  if (isGuest()) e.guest = S.guest || {};
  if (isReaderLib(S.lib) && (S.libUrl || libUrlOf(S.lib))) e.url = S.libUrl || libUrlOf(S.lib);
  const k = libKey(e), i = S.libs.findIndex(x => libKey(x) === k);
  if (i >= 0) S.libs[i] = e; else S.libs.push(e);
  if (S.libs.length > 8) S.libs = S.libs.slice(-8);
}
if (!S.libs.length && S.lib && !S.demo && S.lib !== MINE) rememberLib();
// The visitor's catalog: { url, host, system, find }. Older saves kept only a host and a system name.
const OLD_SYSTEMS = { "Aspen Discovery": "aspen", "Evergreen": "evergreen", "Koha": "koha", "Sierra Encore": "encore" };
function guestCatalog() {
  const g = S.guest || {};
  if (g.catalog?.url) return g.catalog;
  return g.host ? readCatalogLink("https://" + g.host, OLD_SYSTEMS[g.vendor] || "") : null;
}
const libLabel = () => S.libName || "your library";
// Searches the visitor's own catalog for the title. Their browser opens it, so catalogs that block other websites still work.
const checkUrl = r => searchLink(guestCatalog(), r.title);
function cardHTML(r) {
  const rating = badgeHTML(r);
  const cover = r.img
    ? `<img loading="lazy" src="${esc(r.img)}" alt="" onload="if(this.naturalWidth<20)this.onerror()" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'noimg',textContent:${esc(JSON.stringify(r.title))}}))">`
    : `<span class="noimg">${esc(r.title)}</span>`;
  const where = isMine() && r.avail ? [...new Set((r.eds || [r]).filter(e => e.avail).map(e => e.lib))] : [];
  const av = noAvail() ? "" : r.avail ? `<span class="avail in">On the shelf${where.length > 1 ? ` at ${where.length} libraries` : where.length ? ` at ${esc(shortName(libNameOf(where[0])))}` : ""}</span>`
    : `<span class="avail out">All out${r.holds ? ` · ${r.holds} hold${r.holds > 1 ? "s" : ""}` : ""}</span>`;
  return `<div class="card" data-id="${esc(r.id)}">
    <button class="cover" data-open="${esc(r.id)}" aria-label="${esc(r.title)}">${cover}${rating}</button>
    <button class="heart" data-fav="${esc(r.id)}" aria-pressed="${isFav(r)}" aria-label="Favorite">${isFav(r) ? "♥" : "♡"}</button>
    <div class="ttl">${esc(r.title)}${r.tv && r.sub ? `<span class="tsub">${esc(r.sub)}</span>` : ""}</div>
    <div class="meta">${r.f === "g" ? esc(r.plat || r.disc || "") : esc(filmYear(r))}${isGuest() ? "" : ` · ${esc(r.fmts || r.fmt)}`}</div>
    ${av}
  </div>`;
}

const rowsById = new Map();
function remember(rows) { for (const r of rows) rowsById.set(r.id, r); return rows; }

// One card per film: the library often has the DVD, the Blu-ray and a reissue as separate records.
const filmKey = r => norm(r.title) + "|" + (r.imdb || r.disc || "") + "|" + (r.tv ? norm(r.sub) : "");
function edition(r) { return { id: r.id, rid: r.rid || r.id, lib: r.lib || S.lib, fmt: r.fmt, url: r.url, avail: r.avail, copies: r.copies, total: r.total, holds: r.holds, img: r.img, disc: r.disc }; }
function absorb(into, r) {
  into.eds = into.eds || [edition(into)];
  if (into.eds.some(e => e.id === r.id)) return;
  into.eds.push(edition(r));
  into.avail = into.eds.some(e => e.avail);
  into.holds = into.eds.reduce((n, e) => n + (e.holds || 0), 0);
  into.fmts = [...new Set(into.eds.map(e => e.fmt))].sort().reverse().join(" + ");
  into.fs = (into.fs || into.f || "") + (r.f || "");
  if (!into.img && r.img) into.img = r.img;
  rowsById.set(r.id, into);
}
function merge(rows, seen) {
  const out = [];
  for (const r of rows) {
    const k = filmKey(r);
    if (seen.has(k)) { absorb(seen.get(k), r); continue; }
    seen.set(k, r); out.push(r);
  }
  return out;
}

function openDetail(r) {
  const yearNote = r.fy && r.disc && r.fy !== r.disc && !isGuest() ? `<b>${r.fy}</b> film, ${r.disc} disc` : `<b>${esc(filmYear(r))}</b>`;
  const fmtLabel = isGuest() ? "" : r.fmts || r.fmt;
  const imdb = r.imdb ? `<a class="btn ghost" href="https://www.imdb.com/title/${esc(r.imdb)}/" target="_blank" rel="noopener noreferrer">IMDb ${r.r ? r.r.toFixed(1) : ""}</a>` : "";
  const av = r.avail ? `<b style="color:var(--ok)">On the shelf</b>${r.eds || r.copies == null ? "" : ` · ${r.copies} of ${r.total} in`}`
    : `<b style="color:var(--stamp)">All checked out</b>${r.holds ? ` · ${r.holds} on hold` : ""}`;
  $("#detailBody").innerHTML = `<div class="in">
    <button class="x" data-close aria-label="Close">×</button>
    <div class="d">
      <div class="cover">${r.img ? `<img src="${esc(r.img)}" alt="">` : `<span class="noimg">${esc(r.title)}</span>`}</div>
      <div>
        <h2>${esc(r.title)}</h2>
        ${r.sub ? `<p class="sub">${esc(r.sub)}</p>` : ""}
        <div class="facts">${r.f === "g" ? esc(r.plat || "") || yearNote : yearNote}${fmtLabel ? ` · ${esc(fmtLabel)}` : ""}${r.r ? ` · <b>★ ${r.r.toFixed(1)}</b> from ${Number(r.v).toLocaleString()} votes` : ""}${noAvail() ? "" : `<br><span id="liveAv">${av}</span>`}</div>
        <p id="detailSynopsis">${r.desc ? esc(r.desc) : isGuest() ? (r.imdb ? `<a href="https://www.imdb.com/title/${esc(r.imdb)}/" target="_blank" rel="noopener noreferrer">Read the synopsis on IMDb</a>` : "") : `<a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">Read the synopsis at your library</a>`}</p>
        ${(r.eds && r.eds.length > 1 || isMine()) && !isGuest() ? `<div class="facts" id="edList">${editionsHTML(r)}</div>` : ""}
        <div class="actions">
          ${isGuest()
            ? (checkUrl(r) ? `<a class="btn" href="${esc(checkUrl(r))}" target="_blank" rel="noopener noreferrer">Check at ${esc(libLabel())}</a>`
              : `<button class="btn" type="button" id="addCatalog">Check at your library</button>`)
            : isMine() ? holdButtons(r)
            : `<a class="btn" href="${esc((r.eds?.find(e => e.avail) || r).url)}" target="_blank" rel="noopener noreferrer">${noAvail() ? `See it at ${esc(shortName(libLabel()))}` : r.avail ? "Place a hold" : "Get in line"}</a>`}
          ${isMine() ? guestLibs().map(e => `<a class="btn ghost" href="${esc(searchLink(e.guest.catalog, r.title))}" target="_blank" rel="noopener noreferrer">Check at ${esc(shortName(e.name) || "your other library")}</a>`).join("") : ""}
          <a class="btn ghost" href="/t?q=${encodeURIComponent(r.title + " " + (r.fy || ""))}" target="_blank" rel="noopener noreferrer" data-trailer>Trailer</a>
          ${imdb}
          <button class="btn ghost" data-fav="${esc(r.id)}">${isFav(r) ? "♥ Saved" : "♡ Save"}</button>
        </div>
      </div>
    </div></div>`;
  $("#detail").showModal();
  const detailLib = S.lib;
  if (!r.desc && r.f !== "g" && !isGuest() && !isReaderLib((r.eds?.[0] || r).lib || detailLib)) {
    const p = new URLSearchParams({ lib: (r.eds?.[0] || r).lib || detailLib, q: r.title, fmt: "all", page: "1" });
    api("/api/search?" + p).then(d => {
      const ids = new Set((r.eds || [r]).map(e => e.rid || e.id));
      const match = d.rows.find(row => ids.has(row.id) && row.desc);
      if (!match) return;
      r.desc = match.desc;
      if ($("#detail").open && S.lib === detailLib && $("#detailBody").dataset.record === r.id)
        $("#detailSynopsis").textContent = r.desc;
    }).catch(() => {});
  }
  $("#detailBody").dataset.record = r.id;
  if (!isGuest()) liveStatus(r);
}

// One line per edition; in the combined view they're grouped under each library's name.
function editionsHTML(r) {
  const eds = r.eds || [edition(r)];
  const line = e => `<a href="${esc(e.url)}" target="_blank" rel="noopener noreferrer">${esc(e.fmt)}${e.disc ? ` (${e.disc})` : ""}</a>: ${e.avail ? `<b style="color:var(--ok)">${e.copies == null ? "on the shelf" : `${e.copies} in`}</b>` : `all out${e.holds ? `, ${e.holds} holds` : ""}`}`;
  if (!isMine()) return eds.map(line).join("<br>");
  const libs = [...new Set(eds.map(e => e.lib))];
  return libs.map(l => `<b>${esc(libNameOf(l))}</b><br>${eds.filter(e => e.lib === l).map(line).join("<br>")}`).join("<br>");
}
function holdButtons(r) {
  const eds = r.eds || [edition(r)];
  return [...new Set(eds.map(e => e.lib))].map(l => {
    const mine = eds.filter(e => e.lib === l), e = mine.find(x => x.avail) || mine[0];
    return `<a class="btn" href="${esc(e.url)}" target="_blank" rel="noopener noreferrer">${e.avail ? "Place a hold" : "Get in line"} at ${esc(shortName(libNameOf(l)))}</a>`;
  }).join("");
}

// The weekly copy can't know what's on the shelf right now, so the movie page asks the library.
async function liveStatus(r) {
  const lib = S.lib;
  const eds = r.eds || [r];
  try {
    const byLib = new Map();
    // libraries we copy ourselves (Vega...) have no live check yet: their copy's shelf status stands
    for (const e of eds.slice(0, 8)) { const l = e.lib || S.lib; if (isReaderLib(l)) continue; if (!byLib.has(l)) byLib.set(l, []); byLib.get(l).push(e); }
    if (!byLib.size) return;
    const d = {};
    await Promise.all([...byLib].map(async ([l, list]) => {
      const got = await api(`/api/avail?lib=${encodeURIComponent(l)}&ids=${list.map(e => e.rid || e.id).join(",")}`).catch(() => ({}));
      for (const e of list) if (got[e.rid || e.id]) d[e.id] = got[e.rid || e.id];
    }));
    let any = false, copies = 0, total = 0, holds = 0;
    for (const e of eds) { const a = d[e.id]; if (!a) continue; Object.assign(e, a); any = any || a.avail; copies += a.copies; total += a.total; holds += a.holds; }
    if (!Object.keys(d).length) return;
    Object.assign(r, { avail: any, copies, total, holds });
    if (!$("#detail").open || S.lib !== lib || $("#detailBody").dataset.record !== r.id) return;
    const el = $("#liveAv");
    if (el) el.innerHTML = any ? `<b style="color:var(--ok)">On the shelf right now</b> · ${copies} of ${total} in`
      : `<b style="color:var(--stamp)">All checked out right now</b>${holds ? ` · ${holds} on hold` : ""}`;
    const eh = $("#edList");
    if (eh) eh.innerHTML = editionsHTML(r);
    const card = $("#grid").querySelector(`.card[data-id="${CSS.escape(r.id)}"]`);
    if (card) card.outerHTML = cardHTML(r);
  } catch {}
}

function toggleFav(id) {
  const r = rowsById.get(id);
  if (!r) return;
  const k = favKey(r);
  if (S.faves[k]) delete S.faves[k];
  else S.faves[k] = { ...r, lib: r.lib || S.lib, added: Date.now() };
  save();
  document.querySelectorAll(`[data-fav="${CSS.escape(id)}"]`).forEach(b => {
    b.setAttribute("aria-pressed", isFav(r));
    b.textContent = b.classList.contains("heart") ? (isFav(r) ? "♥" : "♡") : (isFav(r) ? "♥ Saved" : "♡ Save");
  });
  counts();
  if (!me.uid && Object.keys(S.faves).length === 3 && !S.nudged) {
    S.nudged = true; store.set(S);
    toast("Make a free account to keep your favorites on every device.");
  }
}

const favHere = x => isMine() ? readableLibs().some(e => e.lib === x.lib) : x.lib === S.lib;
function counts() {
  const f = Object.values(S.faves).filter(favHere).length;
  $("#favCount").textContent = f ? f : "";
  const w = isMine() ? mineWatch() : S.watch?.matches?.[S.lib];
  $("#wlCount").textContent = isGuest() ? (S.watch?.items?.length || "") : w ? w.filter(x => x.hits.length).length : "";
}

// ---- browsing -----------------------------------------------------------------

let run = 0, page = 0, pages = 1, loading = false, topRows = null, seen = new Map();

function visible(rows) {
  return rows.filter(r => {
    if (S.onShelf && !r.avail) return false;
    if (S.fmt === "games") return !S.plat || r.plat === S.plat;
    if (S.genres.includes("movies") && isTV(r)) return false;
    const year = r.fy || r.disc;
    return (!S.y0 || year >= S.y0) && (!S.y1 || (year && year <= S.y1)) &&
      (!S.minR || (r.r >= S.minR && r.v >= 500));
  });
}

async function liveReload() {
  const my = ++run;
  page = 0; pages = 1; topRows = null; seen = new Map();
  $("#grid").innerHTML = "";
  $("#status").textContent = "Loading…";
  $("#more").textContent = "";
  if (S.sort === "top") return loadTop(my);
  await liveMore(my);
}

async function liveMore(my = run, fillPages = 0) {
  // One request at a time per view. A newer view never waits on an older one.
  if (loading === my || page >= pages || S.sort === "top") return;
  loading = my;
  let failed = false;
  try {
    const d = await api(searchUrl(page + 1));
    if (my !== run) return;
    page = d.page; pages = d.pages;
    remember(d.rows);
    if (S.fmt !== "games" && (S.minR || S.y0 || S.y1)) {
      await rate(d.rows);
      if (my !== run) return;
    }
    // Covers go up right away. Ratings fill in a moment later, then duplicate editions fold together.
    const shown = visible(d.rows);
    $("#grid").insertAdjacentHTML("beforeend", shown.map(cardHTML).join(""));
    rate(d.rows).then(() => {
      if (my !== run) return;
      const keep = new Set(merge(d.rows, seen).map(r => r.id));
      for (const r of shown) {
        const card = $("#grid").querySelector(`.card[data-id="${CSS.escape(r.id)}"]`);
        if (!card) continue;
        if (!keep.has(r.id)) { card.remove(); continue; }
        card.outerHTML = cardHTML(r);
      }
    });
    const localFilters = S.onShelf || S.plat || S.minR || S.y0 || S.y1;
    $("#status").innerHTML = esc(d.total ? (localFilters ? `${$("#grid").children.length.toLocaleString()} matches loaded · ${d.total.toLocaleString()} catalog results` : `${d.total.toLocaleString()} titles`) : "Nothing here at this library.") + liveNote();
    paintCopyToast();
    $("#more").textContent = page < pages ? "Loading more…" : (d.total ? "That's the whole shelf." : "");
  } catch (e) {
    failed = true;
    if (my === run) { $("#status").textContent = e.message; $("#more").innerHTML = '<button class="link" id="retryMore">Try again</button>'; }
  } finally { if (loading === my) loading = false; }
  // keep filling a short first screen, but never after a failure (that would retry forever)
  if (!failed && my === run && page < pages && $("#grid").children.length < 12) {
    if (fillPages < 2) liveMore(my, fillPages + 1);
    else $("#more").innerHTML = '<button class="link" id="retryMore">Load more results</button>';
  }
}

// Rank a whole shelf by IMDb rating, pulling its pages a few at a time.
async function loadTop(my) {
  try {
    const first = await api(searchUrl(1, ""));
    if (my !== run) return;
    const n = Math.min(TOP_PAGES, first.pages);
    const all = remember(first.rows);
    const draw = () => {
      const films = merge(all, new Map());
      const sorted = films.sort((a, b) => ((b.v >= 1000) - (a.v >= 1000)) || ((b.r || 0) - (a.r || 0)) || ((b.v || 0) - (a.v || 0)));
      $("#grid").innerHTML = visible(sorted).slice(0, 300).map(cardHTML).join("");
    };
    await rate(all); draw();
    let p = 2;
    const worker = async () => {
      while (p <= n && my === run) {
        const mine = p++;
        try { const d = await api(searchUrl(mine, "")); all.push(...remember(d.rows)); } catch {}
        $("#status").textContent = `Ranking ${all.length.toLocaleString()} of ${Math.min(first.total, n * 25).toLocaleString()} titles…`;
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    if (my !== run) return;
    await rate(all); draw();
    $("#status").textContent = first.total > all.length
      ? `Top rated among the first ${all.length.toLocaleString()} of ${first.total.toLocaleString()} titles${S.shelf === "all" && !$("#q").value.trim() ? ". Pick a genre to rank a smaller shelf." : "."}`
      : `${first.total.toLocaleString()} titles, best rated first`;
    $("#more").textContent = "";
  } catch (e) { if (my === run) $("#status").textContent = e.message; }
}

// ---- instant mode: the library's weekly copy, filtered and sorted in the browser --------

const GENRES = [
  ["horror", "Horror", "horror"], ["comedy", "Comedy", "comedy"], ["romcom", "Rom-com", "romcom"], ["scifi", "Sci-fi", "scifi"],
  ["action", "Action", "action"], ["thriller", "Thriller", "suspense"], ["crime", "Crime", "crime"], ["drama", "Drama", "drama"],
  ["animation", "Animation", "animation"], ["family", "Family", "family"], ["fantasy", "Fantasy", "fantasy"], ["romance", "Romance", "romance"],
  ["documentary", "Documentary", "documentary"], ["foreign", "Foreign", "foreign"], ["western", "Western", "western"],
  ["war", "War", "war"], ["musical", "Musical", "musical"], ["superhero", "Superhero", "superhero"], ["biography", "Biography", "biography"],
  ["history", "History", "history"], ["sports", "Sports", "sports"], ["tv", "TV shows", "tv"], ["movies", "Movies only", ""],
];
// Picked genres widen the shelf (horror or thriller); Foreign, TV shows and Movies only narrow it (foreign horror).
const NARROW = new Set(["foreign", "tv", "movies"]);
const isTV = r => !!r.tv || (r.genres || []).includes("tv");
function genreMatch(r) {
  if (!S.genres.length) return true;
  if (S.genres.includes("movies") && isTV(r)) return false;
  const wide = S.genres.filter(g => !NARROW.has(g));
  return S.genres.every(g => !NARROW.has(g) || g === "movies" || r.genres.includes(g)) && (!wide.length || wide.some(g => r.genres.includes(g)));
}
// ---- search: titles, genres, actors and directors -------------------------------
// Typed genre words match the genre ("horror", "scary movies", "kids"). Names match through ix/people/<xx>.json:
// every name is filed under the first 2 letters of each of its words, with the IMDb ids of the films it's in.
const GENRE_WORDS = { horror: "horror", scary: "horror", comedy: "comedy", comedies: "comedy", funny: "comedy", romcom: "romcom",
  scifi: "scifi", action: "action", thriller: "thriller", thrillers: "thriller", suspense: "thriller", crime: "crime", drama: "drama",
  dramas: "drama", animation: "animation", animated: "animation", cartoon: "animation", cartoons: "animation", anime: "animation",
  family: "family", kids: "family", fantasy: "fantasy", romance: "romance", romantic: "romance", documentary: "documentary",
  documentaries: "documentary", foreign: "foreign", western: "western", westerns: "western", war: "war", musical: "musical",
  musicals: "musical", superhero: "superhero", superheroes: "superhero", biography: "biography", biopic: "biography", biopics: "biography",
  history: "history", historical: "history", sports: "sports", sport: "sports", tv: "tv" };
const STOP = new Set(["the", "a", "an", "and", "of", "in", "on", "to", "with", "for", "movie", "movies", "film", "films", "show", "shows"]);
const queryWords = text => norm(String(text || "").replace(/science fiction|sci[\s-]+fi/gi, "scifi").replace(/rom[\s-]+com/gi, "romcom"))
  .split(" ").filter(Boolean);
const imdbNum = r => (r.imdb ? +String(r.imdb).replace(/\D+/g, "") : 0);
const peopleShards = new Map(), peopleWords = new Map();
function peopleShard(k) {
  if (!peopleShards.has(k)) peopleShards.set(k, fetch(`/ix/people/${encodeURIComponent(k)}.json`)
    .then(r => r.ok && /json/.test(r.headers.get("content-type") || "") ? r.json() : {}).catch(() => ({})));
  return peopleShards.get(k);
}
// Films of everyone whose name has a word starting with w ("spiel" finds Steven Spielberg).
async function peopleFor(w) {
  if (peopleWords.has(w)) return peopleWords.get(w);
  const d = await peopleShard(w.slice(0, 2)), films = new Set();
  for (const name in d) if ((" " + name).includes(" " + w)) for (const t of d[name]) films.add(t);
  peopleWords.set(w, films);
  return films;
}
const nameWord = w => w.length >= 2 && !STOP.has(w) && !GENRE_WORDS[w];
let QP = { q: "", sets: new Map() };
// Loads the name files the current search needs, before the shelf filters by it.
async function prepQuery() {
  const q = $("#q").value.trim();
  if (QP.q === q) return;
  const sets = new Map();
  await Promise.all(queryWords(q).filter(nameWord).map(async w => sets.set(w, await peopleFor(w))));
  QP = { q, sets };
}
function queryMatch(r, words) {
  const t = norm(r.title + " " + r.sub);
  if (words.every(w => t.includes(w))) return true;
  const n = imdbNum(r), g = r.genres || [];
  let named = false;
  for (const w of words) {
    if (t.includes(w) || (GENRE_WORDS[w] && g.includes(GENRE_WORDS[w]))) continue;
    const set = QP.sets.get(w);
    if (set && n && set.has(n)) { named = true; continue; }
    if (!nameWord(w)) continue;      // "the", "of": only ever needed for titles
    return false;
  }
  return named || words.some(w => GENRE_WORDS[w] && g.includes(GENRE_WORDS[w]));
}

const COLLECTIONS = [["mustsee", "1001 must-sees"], ["oscar", "Oscar winners"], ["registry", "Film Registry"], ["criterion", "Criterion"], ["ghibli", "Studio Ghibli"]];
const FMT_NAME = { b: "Blu-ray", d: "DVD", g: "Game" };
const YEAR_MIN = 1920, YEAR_MAX = new Date().getFullYear();
const PER = 60;

let SNAP = null, snapList = [], snapShown = 0, liveQ = false;

// Row layout from the crawler:
// [id, title, sub, fmt, discYear, cover, onShelf, holds, genres, tv, platform, rating, votes, imdb, filmYear]
const coverUrl = (c, sc) => {
  if (!c || c[0] !== "~") return c || null;
  const [, isbn, upc, oclc] = c.split("~");
  return `https://secure.syndetics.com/index.aspx?isbn=${isbn}/MC.GIF&client=${encodeURIComponent(sc)}&type=xw12&oclc=${oclc}&upc=${upc}`;
};
function fromRow(x, lib, sc, rec) {
  return {
    id: x[0], title: x[1], sub: x[2], f: x[3], fmt: FMT_NAME[x[3]], disc: x[4] || null, img: coverUrl(x[5], sc),
    avail: !!x[6], holds: x[7], genres: x[8] ? x[8].split(",") : [], tv: !!x[9], plat: x[10],
    r: x[11] || 0, v: x[12] || 0, imdb: x[13] || null, fy: x[14] || null,
    url: rec ? rec.replace("{id}", encodeURIComponent(x[0])) : `https://${lib}.bibliocommons.com/v2/record/${x[0]}`, n: +String(x[0]).replace(/\D+/g, "").slice(-9) || 0, lib,
  };
}

// ---- opening a library: a copy kept on this device, else a plain static file, else browsing live ----------
// Library copies are static files (made by GitHub, see the nomad-library-data repo), so opening one is a download
// with no server work. This device keeps its own copy and uses it at once, however old; a newer one is fetched
// in the background. If nothing is ready quickly, the shelf starts browsing live and the copy joins in later.
const SNAP_BASE = "https://nomad-library-copies.pages.dev/snap/";
const LIVE_AFTER_MS = 1800;      // no usable copy by then: start browsing live while the download continues
const FETCH_MS = 60000;          // hard stop for a copy download
const KEEP_COPIES = 6;           // copies kept on this device, least recently used go first
const REFRESH_AFTER = 12 * 36e5; // a device copy older than this is refreshed in the background

function validSnap(d) {
  if (!d || !Array.isArray(d.rows) || !d.rows.length || d.rows.length > 400000 || !Number.isFinite(d.finished)) return false;
  for (const i of [0, d.rows.length >> 1, d.rows.length - 1]) { const r = d.rows[i]; if (!Array.isArray(r) || r.length !== 15 || typeof r[0] !== "string") return false; }
  return true;
}

// Storage on this device. Every call is bounded and optional: if IndexedDB is missing, blocked or full, the site
// still works, it just downloads the copy again next time.
let idbState = null;
function idb() {
  if (!idbState) idbState = new Promise((res, rej) => {
    let o;
    try { o = indexedDB.open("nl-snaps", 1); } catch (e) { return rej(e); }
    const t = setTimeout(() => rej(new Error("storage did not open")), 2500);
    o.onupgradeneeded = () => o.result.createObjectStore("s");
    o.onsuccess = () => { clearTimeout(t); res(o.result); };
    o.onerror = o.onblocked = () => { clearTimeout(t); rej(o.error || new Error("storage blocked")); };
  });
  return idbState;
}
const idbReq = (store, mode, fn) => idb().then(db => new Promise((res, rej) => {
  const tx = db.transaction(store, mode), r = fn(tx.objectStore(store));
  tx.oncomplete = () => res(r && r.result); tx.onerror = tx.onabort = () => rej(tx.error || new Error("storage failed"));
}));
async function idbGet(lib) {
  try {
    const rec = await idbReq("s", "readonly", st => st.get(lib));
    if (!rec || !validSnap(rec.d)) return null;     // a damaged copy is ignored, never shown
    idbReq("s", "readwrite", st => { const q = st.get("__use"); q.onsuccess = () => st.put({ ...(q.result || {}), [lib]: Date.now() }, "__use"); }).catch(() => {});
    return rec;
  } catch { return null; }
}
async function idbPut(lib, d) {
  try {
    const use = (await idbReq("s", "readonly", st => st.get("__use"))) || {};
    use[lib] = Date.now();
    const old = Object.keys(use).sort((a, b) => use[b] - use[a]).slice(KEEP_COPIES);
    for (const k of old) delete use[k];
    await idbReq("s", "readwrite", st => { st.put({ saved: Date.now(), d }, lib); st.put(use, "__use"); for (const k of old) st.delete(k); });
  } catch { /* full or unavailable: skip, the last good copy (if any) stays */ }
}

async function gunzip(buf) {
  if (typeof DecompressionStream === "undefined") throw new Error("this browser cannot unpack copies");
  return new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
}
// -> { d } on success, { missing: true } when the host has no copy, throws on anything else
async function fetchStatic(lib) {
  const r = await fetch(lib === GUEST ? "/shelf.json" : SNAP_BASE + encodeURIComponent(lib) + ".json.gz", { cache: "no-cache", signal: AbortSignal.timeout ? AbortSignal.timeout(FETCH_MS) : undefined });
  if (r.status === 404) return { missing: true };
  if (!r.ok) throw new Error("copy host answered " + r.status);
  const buf = new Uint8Array(await r.arrayBuffer());
  const d = JSON.parse(buf[0] === 0x1f && buf[1] === 0x8b ? await gunzip(buf) : new TextDecoder().decode(buf));
  if (!validSnap(d)) throw new Error("the copy did not pass checks");
  return { d };
}

// Tell the copier this library is wanted. At most once per library per day per device, never in a loop.
const wantSent = new Set();
function wantCopy(lib, name, url) {
  if (lib === GUEST || wantSent.has(lib)) return;
  wantSent.add(lib);
  let last = 0;
  try { last = +localStorage.getItem("nl-want-" + lib) || 0; } catch {}
  if (Date.now() - last < 864e5) return;
  fetch("/api/want", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ lib, ...(isReaderLib(lib) ? { name: name || libNameOf(lib) || "", url: url || libUrlOf(lib) } : {}) }), keepalive: true })
    .then(async r => {
      if (!r.ok) throw new Error("copy request failed");
      const d = await r.json();
      if (d.queued === false) throw new Error("copy queue is full");
      try { localStorage.setItem("nl-want-" + lib, String(Date.now())); } catch {}
      if (SNAP?.lib === lib && SNAP.queueFailed) {
        SNAP.queueFailed = false;
        paintCopyToast();
      }
    }).catch(() => {
      wantSent.delete(lib);
      if (SNAP?.lib === lib && !SNAP.ver) {
        SNAP.queueFailed = true;
        paintCopyToast();
      }
    });
}

function buildSnap(lib, d) {
  const films = [], games = [], seenF = new Map();
  for (const x of d.rows) {
    const r = fromRow(x, lib, d.sc, d.rec);
    rowsById.set(r.id, r);
    if (r.f === "g") games.push(r); else films.push(r);
  }
  return { lib, ver: d.ver || d.finished, finished: d.finished, films: merge(films, seenF), games, na: !!d.na };
}

// Everyone asking for the same library shares one attempt; a failed attempt is remembered for 5 minutes so
// nothing loops. A copy that arrives late waits in LATE and is picked up by the next reload(), so it can never
// replace a different library or yank a search the visitor is in the middle of.
let snapping = null, LATE = null;
// The combined shelf: each readable library's copy (this device's, else the static file), every record tagged with its
// library and given an id unique across libraries, then one card per film across all of them. Libraries with no copy
// yet are left out and named above the movies. Never browses live, so collections and whole-catalog search are off here.
async function openMine() {
  const libs = readableLibs(), films = [], games = [], missing = [];
  let finished = Infinity;
  await Promise.all(libs.map(async e => {
    let d = null;
    try {
      const cached = await idbGet(e.lib);
      if (cached) d = cached.d;
      else { const r = await fetchStatic(e.lib); if (r.d) { d = r.d; idbPut(e.lib, d); } else wantCopy(e.lib); }
    } catch {}
    if (!d) { missing.push(e.name || e.lib); return; }
    finished = Math.min(finished, d.finished);
    for (const x of d.rows) {
      const r = fromRow(x, e.lib, d.sc, d.rec);
      r.rid = r.id; r.id = e.lib + "~" + r.id;
      rowsById.set(r.id, r);
      (r.f === "g" ? games : films).push(r);
    }
  }));
  const snap = { lib: MINE, ver: "mine-" + libs.map(e => e.lib).join("+"), finished: Number.isFinite(finished) ? finished : Date.now(), films: merge(films, new Map()), games, missing, libs: libs.length };
  if (isMine()) SNAP = snap;
  return snap;
}
function loadSnap() {
  const lib = S.lib;
  if (lib === MINE) {
    const ver = "mine-" + readableLibs().map(e => e.lib).join("+");
    if (SNAP?.lib === MINE && SNAP.ver === ver) return Promise.resolve(SNAP);
    if (snapping?.lib === MINE && snapping.ver === ver) return snapping.p;
    const p = openMine().finally(() => { if (snapping?.p === p) snapping = null; });
    snapping = { lib, ver, p };
    return p;
  }
  if (SNAP && SNAP.lib === lib && (SNAP.ver || Date.now() - SNAP.at < 300e3)) return Promise.resolve(SNAP);
  if (snapping && snapping.lib === lib) return snapping.p;
  const p = openCopy(lib).finally(() => { if (snapping?.p === p) snapping = null; });
  snapping = { lib, p };
  return p;
}
const FILLING = "Your library's filling in. You can browse while we prepare the full collection.";
const copyNote = snap => snap.queueFailed ? "You can browse now. We couldn't queue the full collection yet and will try again." : snap.why === "error" ? "Couldn't reach the saved collection. You can still browse live results." : FILLING;
const readyNote = () => 'Your full collection is ready. <button class="link" id="openReadyCopy">Open it</button>';
function copyProgressNote(snap) {
  if (LATE?.lib === snap.lib) return readyNote();
  if (snap.queueFailed) return esc(copyNote(snap));
  const p = snap.progress;
  if (!p) return esc(copyNote(snap));
  if (/fail|stuck|blocked|waiting/.test(p.state || ""))
    return "Your library's full collection is delayed. You can keep browsing.";
  if (p.state === "copied") return 'Finishing your full collection. You can keep browsing.';
  if (p.state !== "in progress") return esc(copyNote(snap));
  const done = Number(p.pagesDone) || 0, total = Number(p.pagesKnown) || 0;
  const known = p.formatsKnown === 3 && total > 0;
  const count = known ? `${Math.min(99, Math.floor(done / total * 100))}% collected` : `${done.toLocaleString()} catalog pages collected`;
  return `${esc(copyNote(snap))}<div class="ct-prog"><progress class="copy-progress" aria-label="Full collection progress" ${known ? `max="${total}" value="${Math.min(done, total)}"` : ""}></progress> ${count}</div>`;
}
const liveNote = () => "";    // the message lives in the corner card now (paintCopyToast), not in the status line

// A small card in the lower right while a library is filling in; it turns into "ready" when the copy arrives.
let toastDismissed = "";
function paintCopyToast() {
  const el = document.getElementById("copyToast");
  if (isGuest()) { if (el) el.remove(); return; }     // guests get the pop-up once and a line above the movies instead
  const lib = S.lib, ready = !!lib && LATE?.lib === lib;
  const here = !!lib && !$("#shelf").hidden && !$("#browse").hidden && SNAP?.lib === lib && !SNAP.ver;
  const show = here && (ready || (SNAP.building && !SNAP.loading && toastDismissed !== lib));
  if (!show) { if (el) el.remove(); return; }
  const card = el || Object.assign(document.createElement("div"), { id: "copyToast", className: "copy-toast" });
  card.setAttribute("role", "status"); card.setAttribute("aria-live", "polite");
  card.innerHTML = `<div class="ct-body">${copyProgressNote(SNAP)}</div><button class="ct-x" data-ct-close aria-label="Dismiss">\u00d7</button>`;
  if (!el) document.body.append(card);
}
async function readCopyProgress(lib) {
  try {
    const r = await fetch(SNAP_BASE + "status.json", { cache: "no-cache", signal: AbortSignal.timeout(8000) });
    if (!r.ok) return;
    const d = await r.json();
    if (S.lib !== lib || SNAP?.lib !== lib || !SNAP.building) return;
    SNAP.progress = d.libraries?.[lib] || null;
    paintCopyToast();
  } catch { /* progress is optional; the shelf stays usable */ }
}
function openCopy(lib) {
  return new Promise(async resolve => {
    let settled = false;
    const settle = v => { if (!settled) { settled = true; resolve(v); } };
    const mine = v => { if (lib === S.lib) SNAP = v; return v; };       // never let a library the visitor left replace the current one
    const live = (why, extra = {}) => {
      const v = mine({ lib, building: true, why, at: Date.now(), ...extra });
      settle(v);
      paintCopyToast();
    };
    const arrive = d => {
      if (lib !== S.lib) { settle(null); return; }
      const snap = buildSnap(lib, d);
      if (!settled) { clearTimeout(timer); settle(mine(snap)); return; }
      // the shelf is already showing live results: hold the copy until the next reload so a search or scroll is never yanked
      LATE = { lib, snap };
      paintCopyToast();
      if (!$("#q").value.trim() && !liveQ && !S.coll && !document.querySelector("dialog[open]")) reload();
    };
    const timer = setTimeout(() => live("loading", { loading: true }), LIVE_AFTER_MS);
    try {
      const cached = await idbGet(lib);
      if (cached) {                     // use what is on this device right now, whatever its age
        arrive(cached.d);
        if (Date.now() - cached.d.finished > REFRESH_AFTER)
          fetchStatic(lib).then(r => { if (r.d && r.d.finished > cached.d.finished) idbPut(lib, r.d); }).catch(() => {});
        return;
      }
      const r = await fetchStatic(lib);
      if (r.d) { idbPut(lib, r.d); arrive(r.d); return; }
      clearTimeout(timer);
      if (isReaderLib(lib)) { settle(null); if (lib === S.lib) enterReader({ name: S.libName, catalog: readerCatalog(lib, libUrlOf(lib)) }, lib); return; }   // its copy is gone: wait on the popular shelf
      wantCopy(lib); live("missing"); readCopyProgress(lib);
    } catch (e) {
      clearTimeout(timer); wantCopy(lib); live("error");
    }
  });
}

const instant = () => SNAP && SNAP.lib === S.lib && SNAP.ver && ((!S.coll && !liveQ) || isMine());

let checkingCopy = false;
async function checkPendingCopy() {
  if (checkingCopy || document.visibilityState !== "visible" || !SNAP?.building || LATE?.lib === S.lib) return;
  const lib = S.lib;
  checkingCopy = true;
  try {
    const { d } = await fetchStatic(lib);
    if (!d) { wantCopy(lib); await readCopyProgress(lib); return; }
    idbPut(lib, d);
    if (S.lib !== lib || !SNAP?.building) return;
    LATE = { lib, snap: buildSnap(lib, d) };
    paintCopyToast();
  } catch { /* keep live browsing; a later check can recover */ }
  finally { checkingCopy = false; }
}
setInterval(checkPendingCopy, 120000);

function snapFilter() {
  const words = queryWords($("#q").value);
  let L = S.fmt === "games" ? SNAP.games : SNAP.films;
  const want = S.fmt === "br" ? "b" : S.fmt === "dvd" ? "d" : "";
  return L.filter(r => {
    if (want && !(r.fs || r.f).includes(want)) return false;
    if (S.fmt === "games") { if (S.plat && r.plat !== S.plat) return false; }
    else if (!genreMatch(r)) return false;
    if (S.onShelf && !r.avail && !noAvail()) return false;
    const y = r.fy || r.disc;
    if (S.y0 && (!y || y < S.y0)) return false;
    if (S.y1 && (!y || y > S.y1)) return false;
    if (S.minR && !(r.r >= S.minR && r.v >= 500)) return false;
    if (words.length && !queryMatch(r, words)) return false;
    return true;
  });
}

function snapSort(L) {
  const by = {
    top: (a, b) => ((b.v >= 1000) - (a.v >= 1000)) || ((b.r || 0) - (a.r || 0)) || ((b.v || 0) - (a.v || 0)),
    pop: (a, b) => b.v - a.v,
    title: (a, b) => norm(a.title).localeCompare(norm(b.title)),
    year: (a, b) => ((b.fy || b.disc || 0) - (a.fy || a.disc || 0)) || b.n - a.n,
    old: (a, b) => ((a.fy || a.disc || 9999) - (b.fy || b.disc || 9999)) || a.n - b.n,
  }[S.sort] || ((a, b) => b.n - a.n);   // newest records first
  return L.sort(by);
}

function snapRender() {
  ++run;
  snapList = snapSort(snapFilter());
  snapShown = 0;
  $("#grid").innerHTML = "";
  const when = new Date(SNAP.finished).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const q = $("#q").value.trim();
  if (isGuest()) {
    // a reminder that stays put: these are popular movies, and Check opens the visitor's own catalog
    const cat = guestCatalog(), n = snapList.length.toLocaleString();
    $("#status").innerHTML = !cat ? `${n} popular movies · <button class="link" id="addCatalogToast">Add your catalog link</button> to check them at your library`
      : q ? `${n} matches · <a href="${esc(searchLink(cat, q))}" target="_blank" rel="noopener noreferrer">Search ${esc(libLabel())} for “${esc(q)}”</a>`
      : `${n} popular movies · Tap one to check it at ${esc(libLabel())}`;
  } else
  $("#status").innerHTML = `${snapList.length.toLocaleString()} ${S.fmt === "games" ? "games" : "titles"}` +
    (isMine() ? ` from ${SNAP.libs} ${SNAP.libs === 1 ? "library" : "libraries"}` : "") +
    (S.onShelf ? ` <span class="dim">· shelf status from ${when}, tap a title for right now</span>` : "") +
    (q && isReaderLib(S.lib) ? ` · <a href="${esc(searchLink(readerCatalog(S.lib, libUrlOf(S.lib)), q))}" target="_blank" rel="noopener noreferrer">Search ${esc(libLabel())} for “${esc(q)}”</a>` : "") +
    (q && !isMine() && !isReaderLib(S.lib) ? ` · <button class="link" id="wholeCat">Search the whole catalog for “${esc(q)}”</button>` : "") +
    (isMine() && SNAP.missing?.length ? ` <span class="dim">· ${esc(SNAP.missing.join(", "))} ${SNAP.missing.length > 1 ? "are" : "is"} still filling in, so ${SNAP.missing.length > 1 ? "they're" : "it's"} not here yet</span>` : "");
  snapMore();
}

function snapMore() {
  if (snapShown >= snapList.length) { $("#more").textContent = snapList.length ? "That's the whole shelf." : (($("#q").value.trim()) ? "" : "Nothing matches these filters."); return; }
  const next = snapList.slice(snapShown, snapShown + PER);
  snapShown += next.length;
  $("#grid").insertAdjacentHTML("beforeend", next.map(cardHTML).join(""));
  $("#more").textContent = snapShown < snapList.length ? "Loading more…" : "That's the whole shelf.";
}

function loadMore() { if (snapping) return; if (instant()) snapMore(); else liveMore(); }

async function reload() {
  paintActive();
  const lib = S.lib;
  if (LATE && LATE.lib === lib) { SNAP = LATE.snap; LATE = null; }
  if (isMine() && (S.coll || liveQ)) { S.coll = ""; liveQ = false; }
  if (lib && (!SNAP || SNAP.lib !== lib || (isMine() && SNAP.ver !== "mine-" + readableLibs().map(e => e.lib).join("+")))) {
    $("#grid").innerHTML = ""; $("#status").textContent = "Opening your library…"; $("#more").textContent = "";
    await loadSnap();
    if (S.lib !== lib) return;      // switched libraries while waiting: the newer reload owns the screen
  }
  paintCopyToast();
  if (instant()) {
    const q = $("#q").value;
    await prepQuery();
    if (S.lib !== lib || $("#q").value !== q) return;   // typed again while the name files loaded: the newer reload paints
    return snapRender();
  }
  // live mode: while no copy is ready, for collections, and for whole-catalog searches
  // the live catalog takes one shelf at a time: the first picked genre that widens, else the first one
  const g = S.genres.find(x => !NARROW.has(x)) || S.genres[0];
  S.shelf = S.fmt === "games" ? "all" : S.coll || (GENRES.find(x => x[0] === g)?.[2]) || "all";
  await liveReload();
}

// ---- filters ---------------------------------------------------------------------

const activeCount = () => S.genres.length + [S.coll, S.plat, S.y0 || S.y1, S.minR, S.onShelf].filter(Boolean).length;

function paintActive() {
  const bits = [];
  const c = COLLECTIONS.find(x => x[0] === S.coll);
  if (S.fmt !== "games") for (const [k, l] of GENRES) if (S.genres.includes(k)) bits.push(["genre:" + k, l]);
  if (c) bits.push(["coll", c[1]]);
  if (S.fmt === "games" && S.plat) bits.push(["plat", S.plat]);
  if (S.y0 || S.y1) bits.push(["years", `${S.y0 || YEAR_MIN} to ${S.y1 || YEAR_MAX}`]);
  if (S.minR) bits.push(["minR", `★ ${S.minR}+`]);
  if (S.onShelf) bits.push(["onShelf", "On the shelf"]);
  $("#active").innerHTML = bits.map(([k, l]) => `<button class="tag" data-clear="${k}" aria-label="Remove ${esc(l)}">${esc(l)} <span aria-hidden="true">×</span></button>`).join("") +
    (bits.length > 1 ? `<button class="link" data-clear="all">Clear all</button>` : "");
  const n = activeCount();
  $("#filtN").textContent = n ? `(${n})` : "";
}

function clearFilter(k) {
  if (k === "all" || k === "genre") S.genres = [];
  if (k.startsWith("genre:")) S.genres = S.genres.filter(g => g !== k.slice(6));
  if (k === "all" || k === "coll") S.coll = "";
  if (k === "all" || k === "plat") S.plat = "";
  if (k === "all" || k === "years") { S.y0 = 0; S.y1 = 0; }
  if (k === "all" || k === "minR") S.minR = 0;
  if (k === "all" || k === "onShelf") S.onShelf = false;
}

function filterCount() {
  if (!instant() && !(SNAP?.ver && !liveQ && !S.coll)) return "";
  return snapFilter().length.toLocaleString();
}

function openFilters() {
  const games = S.fmt === "games";
  const plats = games && SNAP?.games ? [...new Set(SNAP.games.map(g => g.plat).filter(Boolean))].sort() : [];
  const chip = (attr, val, label, on) => `<button class="chip" ${attr}="${esc(val)}" aria-pressed="${on}">${esc(label)}</button>`;
  $("#filtBody").innerHTML = `<div class="in acct-body filt-body">
    <button class="x" data-close aria-label="Close">×</button>
    <h2>Filters</h2>
    ${games ? `<h3>Platform</h3><div class="chipgrid">${chip("data-plat", "", "All", !S.plat)}${plats.map(p => chip("data-plat", p, p, S.plat === p)).join("")}</div>`
      : `<h3>Genre</h3><div class="chipgrid">${chip("data-genre", "", "All", !S.genres.length && !S.coll)}${GENRES.map(([k, l]) => chip("data-genre", k, l, S.genres.includes(k) && !S.coll)).join("")}</div>
         ${isMine() || isReaderLib(S.lib) ? "" : `<h3>Collections</h3><div class="chipgrid">${COLLECTIONS.map(([k, l]) => chip("data-coll", k, l, S.coll === k)).join("")}</div>`}`}
    <h3>Year</h3>
    <div class="range2">
      <label>From <output id="y0o">${S.y0 || YEAR_MIN}</output><input type="range" id="y0" min="${YEAR_MIN}" max="${YEAR_MAX}" value="${S.y0 || YEAR_MIN}"></label>
      <label>To <output id="y1o">${S.y1 || YEAR_MAX}</output><input type="range" id="y1" min="${YEAR_MIN}" max="${YEAR_MAX}" value="${S.y1 || YEAR_MAX}"></label>
    </div>
    ${games ? "" : `<h3>Rating</h3>
    <label class="range1">At least <output id="mro">${S.minR ? "★ " + S.minR : "any"}</output><input type="range" id="minR" min="0" max="9" step="0.5" value="${S.minR}"></label>`}
    ${noAvail() ? "" : `<label class="toggle big"><input type="checkbox" id="onShelfF" ${S.onShelf ? "checked" : ""}> On the shelf now</label>`}
    <div class="stack" style="margin-top:18px">
      <button class="btn" id="filtShow">Show ${filterCount() ? filterCount() + " " : ""}titles</button>
      <button class="link" id="filtClear" style="justify-self:center">Clear all</button>
    </div></div>`;
  if (!$("#filters").open) $("#filters").showModal();
}

function filtChanged(rerender = true) {
  save(); paintActive();
  const btn = $("#filtShow");
  if (btn) { const n = filterCount(); btn.textContent = `Show ${n ? n + " " : ""}titles`; }
  if (rerender) openFilters();
}

$("#filtBody").addEventListener("click", e => {
  const g = e.target.closest("[data-genre]"), c = e.target.closest("[data-coll]"), p = e.target.closest("[data-plat]");
  if (g) {
    const k = g.dataset.genre;
    S.genres = !k ? [] : S.genres.includes(k) ? S.genres.filter(x => x !== k)
      : [...S.genres.filter(x => !(k === "movies" && x === "tv") && !(k === "tv" && x === "movies")), k];
    S.coll = ""; filtChanged();
  }
  else if (c) { S.coll = S.coll === c.dataset.coll ? "" : c.dataset.coll; if (S.coll) S.genres = []; filtChanged(); }
  else if (p) { S.plat = p.dataset.plat; filtChanged(); }
  else if (e.target.id === "filtClear") { clearFilter("all"); filtChanged(); }
  else if (e.target.id === "filtShow") { $("#filters").close(); }
});
$("#filtBody").addEventListener("input", e => {
  const t = e.target;
  if (t.id === "y0" || t.id === "y1") {
    let a = +$("#y0").value, b = +$("#y1").value;
    if (a > b) { if (t.id === "y0") b = a; else a = b; $("#y0").value = a; $("#y1").value = b; }
    $("#y0o").textContent = a; $("#y1o").textContent = b;
    S.y0 = a > YEAR_MIN ? a : 0; S.y1 = b < YEAR_MAX ? b : 0; filtChanged(false);
  } else if (t.id === "minR") { S.minR = +t.value; $("#mro").textContent = S.minR ? "★ " + S.minR : "any"; filtChanged(false); }
  else if (t.id === "onShelfF") { S.onShelf = t.checked; filtChanged(false); }
});
$("#filters").addEventListener("close", () => { liveQ = false; reload(); });
$("#filtBtn").onclick = openFilters;
$("#active").addEventListener("click", e => { const b = e.target.closest("[data-clear]"); if (b) { clearFilter(b.dataset.clear); save(); reload(); } });
document.addEventListener("click", e => { if (e.target.id === "wholeCat") { liveQ = true; reload(); } else if (e.target.id === "retryMore") { $("#more").textContent = "Loading more…"; liveMore(); } else if (e.target.id === "openReadyCopy") { reload(); } else if (e.target.closest?.("[data-ct-close]")) { toastDismissed = S.lib; paintCopyToast(); } else if (e.target.id === "addCatalog" || e.target.id === "addCatalogToast") askCatalog(); });
// From the shelf: back to the home page and its one box, to add the catalog link.
function askCatalog() {
  const open = $("#detail").open;
  if (open) $("#detail").close();
  setTimeout(() => {                        // after the dialog's own history step settles
    showHome();
    $("#pickErr").textContent = "Paste your library's catalog link here, and every movie gets a button that searches your library for it.";
    $("#pickInput").focus();
  }, open ? 120 : 0);
}

// ---- favorites and watchlist tabs ------------------------------------------------

function showFaves() {
  const rows = Object.values(S.faves).filter(favHere).sort((a, b) => b.added - a.added);
  remember(rows);
  $("#favGrid").innerHTML = rows.map(cardHTML).join("");
  $("#favStatus").textContent = rows.length
    ? `${rows.length} saved. Availability is from when you saved it, so tap one to check the library.`
    : "Tap the heart on any movie to save it here.";
}

function parseCSV(text) {
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(f); rows.push(row); row = []; f = ""; }
    else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim()));
}

function readWatchlist(text) {
  const rows = parseCSV(text);
  const h = rows.shift()?.map(x => x.trim().toLowerCase()) || [];
  const col = name => h.indexOf(name);
  let items = [], source = "";
  if (col("const") >= 0 && col("title") >= 0) {           // IMDb export
    source = "IMDb";
    const ty = col("title type");
    const ot = col("original title");
    items = rows.map(r => ({ t: r[col("title")], o: ot >= 0 ? r[ot] : "", y: +r[col("year")] || null, imdb: r[col("const")], tv: ty >= 0 && /series/i.test(r[ty]) }));
  } else if (col("name") >= 0) {                          // Letterboxd export
    source = "Letterboxd";
    items = rows.map(r => ({ t: r[col("name")], y: +r[col("year")] || null }));
  }
  return { source, items: items.filter(i => i.t).slice(0, 1000) };
}

let matchingLib = null;
async function matchWatchlist(lib = S.lib) {
  const W = S.watch;
  if (!W?.items?.length || isGuest() || lib === MINE) return showWatch();
  if (matchingLib) return;
  matchingLib = lib;
  W.matches = W.matches || {};
  const out = [];
  $("#wlStatus").textContent = `Checking ${W.items.length} titles at ${libNameOf(lib)}…`;
  for (let i = 0; i < W.items.length; i += 6) {
    const chunk = W.items.slice(i, i + 6);
    let hits = chunk.map(() => []);
    try { hits = (await api("/api/find", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ lib, items: chunk }) })).hits; } catch {}
    chunk.forEach((it, j) => out.push({ ...it, hits: hits[j] || [] }));
    $("#wlStatus").textContent = `Checked ${Math.min(i + 6, W.items.length)} of ${W.items.length}…`;
  }
  W.matches[lib] = out;
  matchingLib = null;
  save(); counts(); showWatch();
}
// The combined view's watchlist: every library's matches, one line per title, hits tagged with their library.
function mineWatch() {
  const M = S.watch?.matches || {}, libs = readableLibs();
  if (!S.watch?.items?.length || !libs.length || libs.some(e => !M[e.lib])) return null;
  const k = x => norm(x.t) + "|" + (x.y || "");
  return S.watch.items.map(it => {
    const hits = [];
    for (const e of libs) {
      const m = M[e.lib].find(x => k(x) === k(it));
      for (const h of m?.hits || []) hits.push({ ...h, lib: e.lib, rid: h.rid || h.id, id: e.lib + "~" + (h.rid || h.id) });
    }
    return { ...it, hits };
  });
}

// A library we cannot read: the watchlist becomes one-tap searches of the library's own catalog,
// with a cover for the titles that are on the movie shelf here.
async function showGuestWatch() {
  const items = S.watch?.items || [], cat = guestCatalog();
  $("#wlGrid").innerHTML = ""; $("#wlMissing").innerHTML = ""; $("#wlStatus").textContent = "";
  if (!items.length) return;
  if (!cat) { $("#wlStatus").innerHTML = `Your ${esc(S.watch.source)} watchlist has ${items.length} titles. <button class="link" id="addCatalogToast">Add your library's catalog link</button> to check them there, one tap each.`; return; }
  await loadSnap().catch(() => {});
  const cards = [], rest = [];
  for (const it of items) { const r = it.imdb && rowsById.get(it.imdb); if (r) cards.push(r); else rest.push(it); }
  $("#wlStatus").textContent = `Your ${S.watch.source} watchlist, ${items.length} titles. Tap any of them to search for it at ${libLabel()}.`;
  $("#wlGrid").innerHTML = cards.map(cardHTML).join("");
  $("#wlMissing").innerHTML = rest.length
    ? `<ul class="wl-list">${rest.map(x => `<li><a href="${esc(searchLink(cat, x.t))}" target="_blank" rel="noopener noreferrer">${esc(x.t)}${x.y ? ` (${x.y})` : ""}</a></li>`).join("")}</ul>` : "";
}

async function showWatch() {
  if (isGuest()) return showGuestWatch();
  if (isMine() && S.watch?.items?.length) {
    const todo = readableLibs().find(e => !S.watch.matches?.[e.lib]);
    if (todo) { $("#wlGrid").innerHTML = ""; $("#wlMissing").innerHTML = ""; return matchWatchlist(todo.lib); }
  }
  const m = isMine() ? mineWatch() : S.watch?.matches?.[S.lib];
  if (!m) { $("#wlGrid").innerHTML = ""; $("#wlMissing").innerHTML = ""; $("#wlStatus").textContent = S.watch ? "" : ""; if (S.watch?.items?.length && !isMine()) matchWatchlist(); return; }
  const have = [], miss = [];
  for (const it of m) {
    if (it.hits.length) {
      const r = it.hits[0];
      r.fy = it.y || r.fy;
      have.push(r);
    } else miss.push(it);
  }
  await rate(remember(have));
  $("#wlGrid").innerHTML = have.map(cardHTML).join("");
  $("#wlStatus").textContent = `${have.length} of ${m.length} from your ${S.watch.source} watchlist are at ${isMine() ? "your libraries" : S.libName}.`;
  $("#wlMissing").innerHTML = miss.length
    ? `<h3>${isMine() ? "Not at your libraries" : "Not at this library"}</h3><p>${miss.map(x => esc(x.t) + (x.y ? ` (${x.y})` : "")).join(" · ")}</p><p class="small-print">Ask about interlibrary loan. Most libraries can borrow a movie from another library for you.</p>`
    : "";
}

// ---- home screen (phones) ----------------------------------------------------------

const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const isPhone = () => /iphone|ipad|ipod|android/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /macintosh/i.test(navigator.userAgent));
let installPrompt = null;
addEventListener("beforeinstallprompt", e => { e.preventDefault(); installPrompt = e; });
addEventListener("appinstalled", () => { installPrompt = null; });
// Safari on a Mac (17+) installs with File > Add to Dock; Chrome and Edge fire beforeinstallprompt. Firefox can't install.
const isSafariMac = () => /macintosh/i.test(navigator.userAgent) && /safari/i.test(navigator.userAgent) && !/chrome|chromium|edg\//i.test(navigator.userAgent) && navigator.maxTouchPoints < 2;
const SHARE_ICON = `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.5v11"/><path d="M8 7.3l4-3.8 4 3.8"/><path d="M6.5 11H6a1.5 1.5 0 0 0-1.5 1.5v6.5A1.5 1.5 0 0 0 6 20.5h12a1.5 1.5 0 0 0 1.5-1.5v-6.5A1.5 1.5 0 0 0 18 11h-.5"/></svg>`;
const ADD_ICON = `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M12 8.5v7M8.5 12h7"/></svg>`;
const DOTS_ICON = `<svg class="ico" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg>`;

// Shown once right after sign-up or sign-in, unless it's already installed: phones get the home screen, computers
// (Chrome, Edge, Safari on a Mac) get the app in its own window (Chris 11.1.26: offer it on desktop too, like Keiser).
function homeScreenOffer(then) {
  if (isStandalone()) return then();
  const computer = !isPhone();
  if (computer && !installPrompt && !isSafariMac()) return then();
  acctView(`${computer ? `<h2>Keep Nomad Library on your computer</h2>
    <p>Install it and it opens in its own window, right from your Dock or taskbar. It takes about 10 seconds.</p>` : `<h2>Keep Nomad Library on your phone</h2>
    <p>Put it on your home screen and it opens like an app, with one tap. It takes about 20 seconds.</p>`}
    <div class="stack">
      <button class="btn" id="hsShow">Show me how</button>
      <button class="btn ghost" id="hsLater">Maybe later</button>
    </div>`);
  if (!$("#account").open) $("#account").showModal();
  $("#hsShow").onclick = () => homeScreenGuide(then);
  $("#hsLater").onclick = () => then();
}

function homeScreenGuide(then, tab) {
  const t = tab || (/android/i.test(navigator.userAgent) ? "android" : isPhone() ? "iphone" : "computer");
  const android = t === "android";
  const ios = `<ol class="steps">
      <li>Open <b>library.nomadovernormal.com</b> in Safari.</li>
      <li>Tap the Share button ${SHARE_ICON}. If you don't see it, tap ${DOTS_ICON} first, then Share.</li>
      <li>Scroll down and tap ${ADD_ICON} <b>Add to Home Screen</b>, then <b>Add</b>.</li>
      <li>Open Nomad Library from your home screen and sign in once more with your passkey. The home screen app keeps its own sign-in.</li></ol>`;
  const droid = `${installPrompt ? `<button class="btn" id="hsInstall" style="width:100%;margin-bottom:14px">Install Nomad Library</button>` : ""}
    <ol class="steps">
      <li>Open <b>library.nomadovernormal.com</b> in Chrome.</li>
      <li>Tap the menu ${DOTS_ICON} in the top right corner.</li>
      <li>Tap <b>Add to home screen</b>, then <b>Install</b>.</li>
      <li>Open Nomad Library from your home screen. You'll still be signed in.</li></ol>`;
  const desk = `${installPrompt ? `<button class="btn" id="hsInstall" style="width:100%;margin-bottom:14px">Install Nomad Library</button>` : ""}
    ${isSafariMac() ? `<ol class="steps">
      <li>In Safari, open the <b>File</b> menu.</li>
      <li>Choose <b>Add to Dock</b>, then click <b>Add</b>.</li>
      <li>Open Nomad Library from your Dock and sign in once more with your passkey. The Dock app keeps its own sign-in.</li></ol>`
    : `<ol class="steps">
      <li>Open <b>library.nomadovernormal.com</b> in Chrome or Microsoft Edge.</li>
      <li>Click the install icon at the right end of the address bar, or open the menu ${DOTS_ICON} and choose <b>Cast, save and share</b>, then <b>Install page as app</b>.</li>
      <li>Click <b>Install</b>. It opens in its own window, and you'll still be signed in.</li></ol>`}`;
  acctView(`<h2>${t === "computer" ? "Install it on your computer" : "Put it on your home screen"}</h2>
    ${isStandalone() ? `<p>You're already using the Nomad Library app, so you're all set.</p>` : ""}
    <div class="seg hs-tabs" role="tablist">
      <button role="tab" data-t="iphone" aria-pressed="${t === "iphone"}">iPhone</button><button role="tab" data-t="android" aria-pressed="${android}">Android</button><button role="tab" data-t="computer" aria-pressed="${t === "computer"}">Computer</button>
    </div>
    ${t === "computer" ? desk : android ? droid : ios}
    <button class="btn" id="hsDone" style="width:100%;margin-top:6px">Done</button>`);
  if (!$("#account").open) $("#account").showModal();
  document.querySelectorAll(".hs-tabs button").forEach(b => b.onclick = () => homeScreenGuide(then, b.dataset.t));
  $("#hsInstall")?.addEventListener("click", async () => { const p = installPrompt; installPrompt = null; await p.prompt(); homeScreenGuide(then, t); });
  $("#hsDone").onclick = () => (then ? then() : $("#account").close());
}

// ---- accounts ------------------------------------------------------------------

const WA = window.SimpleWebAuthnBrowser;
const passkeysOK = () => !!(window.PublicKeyCredential && WA);

async function refreshMe() {
  try { me = await api("/api/me"); } catch { me = { uid: null }; }
  $("#acctBtn").textContent = me.uid ? "Account" : "Sign in";
  return me;
}

// signingIn: bring this device's favorites into the account once.
// Every other time, the account is the truth, so a favorite removed on one device stays removed.
function mergeIn(data, signingIn = false) {
  if (!data) return;
  S.faves = signingIn ? { ...(data.faves || {}), ...S.faves } : { ...(data.faves || {}) };
  // Your account's library wins over whatever this device was last browsing.
  if (data.lib) { S.lib = data.lib; S.libName = data.libName; S.demo = false; if (data.lib === GUEST) S.guest = data.guest || S.guest || {}; }
  if (Array.isArray(data.libs)) {
    if (signingIn) { const have = new Set(data.libs.map(libKey)); S.libs = [...data.libs, ...S.libs.filter(e => !have.has(libKey(e)))].slice(-8); }
    else S.libs = data.libs;
  }
  rememberLib();
  if (isMine() && readableLibs().length < 2) { const e = S.libs[0]; if (e) { S.lib = e.lib; S.libName = e.name; if (e.lib === GUEST) S.guest = e.guest; } }
  if (data.watch || !signingIn) S.watch = data.watch || S.watch;
  if (data.fmt && !store.get().fmt) S.fmt = data.fmt;
}

// Coming back to an open tab or the home screen app picks up changes made on other devices.
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState !== "visible" || !me.uid || saveTimer) return;
  const before = JSON.stringify(S.faves) + JSON.stringify(S.watch?.matches || {});
  await refreshMe();
  if (!me.uid) return;
  mergeIn(me.data); store.set(S);
  if (JSON.stringify(S.faves) + JSON.stringify(S.watch?.matches || {}) === before) return;
  counts();
  if (!$("#faves").hidden) showFaves();
  if (!$("#watch").hidden) showWatch();
});

async function afterSignIn(extra) {
  await refreshMe();
  mergeIn(me.data, true);
  save();
  if (extra?.code) return showCode(extra.code, true);
  if (!me.data?.lib) return libraryStep();
  homeScreenOffer(() => {
    $("#account").close();
    toast("Signed in. Your shelf is saved.");
    boot();
  });
}

// Right after signup (or a sign-in with no library yet): pick your own library, with the same search as the home page.
let pickingForAccount = false;
function libraryStep() {
  const mine = S.lib && !S.demo;
  acctView(`<h2>Now, let's set up your library</h2>
    <p>Your account opens to it from now on, on every device.</p>
    <div class="stack">
      ${mine ? `<button class="btn" id="keepLib">Use ${esc(libLabel())}</button>` : ""}
      <button class="btn${mine ? " ghost" : ""}" id="findLib">${mine ? "Use a different library" : "Add my library"}</button>
    </div>
    <button class="link small-print" id="skipLib" style="margin-top:14px">I'll do this later</button>`);
  if (!$("#account").open) $("#account").showModal();
  if (mine) $("#keepLib").onclick = () => {
    save(); flushSave();   // the library is what the account is for, so it saves right away
    homeScreenOffer(() => { $("#account").close(); toast(`Your library is ${libLabel()}.`); boot(); });
  };
  $("#findLib").onclick = () => {
    pickingForAccount = true;
    $("#account").close();
    setTimeout(() => { showHome(); $("#pickInput").focus(); }, 120);   // after the dialog's own history step settles
  };
  $("#skipLib").onclick = () => homeScreenOffer(() => { $("#account").close(); showHome(); });
}
// A library was just chosen. If that was the account's set-up step, save it now and finish set-up.
function libraryPicked() {
  if (!pickingForAccount || !me.uid) return;
  pickingForAccount = false;
  flushSave();
  homeScreenOffer(() => {
    if ($("#account").open) $("#account").close();
    toast(`Your library is ${libLabel()}. It's saved to your account.`);
    if (isGuest()) setTimeout(guestIntro, 150);    // after the account window's own history step
  });
}

async function passkeyCreate() {
  const opts = await api("/api/auth/register-options", { method: "POST" });
  const response = await WA.startRegistration({ optionsJSON: opts });
  return api("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ response, data: synced(), label: navigator.platform || "" }) });
}
async function passkeySignIn() {
  const opts = await api("/api/auth/login-options", { method: "POST" });
  const response = await WA.startAuthentication({ optionsJSON: opts });
  return api("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ response }) });
}
const cancelled = e => /NotAllowed|AbortError|cancel/i.test(e?.name + e?.message);

function acctView(html) { $("#acctBody").onclick = null; $("#acctBody").innerHTML = `<div class="in acct-body"><button class="x" data-close aria-label="Close">×</button>${html}</div>`; }

function openAccount() {
  if (me.uid) {
    acctView(`<h2>Your account</h2>
      <p>Your library, favorites and watchlist are saved and follow you to any device you sign in on.</p>
      <div class="stack">
        ${isStandalone() ? "" : isPhone() ? `<button class="btn" id="hsGuide">Put it on your home screen</button>` : installPrompt || isSafariMac() ? `<button class="btn" id="hsGuide">Install it on your computer</button>` : ""}
        ${passkeysOK() ? `<button class="btn${isPhone() && !isStandalone() ? " ghost" : ""}" id="addKey">Add a passkey on this device</button>` : ""}
        <button class="btn ghost" id="newCode">Make a new backup code</button>
        <button class="btn ghost" id="signOut">Sign out</button>
        <button class="btn danger" id="delAcct">Delete my account</button>
      </div>
      <p class="small-print" style="margin-top:14px">${me.passkeys} passkey${me.passkeys === 1 ? "" : "s"} on this account.</p>`);
  } else {
    acctView(`<h2>Save your shelf</h2>
      <p>A free account keeps your library, favorites and watchlist on every device. No email and no password: you sign in with your face, fingerprint or device PIN.</p>
      <div class="stack">
        ${passkeysOK() ? `<button class="btn" id="mkKey">Create a free account</button>
        <button class="btn ghost" id="useKey">Sign in with a passkey</button>` : ""}
        <div class="divider">or</div>
        <button class="btn ghost" id="useCode">Sign in with a backup code</button>
        <button class="btn ghost" id="mkCode">Create an account with a backup code</button>
      </div>
      <p class="err" id="acctErr" role="alert"></p>`);
  }
  if (!$("#account").open) $("#account").showModal();
}

function showCode(code, fresh) {
  acctView(`<h2>${fresh ? "You're in. Save this code." : "Your new backup code"}</h2>
    <p>If you ever lose your phone or switch computers, this code gets you back into your account. It's the only copy, so keep it somewhere safe, like your password manager or notes.</p>
    <div class="code">${esc(code)}</div>
    <div class="stack" style="margin-top:14px">
      <button class="btn ghost" id="copyCode">Copy it</button>
      <button class="btn" id="savedCode">I saved it</button>
    </div>`);
  $("#copyCode").onclick = () => navigator.clipboard?.writeText(code).then(() => toast("Copied"));
  $("#savedCode").onclick = () => {
    if (fresh) return libraryStep();
    $("#account").close(); boot();
  };
}

function codeForm() {
  acctView(`<h2>Sign in with your backup code</h2>
    <p>It's the code you saved when you made your account.</p>
    <form id="codeForm" class="stack">
      <input id="codeIn" class="code" autocomplete="one-time-code" placeholder="XXXX-XXXX-XXXX-XXXX" style="font-size:18px">
      <button class="btn">Sign in</button>
    </form>
    <p class="err" id="acctErr" role="alert"></p>`);
  $("#codeForm").onsubmit = async e => {
    e.preventDefault();
    try { await api("/api/auth/recover", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: $("#codeIn").value }) }); afterSignIn(); }
    catch (err) { $("#acctErr").textContent = err.message; }
  };
}

document.addEventListener("click", async e => {
  const t = e.target.closest("button, a");
  if (!t) return;
  const err = m => { const el = $("#acctErr"); if (el) el.textContent = m; else toast(m); };
  try {
    if (t.id === "mkKey") afterSignIn(await passkeyCreate());
    else if (t.id === "useKey") afterSignIn(await passkeySignIn());
    else if (t.id === "useCode") codeForm();
    else if (t.id === "hsGuide") homeScreenGuide(null);
    else if (t.id === "mkCode") afterSignIn(await api("/api/auth/code-signup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ data: synced() }) }));
    else if (t.id === "addKey") { await passkeyCreate(); await refreshMe(); toast("Passkey added."); openAccount(); }
    else if (t.id === "newCode") showCode((await api("/api/auth/new-code", { method: "POST" })).code, false);
    else if (t.id === "signOut") { await api("/api/auth/logout", { method: "POST" }); me = { uid: null }; $("#acctBtn").textContent = "Sign in"; $("#account").close(); toast("Signed out. This device keeps a copy of your shelf."); }
    else if (t.id === "delAcct") {
      if (!confirm("Delete your account and everything saved in it? This can't be undone.")) return;
      await api("/api/auth/delete", { method: "POST" }); me = { uid: null }; $("#acctBtn").textContent = "Sign in"; $("#account").close(); toast("Account deleted.");
    }
  } catch (ex) { if (!cancelled(ex)) err(ex.message); }
});

// ---- wiring -----------------------------------------------------------------------

function setTab(tab) {
  document.querySelectorAll(".tabs button").forEach(b => b.setAttribute("aria-selected", b.dataset.tab === tab));
  for (const id of ["browse", "faves", "watch"]) $("#" + id).hidden = id !== tab;
  if (tab === "faves") showFaves();
  if (tab === "watch") showWatch();
  paintCopyToast();
}

function paintControls() {
  document.body.classList.toggle("guest", isGuest());
  document.querySelectorAll("#fmt button").forEach(b => b.setAttribute("aria-pressed", b.dataset.fmt === S.fmt));
  // the nationwide shelf has no arrival dates, so it offers "Most popular" in place of "Newest arrivals"
  const first = $("#sort").options[0], guest = isGuest();
  if ((first.value === "pop") !== guest) { first.value = guest ? "pop" : ""; first.textContent = guest ? "Most popular" : "Newest arrivals"; }
  if (guest && !S.sort) S.sort = "pop";
  if (!guest && S.sort === "pop") S.sort = "";
  $("#sort").value = S.sort;
}

// ---- your library: one box, paste the catalog link -------------------------------------
// BiblioCommons links open the library's own shelf. Any other catalog opens movies, and "Check at" searches that catalog.

const sentRequests = new Set();
// Counts which catalog systems people use (no IDs), at most once per catalog per device per day.
function requestLibrary(info) {
  const url = info.catalog?.url || "";
  const key = (url || info.host || "").toLowerCase();
  if (!key || sentRequests.has(key)) return;
  sentRequests.add(key);
  let last = 0;
  try { last = +localStorage.getItem("nl-req-" + key) || 0; } catch {}
  if (Date.now() - last < 864e5) return;
  fetch("/api/request", { method: "POST", headers: { "content-type": "application/json" }, keepalive: true,
    body: JSON.stringify({ name: info.name || "", host: info.catalog?.host || info.host || "", vendor: info.catalog?.system || "", url }) })
    .then(r => { if (r.ok) try { localStorage.setItem("nl-req-" + key, String(Date.now())); } catch {} }).catch(() => sentRequests.delete(key));
}
// Movies to browse for a library we cannot read; every "Check at" button searches the library's own catalog.
function enterGuest(info) {
  const cat = info.catalog?.url ? info.catalog : null;
  const rid = readerId(cat);
  if (rid) return enterReader(info, rid);
  S.guest = { name: info.name || "", catalog: cat };
  S.lib = GUEST; S.libName = S.guest.name; S.demo = false; S.shelf = "all"; S.sort = "pop"; clearFilter("all"); S.fmt = "all";
  toastDismissed = "";
  rememberLib(); save(); boot();
  if (!pickingForAccount) guestIntro();
  libraryPicked();
}
// A catalog we copy ourselves (Vega so far). If its copy exists it opens like any library. If not, the copier is asked
// for it and the visitor browses popular movies (Check at searches their catalog) until it's ready, usually within the hour.
const copyReady = async id => {
  try { if (await idbGet(id)) return true; } catch {}
  try { return (await fetch(SNAP_BASE + encodeURIComponent(id) + ".json.gz", { method: "HEAD", cache: "no-cache", signal: AbortSignal.timeout(6000) })).ok; } catch { return false; }
};
async function enterReader(info, id) {
  const name = info.name || S.libs.find(e => e.lib === id)?.name || "";
  const url = (info.catalog?.url ? readerUrl(info.catalog) : "") || libUrlOf(id);
  if (!(await copyReady(id))) {
    wantCopy(id, name, url);
    const cat = info.catalog?.url ? info.catalog : readerCatalog(id, url);
    S.guest = { name, catalog: cat, reader: id };
    S.lib = GUEST; S.libName = name; S.demo = false; S.shelf = "all"; S.sort = "pop"; clearFilter("all"); S.fmt = "all";
    toastDismissed = "";
    rememberLib(); save(); boot();
    if (!pickingForAccount) guestIntro();
    libraryPicked();
    return;
  }
  openReaderLib(id, name, url);
  libraryPicked();
}
function openReaderLib(id, name, url) {
  // the waiting guest entry for this catalog becomes the real library
  S.libs = S.libs.filter(e => !(e.lib === GUEST && readerId(e.guest?.catalog) === id));
  S.libUrl = url || libUrlOf(id); S.lib = id; S.libName = name || S.libs.find(e => e.lib === id)?.name || ""; S.demo = false; S.shelf = "all"; S.sort = ""; clearFilter("all"); S.fmt = "all";
  rememberLib(); save(); boot();
}
// A visitor waiting on a copy: when it's ready, move them onto their library's own shelf.
let upgradeChecked = "";
async function upgradeGuest() {
  const cat = guestCatalog(), id = S.guest?.noCopy ? "" : readerId(cat);
  if (!id || upgradeChecked === id) return;
  upgradeChecked = id;
  if (!(await copyReady(id))) {
    wantCopy(id, S.libName, readerUrl(cat));
    // a catalog that turned out to block copying (a bot wall): stop promising, it stays a "Check at" library
    try {
      const st = (await (await fetch(SNAP_BASE + "status.json", { cache: "no-cache", signal: AbortSignal.timeout(8000) })).json()).libraries?.[id];
      if (st && (st.state === "stuck" || (st.state === "failing" && st.attempts >= 3)) && isGuest()) { S.guest.noCopy = true; rememberLib(); save(); }
    } catch {}
    return;
  }
  if (!isGuest() || readerId(guestCatalog()) !== id) return;
  openReaderLib(id, S.libName, readerUrl(cat));
  toast(`${S.libName || "Your library"}'s own shelf is ready.`);
}
// Said once, plainly, the first time someone opens a library we can't read.
function guestIntro() {
  const cat = guestCatalog(), key = "nl-intro-" + (cat?.host || "none");
  try { if (localStorage.getItem(key)) return; localStorage.setItem(key, "1"); } catch {}
  const who = S.libName || "Your library", at = libLabel();
  $("#guestIntroBody").innerHTML = `<div class="in acct-body"><button class="x" data-close aria-label="Close">×</button>
    ${cat && readerId(cat) && !S.guest?.noCopy ? `<h2>We're copying ${esc(S.libName ? S.libName + "'s" : "your library's")} shelves now</h2>
      <p>It's usually ready within the hour, and this page switches to your library's own movies by itself.</p>
      <p>Until then, here are popular movies from libraries across the country. Tap any movie, then <b>Check at ${esc(at)}</b> to search your library for it.</p>`
    : cat ? `<h2>We can't read ${esc(S.libName ? S.libName + "'s" : "your library's")} catalog yet</h2>
      <p>It runs on a catalog system we haven't learned to read yet. Until we can, here are popular movies from libraries across the country.</p>
      <p>Tap any movie, then <b>Check at ${esc(at)}</b>, and your library's catalog opens with that movie already searched.</p>`
    : `<h2>We couldn't find your library's catalog</h2>
      <p>Here are popular movies from libraries across the country. Add your catalog link from the home page any time, and every movie gets a button that searches your library for it.</p>`}
    <button class="btn" type="button" data-close style="width:100%;margin-top:6px">Show me the movies</button>
    ${emailFormHTML("library", { label: `Get an email when we can show ${S.libName ? esc(S.libName) + "'s" : "your library's"} shelves`, button: "Notify me" })}</div>`;
  $("#guestIntro").showModal();
  emailAsked();
}

// ---- email sign-ups: "my library is ready" and "updates" ---------------------------------
// Optional, and stored only on our server (see the privacy page). Nothing is emailed from here.
function emailFormHTML(kind, { label, button }) {
  return `<form class="email-form intro-email" data-kind="${kind}" novalidate>
    <label>${label}</label>
    <div class="row"><input type="email" name="email" autocomplete="email" placeholder="Your email" required aria-label="Your email"><input class="hp" name="website" tabindex="-1" autocomplete="off" aria-hidden="true"><button type="submit">${button}</button></div>
    ${kind === "library" ? `<label class="check"><input type="checkbox" name="updates"> Also send me Nomad Library updates</label>` : ""}
    <p class="err" role="status" aria-live="polite"></p>
  </form>`;
}
const emailAsked = () => { try { localStorage.setItem("nl-email-asked", "1"); } catch {} };
document.addEventListener("submit", async e => {
  const f = e.target.closest(".email-form");
  if (!f) return;
  e.preventDefault();
  const msg = f.querySelector(".err"), email = f.email.value.trim(), kind = f.dataset.kind;
  msg.classList.remove("ok");
  if (!/^\S+@\S+\.\S+$/.test(email)) { msg.textContent = "That email doesn't look right. Check it and try again."; return; }
  const lib = kind === "library" ? { name: S.libName || "", url: guestCatalog()?.url || "" } : null;
  const send = k => api("/api/notify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, kind: k, lib, website: f.website.value }) });
  msg.textContent = "Saving…";
  try {
    await send(kind);
    if (kind === "library" && f.updates?.checked) await send("updates");
    emailAsked();
    if (kind === "updates" || f.updates?.checked) updatesDone();
    msg.classList.add("ok");
    msg.textContent = kind === "library" ? `Thanks. We'll email you when ${S.libName ? S.libName + "'s" : "your library's"} shelves are ready.` : "Thanks. You're on the list.";
    f.querySelector(".row").hidden = true; f.querySelector(".check")?.remove();
    const card = f.closest("#updToast"); if (card) setTimeout(() => card.remove(), 2500);
  } catch (err) { msg.textContent = err.message; }
});
// The updates sign-up is one small card in the lower right. It shows by itself once per device, a little while
// into the first visit (home page or shelf), and the footer's "Get updates" link brings it back.
function showUpdatesCard() {
  updShown = true;
  if ($("#updToast")) return $("#updToast");
  const card = Object.assign(document.createElement("div"), { id: "updToast", className: "copy-toast upd-toast" });
  card.setAttribute("role", "dialog"); card.setAttribute("aria-label", "Get updates");
  card.innerHTML = `<img class="upd-ico" src="/icons/icon-192.png" alt="">
    <div class="ct-body"><b>Want email updates?</b>
    <form class="email-form" data-kind="updates" novalidate><div class="row"><input type="email" name="email" autocomplete="email" placeholder="Your email" required aria-label="Your email"><input class="hp" name="website" tabindex="-1" autocomplete="off" aria-hidden="true"><button type="submit">Sign up</button></div><p class="err" role="status" aria-live="polite"></p></form></div>
    <button class="ct-x" type="button" aria-label="Dismiss">\u00d7</button>`;
  card.querySelector(".ct-x").onclick = () => card.remove();
  document.body.append(card);
  return card;
}
$("#updatesFoot").onclick = () => showUpdatesCard().querySelector("input[type=email]")?.focus();
// Chris 11.1.26: the card shows on EVERY visit (once per page load, a few seconds in) until this device signs up for
// updates; closing it only hides it for this visit. It waits while a pop-up is open, the filling-in card is showing,
// or someone is typing in the library box.
let updAskTimer = null, updShown = false;
const updatesDone = () => { try { localStorage.setItem("nl-updates-done", "1"); } catch {} };
const isUpdatesDone = () => { try { return !!localStorage.getItem("nl-updates-done"); } catch { return false; } };
function maybeAskUpdates() {
  if (updAskTimer || updShown || isUpdatesDone()) return;
  updAskTimer = setTimeout(() => {
    updAskTimer = null;
    const busy = document.querySelector("dialog[open]") || $("#copyToast") || (document.activeElement?.id === "pickInput" && $("#pickInput").value);
    if (busy) return maybeAskUpdates();
    if (updShown || isUpdatesDone()) return;
    showUpdatesCard();
  }, window.__nlAskMs || 4000);
}
let websiteOnly = null;     // a library website with no catalog we could find: "Browse movies anyway" still works
function openOther(d) {
  if (d.unknown || !d.catalog) {
    websiteOnly = { name: d.name || "", catalog: d.catalog };
    $("#pickErr").innerHTML = `That looks like your library's website. Open its catalog, the page where you search for books, and paste that link instead. <button class="link" type="button" id="browseAnyway">Or browse movies anyway</button>`;
    return;
  }
  const lib = { name: d.name || "", catalog: d.catalog };
  requestLibrary(lib);
  enterGuest(lib);
}

async function chooseLibrary(q, demo = false) {
  $("#pickErr").textContent = "";
  const looking = setTimeout(() => { $("#pickErr").textContent = "Opening…"; }, 300);
  try {
    const info = await api("/api/library?q=" + encodeURIComponent(q));
    clearTimeout(looking); $("#pickErr").textContent = "";
    S.lib = info.slug; S.libName = info.name; S.demo = demo; S.shelf = "all"; S.sort = ""; clearFilter("all"); S.fmt = "all";
    rememberLib(); save(); boot();
    if (!demo) libraryPicked();
  } catch (e) {
    clearTimeout(looking); $("#pickErr").textContent = "";
    if (e.data?.unsupported) openOther(e.data);
    else $("#pickErr").textContent = e.message;
  }
}
const isLink = v => /^\S+\.[a-z]{2,}(\/\S*)?$/i.test(v.replace(/^https?:\/\//i, ""));
function openTyped() {
  const v = $("#pickInput").value.trim();
  if (!v) { $("#pickErr").textContent = "Paste your library's catalog link first. The 3 steps below show where to find it."; return; }
  if (!isLink(v)) { $("#pickErr").textContent = "That doesn't look like a link. Paste the web address of your library's catalog. The 3 steps below show where to find it."; return; }
  chooseLibrary(v);
}

// ---- back button -------------------------------------------------------------------

// Each open window owns one history step. Closing one steps back (selfBack keeps that step from closing the window
// under it, e.g. the trailer over the movie page); the Back button closes the window on top.
let popClosing = false, selfBack = 0;
const openStack = [];
for (const d of document.querySelectorAll("dialog")) {
  d.showModal = function () {
    if (this.open) return;
    HTMLDialogElement.prototype.showModal.call(this);
    openStack.push(this);
    history.pushState({ nl: "dialog" }, "");
  };
  d.addEventListener("close", () => {
    const i = openStack.lastIndexOf(d); if (i >= 0) openStack.splice(i, 1);
    if (!popClosing && history.state?.nl === "dialog") { selfBack++; history.back(); }
  });
}
addEventListener("popstate", () => {
  if (selfBack) { selfBack--; return; }
  const open = openStack.filter(d => d.open).pop() || [...document.querySelectorAll("dialog")].find(d => d.open);
  if (open) { popClosing = true; open.close(); popClosing = false; return; }
  if (history.state?.nl === "dialog") return history.back();
  if (!$("#shelf").hidden && history.state?.nl !== "shelf") showHome(true);
  else if ($("#shelf").hidden && history.state?.nl === "shelf" && S.lib) boot(true);
});

function showHome(fromPop) {
  if (!fromPop && history.state?.nl === "shelf") history.replaceState({ nl: "home" }, "", "/");
  $("#pick").hidden = false; $("#shelf").hidden = true;
  $("#libBtn").hidden = true;   // the home page has its own "Back to" button
  if (S.lib) loadSnap();
  $("#resume").hidden = !S.lib;
  if (S.lib) $("#resume").textContent = `Back to ${isMine() ? "all my libraries" : S.libName || (isGuest() ? "your library" : S.lib)}`;
  $("#pickInput").value = ""; $("#pickErr").textContent = "";
  window.scrollTo(0, 0);
  paintCopyToast();
  maybeAskUpdates();
}

function shelfLink(e) {
  if (!e) e = isMine() ? { lib: MINE } : { lib: S.lib, name: S.libName, guest: S.guest };
  if (e.lib === MINE) return "/?lib=mine";
  if (e.lib === GUEST) {
    const cat = e.guest?.catalog?.url || (e === S || (!e.guest && isGuest()) ? guestCatalog()?.url : "") || "";
    return cat ? "/?lib=shelf&catalog=" + encodeURIComponent(cat) : "/?lib=shelf";
  }
  return "/?lib=" + encodeURIComponent(e.lib);
}

function boot(fromPop) {
  if (S.lib && !fromPop && history.state?.nl !== "shelf") history.pushState({ nl: "shelf" }, "", shelfLink());
  counts();
  if (!S.lib) { showHome(); $("#libBtn").hidden = true; return; }
  $("#pick").hidden = true; $("#shelf").hidden = false;
  $("#libBtn").hidden = false; $("#libBtn").textContent = isMine() ? "All my libraries" : S.libName || (isGuest() ? "Your library" : S.lib);
  paintControls(); setTab("browse"); reload();
  if (isGuest()) upgradeGuest();
  maybeAskUpdates();
}

$("#fmt").onclick = e => { const b = e.target.closest("button"); if (!b) return; S.fmt = b.dataset.fmt; save(); paintControls(); reload(); };
$("#sort").onchange = () => { S.sort = $("#sort").value; save(); reload(); };
$("#searchForm").onsubmit = e => { e.preventDefault(); $("#q").blur(); liveQ = !instant() && !!$("#q").value.trim() ? liveQ : false; reload(); };
let typing;
$("#q").addEventListener("input", () => { clearTimeout(typing); typing = setTimeout(() => { liveQ = false; if (instant() || SNAP?.ver) reload(); }, 180); });
$("#q").addEventListener("search", () => { if (!$("#q").value) { liveQ = false; reload(); } });
document.querySelector(".tabs").onclick = e => { const b = e.target.closest("button"); if (b) setTab(b.dataset.tab); };
$("#pickForm").onsubmit = e => { e.preventDefault(); $("#pickInput").blur(); openTyped(); };
// a pasted link opens by itself, no need to find the button
$("#pickInput").addEventListener("paste", () => setTimeout(() => { if (isLink($("#pickInput").value.trim())) openTyped(); }, 0));
$("#pickInput").addEventListener("input", () => { $("#pickErr").textContent = ""; });
$("#trySeattle").onclick = () => chooseLibrary("seattle", true);
document.addEventListener("click", e => { if (e.target.id === "browseAnyway") enterGuest(websiteOnly || {}); });
$("#libBtn").onclick = () => openLibs();
// ---- your libraries: switch, combine, add, remove (Chris 11.1.26: people have more than one library card) ----------
function switchLib(e) {
  if (e === MINE) { S.lib = MINE; S.libName = "All my libraries"; }
  else { S.lib = e.lib; S.libName = e.name; if (e.lib === GUEST) S.guest = e.guest || {}; }
  S.demo = false; S.shelf = "all"; S.sort = isGuest() ? "pop" : ""; clearFilter("all"); S.fmt = "all";
  toastDismissed = "";
  if ($("#account").open) $("#account").close();
  save(); setTimeout(() => { boot(); history.replaceState({ nl: "shelf" }, "", shelfLink()); }, 60);
}
function openLibs() {
  const cur = isMine() ? MINE : libKey({ lib: S.lib, name: S.libName, guest: S.guest });
  const row = (e, i) => `<div class="lib-row"><button class="btn${libKey(e) === cur ? "" : " ghost"}" data-lib-i="${i}"${libKey(e) === cur ? ' aria-current="true"' : ""}>${esc(e.name || (e.lib === GUEST ? "Your library" : e.lib))}</button><button class="copy-lib" data-lib-copy="${i}" aria-label="Copy link for ${esc(e.name || "this library")}">Copy link</button>${S.libs.length > 1 ? `<button class="x-lib" data-lib-x="${i}" aria-label="Remove ${esc(e.name || "this library")}">×</button>` : ""}</div>`;
  const both = readableLibs().length >= 2;
  acctView(`<h2>Your libraries</h2>
    <p>${S.libs.length > 1 ? "Switch between your library cards, or see them all on one shelf." : "Have more than one library card? Add another and see them all on one shelf."}</p>
    <div class="stack">
      ${both ? `<button class="btn${isMine() ? "" : " ghost"}" data-lib-mine${isMine() ? ' aria-current="true"' : ""}>All my libraries together</button>` : ""}
      ${S.libs.map(row).join("")}
      <button class="btn ghost" id="addLib">+ Add another library card</button>
    </div>`);
  if (!$("#account").open) $("#account").showModal();
  $("#acctBody").onclick = async ev => {
    const t = ev.target.closest("button"); if (!t) return;
    if (t.hasAttribute("data-lib-mine")) return switchLib(MINE);
    if (t.dataset.libCopy != null) {
      const e = S.libs[+t.dataset.libCopy]; if (!e) return;
      const link = location.origin + shelfLink(e);
      try { await navigator.clipboard?.writeText(link); toast("Link copied."); }
      catch { prompt("Copy this link", link); }
      return;
    }
    if (t.dataset.libI != null) return switchLib(S.libs[+t.dataset.libI]);
    if (t.dataset.libX != null) {
      const gone = S.libs.splice(+t.dataset.libX, 1)[0];
      if (gone && (libKey(gone) === cur || (isMine() && readableLibs().length < 2))) { save(); return switchLib(S.libs[0]); }
      save(); return openLibs();
    }
    if (t.id === "addLib") { $("#account").close(); setTimeout(() => { showHome(); $("#pickInput").focus(); }, 120); }
  };
}
$("#home").onclick = e => { e.preventDefault(); showHome(); };
$("#resume").onclick = () => boot();
$("#acctBtn").onclick = openAccount;
// ---- feedback (Chris 11.1.26): saved to D1 `feedback`, read with tools/feedback.sh; problems become GitHub issues via tools/feedback_issues.py --------------------------------
function openFeedback() {
  acctView(`<h2>Send feedback</h2>
    <p>Something broken, confusing or missing? Tell us.</p>
    <p class="fb-gh">Your message stays private. We post the problem itself, without your name or email, on <a href="https://github.com/Chrisgpresents/nomad-library/issues" target="_blank" rel="noopener noreferrer">GitHub</a>, where anyone can follow the fix or help.</p>
    <form class="fb-form" id="fbForm" novalidate><div class="stack">
      <textarea name="message" maxlength="4000" required aria-label="Your feedback"></textarea>
      <input type="email" name="email" autocomplete="email" placeholder="Your email, if you'd like a reply" aria-label="Your email, if you'd like a reply">
      <input class="hp" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
      <p class="err" role="status" aria-live="polite"></p>
      <button class="btn" type="submit">Send</button>
    </div></form>`);
  if (!$("#account").open) $("#account").showModal();
  const f = $("#fbForm"); f.message.focus();
  f.onsubmit = async e => {
    e.preventDefault();
    const msg = f.querySelector(".err"), btn = f.querySelector("button[type=submit]");
    if (f.message.value.trim().length < 3) { msg.textContent = "Write a few words first."; return; }
    btn.disabled = true; msg.textContent = "Sending…";
    try {
      await api("/api/feedback", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: f.message.value, email: f.email.value, website: f.website.value, lib: S.libName || S.lib || "", page: $("#pick")?.hidden ? "shelf" : "home" }) });
      acctView(`<h2>Thanks</h2><p>We read every message.</p><button class="btn" data-close style="width:100%">Done</button>`);
    } catch (err) { msg.textContent = err.message; btn.disabled = false; }
  };
}
$("#fbBtn").onclick = openFeedback;

// ---- trailers play on the page (Chris 11.1.26); Cmd/Ctrl/middle-click still opens a new tab, and so does "Watch on YouTube"
document.addEventListener("click", async e => {
  const a = e.target.closest("a[data-trailer]");
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
  e.preventDefault();
  const q = new URL(a.href).searchParams.get("q") || "";
  const box = $("#trailer"), body = $("#trailerBody");
  const bar = link => `<div class="tr-bar"><a href="${esc(link)}" target="_blank" rel="noopener noreferrer">Watch on YouTube</a><button type="button" data-close>Close</button></div>`;
  body.innerHTML = `<div class="frame"><div class="tr-msg">Finding the trailer…</div></div>${bar(a.href)}`;
  box.showModal();
  try {
    const d = await (await fetch("/t?format=json&q=" + encodeURIComponent(q), { signal: AbortSignal.timeout(12000) })).json();
    if (!box.open) return;
    body.innerHTML = d.vid
      ? `<div class="frame"><iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(d.vid)}?autoplay=1&rel=0&modestbranding=1" title="Trailer" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe></div>${bar("https://www.youtube.com/watch?v=" + d.vid)}`
      : `<div class="frame"><div class="tr-msg">We couldn't find a trailer for this one.</div></div>${bar(d.search)}`;
  } catch { if (box.open) body.innerHTML = `<div class="frame"><div class="tr-msg">The trailer didn't load.</div></div>${bar(a.href)}`; }
});
$("#trailer").addEventListener("close", () => { $("#trailerBody").innerHTML = ""; });   // stops the video
document.addEventListener("click", e => {
  const o = e.target.closest("[data-open]"); if (o) { const r = rowsById.get(o.dataset.open); if (r) openDetail(r); return; }
  const f = e.target.closest("[data-fav]"); if (f) { toggleFav(f.dataset.fav); return; }
  if (e.target.closest("[data-close]")) e.target.closest("dialog").close();
});
for (const d of document.querySelectorAll("dialog")) d.addEventListener("click", e => { if (e.target === d) d.close(); });
async function importWatchlist(f) {
  if (!f) return;
  const w = readWatchlist(await f.text());
  if (!w.items.length) { $("#wlStatus").textContent = "That file doesn't look like an IMDb or Letterboxd watchlist export."; return; }
  S.watch = { ...w, imported: Date.now(), matches: {} };
  save(); matchWatchlist();
}
$("#wlFile").onchange = () => importWatchlist($("#wlFile").files[0]);
// A file dropped on the box imports like a picked one (without this the browser offers to save it).
$("#drop").addEventListener("dragover", e => { e.preventDefault(); $("#drop").classList.add("over"); });
$("#drop").addEventListener("dragleave", () => $("#drop").classList.remove("over"));
$("#drop").addEventListener("drop", e => { e.preventDefault(); $("#drop").classList.remove("over"); importWatchlist(e.dataTransfer.files[0]); });
new IntersectionObserver(es => { if (es[0].isIntersecting && !$("#shelf").hidden && !$("#browse").hidden && S.lib) loadMore(); }, { rootMargin: "800px" }).observe($("#more"));
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});

// The shelf starts loading right away. The account check runs alongside it.
// Every visit opens on the home page. A saved library gets a one-tap "Back to" button there.
// One anonymous tick per device per day, so we know roughly how many people use the site. No ID, no cookie.
function countVisit() {
  try {
    const day = new Date().toISOString().slice(0, 10);
    if (localStorage.getItem("nl-day") === day) return;
    const fresh = !localStorage.getItem("nl-seen");
    fetch("/api/visit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ new: fresh }), keepalive: true })
      .then(r => { if (r.ok) { localStorage.setItem("nl-day", day); localStorage.setItem("nl-seen", "1"); } }).catch(() => {});
  } catch { /* storage unavailable: skip rather than count the same device again and again */ }
}
countVisit();

const params = new URLSearchParams(location.search);
const linked = params.get("lib");
const linkedCat = params.get("catalog");
// library.nomadovernormal.com/?updates (the video description link) opens straight on the updates sign-up card.
const wantsUpdates = params.has("updates");
history.replaceState({ nl: "home" }, "", "/");
if (linked === MINE) { if (readableLibs().length >= 2) { S.lib = MINE; S.libName = "All my libraries"; boot(); } else showHome(); }
else if (isReaderLib(linked)) enterReader({ name: linked === S.lib ? S.libName : "" }, linked);
else if (linked === GUEST && linkedCat) chooseLibrary(linkedCat);
else if (linked && linked !== GUEST) chooseLibrary(linked, linked !== S.lib || !!S.demo);
else showHome();
if (wantsUpdates) showUpdatesCard().querySelector("input[type=email]")?.focus();
counts();
refreshMe().then(() => {
  if (!me.uid) return;
  const keep = linked ? { lib: S.lib, libName: S.libName, demo: S.demo } : null;
  mergeIn(me.data);
  if (keep?.lib) Object.assign(S, keep);   // a shared link wins for this visit
  store.set(S);
  if ($("#pick").hidden) counts(); else showHome();
  });
