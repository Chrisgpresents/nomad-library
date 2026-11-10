// Real-browser checks of the site's catalog loading, with the whole network mocked (nothing leaves the machine).
//   node test/browser.mjs [scenario-name-fragment]
// Needs Chrome (CHROME_PATH, or the usual Mac/Linux install) and puppeteer-core (npm install). Run tools/fetch_data.sh first. Large fixtures use the real catalogs published for
// the six finished libraries when available (set FIXTURE_DIR), otherwise generated rows.
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { pathToFileURL } from "node:url";

let puppeteer;
try { puppeteer = createRequire(import.meta.url)("puppeteer-core"); }
catch { puppeteer = createRequire(path.join(os.homedir(), "node_modules") + "/")("puppeteer-core"); }
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const PUBLIC = path.join(ROOT, "public");
const { shape } = await import(pathToFileURL(path.join(ROOT, "lib/core.js")).href);
const { onRequestGet: libraryApi } = await import(pathToFileURL(path.join(ROOT, "functions/api/library.js")).href);
// The real /api/library runs here in Node against a fake internet: library homepages from W.websites / W.pages,
// and BiblioCommons answering only for the libraries in W.libs.
const cacheStore = new Map();
globalThis.caches = { default: { async match(k) { return cacheStore.get(k.url)?.clone(); }, async put(k, r) { cacheStore.set(k.url, r.clone()); } } };
async function realLibraryApi(W, url) {
  cacheStore.clear();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const u = new URL(String(input?.url || input));
    const g = u.href.match(/gateway\.bibliocommons\.com\/v2\/libraries\/([a-z0-9-]+)$/);
    if (g) { const hit = W.libs.find(l => l[0] === g[1]); return hit ? Response.json({ entities: { libraries: { [hit[0]]: { longName: hit[1], cmsUrl: `https://www.${Object.keys(W.websites).find(h => W.websites[h] === hit[0]) || hit[0] + ".org"}` } } } }) : new Response("{}", { status: 404 }); }
    const host = u.hostname.replace(/^www\./, "");
    const html = W.pages[host] ?? (W.websites[host] ? `<a href="https://${W.websites[host]}.bibliocommons.com/v2/search">Catalog</a>` : null);
    if (html == null) return new Response("nope", { status: 404 });
    const r = new Response(html, { status: W.walled?.[host] ? 403 : 200, headers: { "content-type": "text/html" } });
    Object.defineProperty(r, "url", { value: u.href });
    return r;
  };
  try {
    const env = { DB: { prepare: () => ({ bind: (...a) => ({ first: async () => { const hit = W.libs.find(l => l[0] === a[0]); return hit ? { slug: hit[0], name: hit[1] } : null; }, run: async () => ({}) }) }) } };
    const res = await libraryApi({ request: new Request(url), env, waitUntil() {} });
    return { status: res.status, body: await res.text() };
  } finally { globalThis.fetch = realFetch; }
}
const CHROME = process.env.CHROME_PATH || ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium"].find(p => fs.existsSync(p));
const FIXTURE_DIR = process.env.FIXTURE_DIR || "";
const ONLY = process.argv[2] || "";
const HOST = "library.nomadovernormal.com", SNAPHOST = "nomad-library-copies.pages.dev";
let pass = 0, fail = 0;
const results = [];
const ok = (c, msg) => { c ? pass++ : fail++; console.log(`  ${c ? "pass" : "FAIL"}: ${msg}`); };
const note = (k, v) => { results.push([k, v]); console.log(`  measure: ${k} = ${v}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MIME = { html: "text/html", js: "text/javascript", css: "text/css", json: "application/json", png: "image/png", woff2: "font/woff2", svg: "image/svg+xml", webmanifest: "application/manifest+json", ico: "image/x-icon", txt: "text/plain" };
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

// ---- fixtures ---------------------------------------------------------------------------------------
function makeRows(slug, n, { games = 0, prefix = slug.toUpperCase() } = {}) {
  const G = ["horror", "comedy", "drama", "action,thriller", "scifi", "family,animation", "documentary", "romance"];
  const rows = [];
  for (let i = 0; i < n; i++) {
    const g = i >= n - games;
    rows.push([`S${slug}C${i}`, g ? `${prefix} Game ${i}` : `${prefix} Movie ${i} ${["Alpha", "Bravo", "Charlie", "Delta"][i % 4]}`, "", g ? "g" : i % 2 ? "b" : "d",
      2000 + (i % 25), "", i % 3 ? 1 : 0, i % 5, g ? "" : G[i % G.length], 0, g ? ["Switch", "PS5", "Xbox One"][i % 3] : "",
      g ? 0 : +(4 + (i % 50) / 10).toFixed(1), g ? 0 : 1000 + i * 3, g ? "" : `tt${1000000 + i}`, g ? 0 : 1990 + (i % 35)]);
  }
  return rows;
}
const snapBody = (rows, finished = Date.now()) => zlib.gzipSync(JSON.stringify({ ver: finished, finished, total: rows.length, sc: "", rows }));
function realRows(slug) {
  if (!FIXTURE_DIR) return null;
  for (const f of [`${slug}.json`, `${slug}.json.gz`]) {
    const p = path.join(FIXTURE_DIR, f);
    if (fs.existsSync(p)) { const b = fs.readFileSync(p); return JSON.parse(f.endsWith("gz") ? zlib.gunzipSync(b) : b); }
  }
  return null;
}

const DIR_DEFAULT = [
  ["Alpha Public Library", "Alphaville", "AA", 1000, "alpha"], ["Beta Public Library", "Betatown", "BB", 900, "beta"], ["Gamma Public Library", "Gammaburg", "GG", 800, "gamma"],
  ["Burlington County Library", "Westampton", "NJ", 363983, "bclsnj"], ["Chicago Public Library", "Chicago", "IL", 2746388, "chipublib"], ["Seattle Public Library", "Seattle", "WA", 762500, "seattle"],
  ["San Francisco Public Library", "San Francisco", "CA", 873965, "sfpl"], ["Alameda County Library", "Fremont", "CA", 400000, "aclibrary"], ["Algonquin Area Public Library District", "Algonquin", "IL", 30000, "aapld"],
  ["New York Public Library", "New York", "NY", 8800000, "nypl"],
  ["Roxbury Public Library", "Succasunna", "NJ", 22950, 0], ["Roxbury Library Association", "Roxbury", "NY", 2247, 0], ["Roxbury Free Public Library", "Roxbury", "VT", 1030, 0],
  ["Denville Free Public Library", "Denville", "NJ", 17107, 0], ["Free Library of Philadelphia", "Philadelphia", "PA", 1603797, 0],
  ["Robeson County Public Library", "Lumberton", "NC", 130000, 0], ["Malden Public Library", "Malden", "MA", 60000, 0],
  ["Pottsville Free Public Library", "Pottsville", "PA", 60113, 0], ["Pottstown Regional Public Library", "Pottstown", "PA", 45318, 0],
];
const TYPED = { alpha: "Alpha Public", beta: "Beta Public", gamma: "Gamma Public", bclsnj: "Burlington County", chipublib: "Chicago Public", seattle: "Seattle Public", sfpl: "San Francisco", aclibrary: "Alameda County", aapld: "Algonquin", nypl: "New York Public" };

// ---- the mocked world ---------------------------------------------------------------------------------
function world(over = {}) {
  return {
    libs: [["bclsnj", "Burlington County Library System"], ["alpha", "Alpha Public Library"], ["beta", "Beta Public Library"], ["gamma", "Gamma Public Library"], ["seattle", "The Seattle Public Library"], ["chipublib", "Chicago Public Library"], ["nypl", "The New York Public Library"]],
    snap: {},                    // slug -> { status, body, delay, headers }
    dir: DIR_DEFAULT, websites: {}, pages: {}, walled: {}, learned: {}, requests: [],
    me: { uid: null }, puts: [], wants: [], reqs: [], snapReqs: [], searchReqs: [], availReqs: [], oldSnapCalls: 0, searchFail: false, ...over,
  };
}
function liveItem(slug, id) {
  const n = +String(id).replace(/\D/g, "") || 0;
  return shape(slug, `L${slug}${n}`, { briefInfo: { title: `${slug.toUpperCase()} Live ${n}`, subtitle: "", format: n % 2 ? "BLURAY" : "DVD", publicationDate: "2011", subjectHeadings: [], genreForm: [] }, availability: { status: "AVAILABLE", availableCopies: 1, totalCopies: 2, heldCopies: 0 } });
}

async function newPage(browser, W, { ctx, seedState, idbBroken, viewport, askEmail } = {}) {
  const context = ctx || (await browser.createBrowserContext());
  const page = await context.newPage();
  await page.setViewport(viewport || { width: 1280, height: 900 });
  await page.setRequestInterception(true);
  const cdp = await page.createCDPSession(); await cdp.send("Network.setBypassServiceWorker", { bypass: true });
  await page.evaluateOnNewDocument((seed, broken, askEmail) => {
    if (navigator.serviceWorker) navigator.serviceWorker.register = () => new Promise(() => {});
    if (seed && !localStorage.getItem("nl")) localStorage.setItem("nl", JSON.stringify(seed));
    if (!askEmail) { localStorage.setItem("nl-email-asked", "1"); localStorage.setItem("nl-updates-done", "1"); } else window.__nlAskMs = 1500;   // the one-time updates prompt stays out of other tests
    if (broken) Object.defineProperty(window, "indexedDB", { get() { throw new Error("storage blocked"); } });
  }, seedState || null, !!idbBroken, !!askEmail);
  page.errors = [];
  page.on("pageerror", e => page.errors.push(String(e)));
  page.on("request", async req => {
    const u = new URL(req.url()), t0 = Date.now();
    const done = (status, body, type = "application/json", extra = {}) => req.respond({ status, contentType: type, body, headers: { "access-control-allow-origin": "*", ...extra } }).catch(() => {});
    try {
      if (u.hostname === SNAPHOST && W.realSnapHost) return req.continue();   // let this one go to the real GitHub host
      if (u.hostname === SNAPHOST) {
        const slug = decodeURIComponent(u.pathname.split("/").pop()).replace(/\.json\.gz$/, "");
        W.snapReqs.push({ slug, t: t0 });
        const f = W.snap[slug];
        if (!f) return done(404, "Not Found", "text/html");
        if (f.delay) await sleep(f.delay);
        if (f.abort) return req.abort("connectionfailed").catch(() => {});
        return done(f.status || 200, f.body ?? Buffer.alloc(0), f.type || "application/gzip");
      }
      if (u.hostname !== HOST) return u.pathname.match(/\.(gif|jpe?g|png)$/i) || u.hostname.includes("syndetics") ? done(200, GIF, "image/gif") : done(204, "");
      W.reqs.push(u.pathname);
      if (u.pathname.startsWith("/api/")) {
        const p = u.pathname;
        if (p === "/api/me") { if (req.method() === "PUT") { const b = JSON.parse(req.postData() || "{}"); W.puts.push(b); if (W.me.uid) W.me.data = b.data; return done(200, '{"ok":true}'); } return done(200, JSON.stringify(W.me)); }
        if (p === "/api/libs") return done(200, JSON.stringify(W.libs));
        if (p === "/api/library") { const r = await realLibraryApi(W, u.href); return done(r.status, r.body); }
        if (p === "/api/request") {
          const b = JSON.parse(req.postData() || "{}"); W.requests.push(b);
          if (b.name && b.st && b.url && !W.learned[`${b.name}|${b.st}`]) W.learned[`${b.name}|${b.st}`] = b.url;
          return done(200, '{"ok":true}');
        }
        if (p === "/api/catalogs") return done(200, JSON.stringify(W.learned));
        if (p === "/api/notify") { (W.notifies ||= []).push(JSON.parse(req.postData() || "{}")); return done(200, '{"ok":true}'); }
        if (p === "/api/auth/code-signup") { W.me = { uid: "new1", data: JSON.parse(req.postData() || "{}").data || {}, passkeys: 0 }; return done(200, JSON.stringify({ ok: true, code: "ABCD-EFGH-JKLM-NPQR" })); }
        if (p === "/api/want") { W.wants.push(JSON.parse(req.postData() || "{}").lib); return done(200, '{"ok":true}'); }
        if (p === "/api/visit") { (W.visits ||= []).push(JSON.parse(req.postData() || "{}")); return done(200, '{"ok":true}'); }
        if (p === "/api/snap") { W.oldSnapCalls++; return done(200, '{"ver":0,"building":true}'); }
        if (p === "/api/search") {
          W.searchReqs.push(u.search);
          if (W.searchFail) return done(502, JSON.stringify({ error: "The library's catalog didn't answer. Try again in a minute." }));
          const lib = u.searchParams.get("lib"), pg = +u.searchParams.get("page") || 1;
          if (W.searchDelay) await sleep(W.searchDelay);
          return done(200, JSON.stringify({ total: 100, page: pg, pages: 4, rows: Array.from({ length: 25 }, (_, i) => liveItem(lib, (pg - 1) * 25 + i)) }));
        }
        if (p === "/api/avail") { W.availReqs.push(u.search); const out = {}; for (const id of (u.searchParams.get("ids") || "").split(",")) out[id] = { avail: false, copies: 0, total: 3, holds: 7 }; return done(200, JSON.stringify(out)); }
        return done(404, JSON.stringify({ error: "not mocked" }));
      }
      if (u.pathname === "/directory.json") return done(200, JSON.stringify({ v: 1, libs: W.dir }), "application/json", { "cache-control": "no-store" });
      let rel = u.pathname === "/" ? "/index.html" : u.pathname;
      let file = path.join(PUBLIC, rel);
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = fs.existsSync(file + ".html") ? file + ".html" : path.join(PUBLIC, "index.html");
      const ext = path.extname(file).slice(1);
      return done(200, fs.readFileSync(file), MIME[ext] || "application/octet-stream", { "cache-control": "no-store" });
    } catch (e) { req.abort().catch(() => {}); }
  });
  return { page, context };
}

async function openSaved(page) {          // every visit opens on the home page; a saved library gets a "Back to" button
  await page.waitForSelector("#resume:not([hidden])", { timeout: 15000 });
  await page.click("#resume");
}
const cards = page => page.$$eval("#grid .card", els => els.length);
const status = page => page.$eval("#status", e => e.textContent).catch(() => "");
async function waitCards(page, min = 1, timeout = 20000) {
  const t0 = Date.now();
  await page.waitForFunction(m => document.querySelectorAll("#grid .card").length >= m, { timeout, polling: 20 }, min);
  const t = Date.now() - t0;
  await page.evaluate(() => { const d = document.querySelector("#guestIntro"); if (d?.open) d.close(); });   // the one-time explanation for libraries we can't read
  if (await page.evaluate(() => history.state?.nl === "dialog")) await sleep(150);
  return t;
}
const titles = page => page.$$eval("#grid .card", els => els.slice(0, 40).map(e => e.textContent));
async function pickLibrary(page, slug) {
  await page.waitForSelector("#pickInput", { visible: true });
  await page.type("#pickInput", `https://${slug}.bibliocommons.com/v2/search`);
  await page.evaluate(() => document.querySelector("#pickForm").requestSubmit());
}

// The shelf shows one card per film (DVD, Blu-ray and reissues fold together; the first record speaks for the card).
// Written out here on its own so the expected counts don't come from the app's code.
function oneCardPerFilm(rows) {
  const art = /^(the|a|an|le|la|les|el|los|il)\s+/i;
  const nm = t => String(t || "").toLowerCase().trim().replace(/\s*[:(\[].*$/, "").replace(/&/g, " and ").replace(/[^a-z0-9 ]+/g, " ").replace(art, "").replace(/\s+/g, " ").trim();
  const seen = new Set(), out = [];
  for (const r of rows) {
    if (r[3] === "g") continue;
    const k = nm(r[1]) + "|" + (r[13] || r[4] || "") + "|" + (r[9] ? nm(r[2]) : "");
    if (!seen.has(k)) { seen.add(k); out.push(r); }
  }
  return out;
}

// ---- scenarios -----------------------------------------------------------------------------------------
const SCENARIOS = [];
const scenario = (name, fn) => SCENARIOS.push([name, fn]);

scenario("cold first visit, large real catalog: usable shelf time, then search/filters/games/detail", async b => {
  const rows = realRows("bclsnj") ? realRows("bclsnj").rows : makeRows("bclsnj", 28000, { games: 1600 });
  const W = world({ snap: { bclsnj: { body: snapBody(rows.length ? rows : []), delay: 700 } } });
  W.snap.bclsnj.body = snapBody(rows);
  const { page } = await newPage(b, W);
  await page.goto(`https://${HOST}/`, { waitUntil: "domcontentloaded" });
  const t0 = Date.now(); await pickLibrary(page, "bclsnj");
  const tCards = await waitCards(page, 12);
  await page.waitForFunction(() => /\d[\d,]* titles/.test(document.querySelector("#status").textContent), { timeout: 20000 });
  const tUsable = Date.now() - t0;
  note("cold first usable shelf (ms, incl. 700 ms simulated host latency, 1 copy of " + rows.length + " rows)", tUsable);
  const st = await status(page);
  const n = +st.match(/([\d,]+) titles/)[1].replace(/,/g, "");
  ok(n > 10000 && !/loads live|copied|background/.test(st), `instant mode: "${st.slice(0, 80)}"`);
  ok(tUsable < 4500, `first usable shelf under 4.5 s (${tUsable} ms)`);
  ok(W.oldSnapCalls === 0 && W.searchReqs.length === 0, "no live search or old /api/snap call was needed");
  // search is local and instant
  const t1 = Date.now(); await page.type("#q", "zzzunlikely"); await page.waitForFunction(() => /^0 titles|Nothing/.test(document.querySelector("#status").textContent + document.querySelector("#more").textContent), { timeout: 5000 });
  note("local search response (ms)", Date.now() - t1);
  await page.$eval("#q", e => { e.value = ""; e.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.waitForFunction(() => /\d[\d,]* titles/.test(document.querySelector("#status").textContent), { timeout: 5000 });
  // games tab
  await page.click('#fmt button[data-fmt="games"]');
  await page.waitForFunction(() => /games/.test(document.querySelector("#status").textContent), { timeout: 5000 });
  const gs = await status(page); ok(/\d[\d,]* games/.test(gs), `games tab: ${gs.slice(0, 40)}`);
  await page.click('#fmt button[data-fmt="all"]');
  // filters dialog opens and applies
  await page.click("#filtBtn"); await sleep(150);
  ok(await page.$eval("#filters", d => d.open), "filters dialog opens");
  await page.evaluate(() => document.querySelector("#filters").close()); await sleep(100);
  // detail + live availability
  await page.waitForSelector("#grid .card");
  await page.click("#grid .card"); await sleep(400);
  ok(await page.$eval("#detail", d => d.open), "detail opens");
  ok(W.availReqs.length >= 1, "live shelf check requested for the opened title");
  ok(page.errors.length === 0, `no page errors ${page.errors.slice(0, 1)}`);
});

scenario("genres combine: picked genres widen, Foreign and TV narrow, with the year range; chips remove one at a time", async b => {
  const real = realRows("chipublib");
  const rows = real ? real.rows : makeRows("chipublib", 6000);
  const W = world({ snap: { chipublib: { body: snapBody(rows) } } });
  const { page } = await newPage(b, W);
  await page.goto(`https://${HOST}/`, { waitUntil: "domcontentloaded" });
  await pickLibrary(page, "chipublib");
  await waitCards(page, 12);
  await page.waitForFunction(() => /\d[\d,]* titles/.test(document.querySelector("#status").textContent), { timeout: 20000 });
  // the expected counts come straight from the rows, without the app's code
  const G = r => new Set(r[8] ? r[8].split(",") : []), Y = r => r[14] || r[4] || 0;
  const films = oneCardPerFilm(rows);
  const expect = (pick, y0 = 0, y1 = 9999) => {
    const narrow = pick.filter(g => g === "foreign" || g === "tv"), wide = pick.filter(g => !narrow.includes(g));
    return films.filter(r => { const g = G(r), y = Y(r);
      return (!y0 || (y && y >= y0)) && (y1 === 9999 || (y && y <= y1)) && narrow.every(n => g.has(n)) && (!wide.length || wide.some(w => g.has(w))); }).length;
  };
  const shown = async () => { const t = await status(page); const m = t.match(/([\d,]+) titles/); return m ? +m[1].replace(/,/g, "") : -1; };
  const pick = async k => { await page.click(`#filtBody [data-genre="${k}"]`); await sleep(60); };
  const setYears = (a, z) => page.evaluate((a, z) => {
    const y0 = document.querySelector("#y0"), y1 = document.querySelector("#y1");
    y0.value = a; y0.dispatchEvent(new Event("input", { bubbles: true })); y1.value = z; y1.dispatchEvent(new Event("input", { bubbles: true }));
  }, a, z);
  const close = async () => { await page.evaluate(() => document.querySelector("#filters").close()); await sleep(250); };
  // horror + thriller + crime, 1950 to 1985
  await page.click("#filtBtn"); await sleep(150);
  for (const k of ["horror", "thriller", "crime"]) await pick(k);
  const pressed = await page.$$eval('#filtBody [data-genre][aria-pressed="true"]', e => e.map(x => x.dataset.genre));
  ok(pressed.join() === "horror,thriller,crime", `three genres stay picked together (${pressed})`);
  await setYears(1950, 1985);
  const btn = await page.$eval("#filtShow", e => e.textContent);
  await close();
  const e1 = expect(["horror", "thriller", "crime"], 1950, 1985), s1 = await shown();
  ok(s1 === e1 && e1 > 0, `horror or thriller or crime, 1950 to 1985: ${s1} shown, ${e1} expected`);
  ok(btn.includes(e1.toLocaleString()), `the Show button counted the same (${btn})`);
  const tags = await page.$$eval("#active .tag", e => e.map(x => x.textContent.replace("×", "").trim()));
  ok(tags.join("|") === "Horror|Thriller|Crime|1950 to 1985", `one chip per genre plus the years (${tags.join("|")})`);
  // removing one chip removes only that genre
  await page.click('#active [data-clear="genre:thriller"]'); await sleep(250);
  const e2 = expect(["horror", "crime"], 1950, 1985), s2 = await shown();
  ok(s2 === e2, `thriller chip removed: horror or crime ${s2} shown, ${e2} expected`);
  // foreign + horror = foreign horror films
  await page.click("#filtBtn"); await sleep(150);
  await page.click('#filtBody [data-genre=""]'); await sleep(60);
  await pick("foreign"); await pick("horror"); await setYears(1920, new Date().getFullYear());
  await close();
  const e3 = expect(["foreign", "horror"]), s3 = await shown();
  ok(s3 === e3 && e3 > 0 && e3 < expect(["horror"]), `foreign horror: ${s3} shown, ${e3} expected (horror alone ${expect(["horror"])})`);
  // comedy + romance widen
  await page.click("#filtBtn"); await sleep(150);
  await page.click('#filtBody [data-genre=""]'); await sleep(60);
  await pick("comedy"); await pick("romance"); await pick("romance"); await pick("romance");
  await close();
  const e4 = expect(["comedy", "romance"]), s4 = await shown();
  ok(s4 === e4 && e4 > expect(["comedy"]), `comedy or romance (romance toggled off and on): ${s4} shown, ${e4} expected`);
  // Movies only narrows to non-TV rows, and picking TV shows unpicks it
  await page.click("#filtBtn"); await sleep(150);
  await pick("movies");
  await close();
  const isTv = r => !!r[9] || G(r).has("tv");
  const e5 = expect(["comedy", "romance"]) - oneCardPerFilm(rows).filter(r => isTv(r) && (G(r).has("comedy") || G(r).has("romance"))).length, s5 = await shown();
  ok(s5 === e5 && e5 > 0 && e5 <= e4, `comedy or romance, movies only: ${s5} shown, ${e5} expected`);
  await page.click("#filtBtn"); await sleep(150);
  await pick("tv");
  const p5 = await page.$$eval('#filtBody [data-genre][aria-pressed="true"]', e => e.map(x => x.dataset.genre));
  ok(p5.includes("tv") && !p5.includes("movies"), `TV shows and Movies only exclude each other (${p5})`);
  await close();
  // a collection still replaces genres, and All clears them
  await page.click("#filtBtn"); await sleep(150);
  await page.click('#filtBody [data-coll="criterion"]'); await sleep(60);
  ok((await page.$$eval('#filtBody [data-genre][aria-pressed="true"]', e => e.length)) === 0, "picking a collection clears the genres");
  await close();
  ok(page.errors.length === 0, `no page errors ${page.errors.slice(0, 1)}`);
});

scenario("search finds actors, directors and genres", async b => {
  const real = realRows("chipublib");
  if (!real) { ok(true, "skipped: needs FIXTURE_DIR with chipublib.json.gz (real IMDb ids)"); return; }
  const rows = real.rows;
  const W = world({ snap: { chipublib: { body: snapBody(rows) } } });
  const { page } = await newPage(b, W);
  await page.goto(`https://${HOST}/`, { waitUntil: "domcontentloaded" });
  await pickLibrary(page, "chipublib");
  await waitCards(page, 12);
  await page.waitForFunction(() => /\d[\d,]* titles/.test(document.querySelector("#status").textContent), { timeout: 20000 });
  const count = async () => { const m = (await status(page)).match(/([\d,]+) titles/); return m ? +m[1].replace(/,/g, "") : -1; };
  const titles = () => page.$$eval("#grid .ttl", e => e.map(x => x.firstChild.textContent));
  const search = async q => { await page.$eval("#q", e => { e.value = ""; }); await page.type("#q", q); await sleep(1200); };
  // expected answers straight from the data files, without the app's code
  const films = oneCardPerFilm(rows), num = r => r[13] ? +String(r[13]).replace(/\D+/g, "") : 0;
  const people = k => JSON.parse(fs.readFileSync(path.join(PUBLIC, "ix/people", k + ".json"), "utf8"));
  const spielberg = new Set(people("sp")["steven spielberg"]);
  const want = films.filter(r => spielberg.has(num(r))).length;
  await search("spielberg");
  ok(want > 3 && (await count()) >= want, `"spielberg" finds his films (${await count()} shown, ${want} directed or acted in by him)`);
  await search("steven spielberg");
  const t2 = await titles();
  ok(t2.length > 3 && t2.some(t => /jaws|jurassic|raiders|e\.t\./i.test(t)), `"steven spielberg" shows his films (${t2.slice(0, 4).join(" | ")})`);
  const hanks = new Set(people("ha")["tom hanks"]);
  await search("tom hanks");
  try { await page.screenshot({ path: path.join(os.tmpdir(), "nl-search-tom-hanks.png") }); } catch {}
  const nh = await count(), wantH = films.filter(r => hanks.has(num(r))).length;
  ok(wantH > 3 && nh >= wantH && nh < wantH * 2, `"tom hanks" finds his films (${nh} shown, ${wantH} with him)`);
  await search("horror");
  const nHorror = films.filter(r => (r[8] || "").split(",").includes("horror")).length;
  ok((await count()) >= nHorror && nHorror > 50, `typing "horror" finds the horror genre (${await count()} shown, ${nHorror} tagged horror)`);
  await search("godfather");
  const wantG = films.filter(r => /godfather/i.test(r[1] + " " + r[2])).length;
  ok((await count()) === wantG, `"godfather" still finds titles only (${await count()} shown, ${wantG} titles or subtitles say Godfather)`);
  await search("zzzunlikely");
  ok((await count()) === 0, "nonsense still finds nothing");
});

scenario("a genre saved before genres could combine still opens as that one genre", async b => {
  const real = realRows("chipublib");
  const rows = real ? real.rows : makeRows("chipublib", 6000);
  const W = world({ snap: { chipublib: { body: snapBody(rows) } } });
  const { page } = await newPage(b, W, { seedState: { lib: "chipublib", libName: "Chicago Public Library", fmt: "all", genre: "western" } });
  await page.goto(`https://${HOST}/`, { waitUntil: "domcontentloaded" });
  await openSaved(page);
  await page.waitForFunction(() => /\d[\d,]* titles/.test(document.querySelector("#status").textContent), { timeout: 20000 });
  const n = oneCardPerFilm(rows).filter(r => (r[8] || "").split(",").includes("western")).length;
  const t = await status(page);
  ok(t.startsWith(n.toLocaleString() + " titles"), `old saved 'western' still filters (${t.slice(0, 30)}, expected ${n})`);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("nl")));
  ok(Array.isArray(saved.genres) && saved.genres.join() === "western" && !("genre" in saved), `saved as a list now (${JSON.stringify(saved.genres)})`);
  ok(page.errors.length === 0, `no page errors ${page.errors.slice(0, 1)}`);
});

scenario("REAL copy host: the six finished libraries each open from GitHub in a fresh browser, then again warm", async b => {
  const libs = [["bclsnj", "Burlington County Library System", 28749], ["chipublib", "Chicago Public Library", 29538], ["seattle", "The Seattle Public Library", 19268], ["sfpl", "San Francisco Public Library", 41180], ["aclibrary", "Alameda County Library", 24201], ["aapld", "Algonquin Area Public Library", 16474]];
  const counts = {};
  for (const [slug, name, total] of libs) {
    const W = world({ realSnapHost: true, libs: libs.map(l => [l[0], l[1]]) });
    const { page, context } = await newPage(b, W);          // a brand new browser profile: nothing cached
    await page.goto(`https://${HOST}/`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#pickInput", { visible: true }); await page.type("#pickInput", `https://${slug}.bibliocommons.com/`);
    const t0 = Date.now(); await page.evaluate(() => document.querySelector("#pickForm").requestSubmit());
    await page.waitForFunction(n => document.querySelector("#libBtn").textContent.includes(n) && /\d[\d,]* titles/.test(document.querySelector("#status").textContent) && document.querySelectorAll("#grid .card").length >= 12, { timeout: 30000 }, name.split(" ")[0]);
    const dt = Date.now() - t0, st = await status(page), n = +st.match(/([\d,]+) titles/)[1].replace(/,/g, "");
    counts[slug] = n;
    note(`cold ${slug} (${total.toLocaleString()} titles) first usable shelf from the real GitHub host (ms)`, dt);
    ok(n > total * 0.5 && n <= total && !/live|copied|background/.test(st), `${slug}: instant mode with ${n.toLocaleString()} titles (copy has ${total.toLocaleString()} rows)`);
    ok(W.searchReqs.length === 0 && W.oldSnapCalls === 0, `${slug}: no live search or old snapshot call`);
    await sleep(900);                                          // let it finish saving to the device
    await page.close();
    W.realSnapHost = false; W.snap[slug] = { abort: true };   // now the copy host is unreachable
    const p2 = (await newPage(b, W, { ctx: context })).page;
    await p2.goto(`https://${HOST}/`, { waitUntil: "domcontentloaded" });
    const t1 = Date.now(); await openSaved(p2);
    await p2.waitForFunction(() => /\d[\d,]* titles/.test(document.querySelector("#status").textContent) && document.querySelectorAll("#grid .card").length >= 12, { timeout: 15000 });
    note(`warm ${slug} repeat visit, tap Back to library -> shelf, host unreachable (ms)`, Date.now() - t1);
    const n2 = +(await status(p2)).match(/([\d,]+) titles/)[1].replace(/,/g, "");
    ok(n2 === counts[slug], `${slug}: warm visit shows the same ${n2.toLocaleString()} titles`);
    await context.close();
  }
});

scenario("repeat visit: device copy opens at once, even with the copy host unreachable", async b => {
  const rows = makeRows("alpha", 8000, { games: 300 });
  const W = world({ snap: { alpha: { body: snapBody(rows), delay: 300 } } });
  const { page, context } = await newPage(b, W);
  await page.goto(`https://${HOST}/`, { waitUntil: "domcontentloaded" });
  await pickLibrary(page, "alpha"); await waitCards(page, 12);
  await sleep(600);   // let the copy finish saving to this device
  await page.close();
  W.snap.alpha = { abort: true };                         // now the copy host is unreachable
  W.snapReqs.length = 0;
  const p2 = (await newPage(b, W, { ctx: context })).page;
  const t0 = Date.now(); await p2.goto(`https://${HOST}/`, { waitUntil: "domcontentloaded" });
  await openSaved(p2); await waitCards(p2, 12);
  note("repeat visit: open site + tap Back to library -> shelf, host unreachable (ms)", Date.now() - t0);
  const st = await status(p2);
  ok(Date.now() - t0 < 2500, `opened from the device copy in under 2.5 s (${Date.now() - t0} ms)`);
  ok(/\d[\d,]* titles/.test(st) && !/live|copied/.test(st), `instant mode: "${st.slice(0, 60)}"`);
  ok(W.searchReqs.length === 0, "no live search needed");
});

scenario("old device copy (30 days) still opens immediately offline; refreshes when the host is back", async b => {
  const old = Date.now() - 30 * 864e5;
  const W = world({ snap: { alpha: { body: snapBody(makeRows("alpha", 3000), old) } } });
  const { page, context } = await newPage(b, W);
  await page.goto(`https://${HOST}/`, { waitUntil: "domcontentloaded" });
  await pickLibrary(page, "alpha"); await waitCards(page, 12); await sleep(500); await page.close();
  W.snap.alpha = { delay: 400, body: snapBody(makeRows("alpha", 3500), Date.now()) };
  const p2 = (await newPage(b, W, { ctx: context })).page;
  const t0 = Date.now(); await p2.goto(`https://${HOST}/`, { waitUntil: "domcontentloaded" });
  await openSaved(p2); await waitCards(p2, 12);
  ok(Date.now() - t0 < 2500, `a 30 day old copy is used immediately (${Date.now() - t0} ms)`);
  ok(/3,000 titles|\d,\d{3} titles/.test(await status(p2)), "shows the saved copy first");
  await sleep(1500);
  W.snap.alpha = { abort: true };
  const p3 = (await newPage(b, W, { ctx: context })).page;
  await p3.goto(`https://${HOST}/`, { waitUntil: "domcontentloaded" }); await openSaved(p3); await waitCards(p3, 12);
  const s3 = await status(p3);
  ok(/3,500 titles/.test(s3) || /3,[45]\d\d titles/.test(s3), `the background refresh was saved (${s3.slice(0, 30)})`);
});

scenario("uncopied library: live shelf quickly, one 'wanted' note, no loops", async b => {
  const W = world({});
  const { page, context } = await newPage(b, W);
  await page.goto(`https://${HOST}/`, { waitUntil: "domcontentloaded" });
  const t0 = Date.now(); await pickLibrary(page, "beta");
  const t = await waitCards(page, 12);
  note("uncopied library first live shelf (ms)", Date.now() - t0);
  ok(Date.now() - t0 < 3500, `live shelf starts promptly (${Date.now() - t0} ms)`);
  await sleep(600);
  const toast = await page.$eval("#copyToast", e => ({ text: e.textContent, r: e.getBoundingClientRect().toJSON(), vw: innerWidth, vh: innerHeight })).catch(() => null);
  ok(toast && /library's filling in\. You can browse while we prepare the full collection/.test(toast.text), `corner card says it: "${toast?.text.slice(0, 90)}"`);
  ok(toast && toast.r.right > toast.vw - 40 && toast.r.bottom > toast.vh - 40 && toast.r.right <= toast.vw, `card sits in the lower right (right ${Math.round(toast?.r.right)} of ${toast?.vw}, bottom ${Math.round(toast?.r.bottom)} of ${toast?.vh})`);
  ok(!/filling in/.test(await status(page)) && /^\d+ titles/.test((await status(page)).trim()), `status line is just the count: "${(await status(page)).trim()}"`);
  ok(!/\d{3,} (hours|minutes)|tomorrow/.test(toast?.text || ""), "no promised time");
  await page.click("#copyToast [data-ct-close]"); await sleep(150);
  ok(!(await page.$("#copyToast")), "dismiss closes the card");
  await page.evaluate(() => document.querySelector("#sort").dispatchEvent(new Event("change", { bubbles: true }))); await sleep(900);
  ok(!(await page.$("#copyToast")), "it stays dismissed for this library while browsing");
  ok(W.wants.length === 1 && W.wants[0] === "beta", `registered once (${W.wants.length})`);
  const before = W.snapReqs.length;
  await sleep(2500);
  ok(W.snapReqs.length === before && W.snapReqs.length <= 2, `no copy-host request loop (${W.snapReqs.length} requests)`);
  await page.close();
  const p2 = (await newPage(b, W, { ctx: context })).page;
  await p2.goto(`https://${HOST}/`, { waitUntil: "domcontentloaded" }); await openSaved(p2); await waitCards(p2, 12); await sleep(500);
  ok(W.wants.length === 1, "a second visit the same day does not register again");
  ok(W.oldSnapCalls === 0, "old /api/snap never called");
});

scenario("copy host unreachable on a first visit: live shelf, registered once, no loop", async b => {
  const W = world({ snap: { gamma: { abort: true } } });
  const { page, context } = await newPage(b, W);
  await page.goto(`https://${HOST}/`, { waitUntil: "domcontentloaded" });
  const t0 = Date.now(); await pickLibrary(page, "gamma"); await waitCards(page, 12);
  ok(Date.now() - t0 < 3500, `live shelf anyway (${Date.now() - t0} ms)`);
  await sleep(2500);
  ok(W.wants.length === 1 && W.wants[0] === "gamma", `registered once despite a transient failure (${W.wants.length})`);
  ok(W.snapReqs.length === 1, `one attempt, not a retry loop (${W.snapReqs.length} requests)`);
  const tt = await page.$eval("#copyToast", e => e.textContent).catch(() => "");
  ok(/Couldn't reach the saved collection/.test(tt), `corner card is honest: "${tt.slice(0, 70)}"`);
});

scenario("slow copy: browse live at once, copy joins later without yanking a search", async b => {
  const rows = makeRows("alpha", 6000);
  const W = world({ snap: { alpha: { body: snapBody(rows), delay: 5000 } } });
  const { page } = await newPage(b, W);
  await page.goto(`https://${HOST}/`, { waitUntil: "domcontentloaded" });
  const t0 = Date.now(); await pickLibrary(page, "alpha"); await waitCards(page, 12);
  ok(Date.now() - t0 < 3500, `live shelf shown before the slow copy (${Date.now() - t0} ms)`);
  ok((await titles(page))[0].includes("Live"), "showing live results");
  await page.waitForFunction(() => /6,000 titles|\d,\d{3} titles/.test(document.querySelector("#status").textContent) && !document.querySelector("#grid .card").textContent.includes("Live"), { timeout: 12000 });
  ok(!(await page.$("#copyToast")), "switched to the instant copy once it arrived (no search was active), and the card is gone");
  // second half: an active search must not be replaced
  const W2 = world({ snap: { beta: { body: snapBody(makeRows("beta", 6000)), delay: 5000 } } });
  const p2 = (await newPage(b, W2)).page;
  await p2.goto(`https://${HOST}/`, { waitUntil: "domcontentloaded" });
  await pickLibrary(p2, "beta"); await waitCards(p2, 12);
  await p2.type("#q", "Live 3"); await p2.evaluate(() => document.querySelector("#searchForm").requestSubmit()); await sleep(900);
  const before = await titles(p2);
  await sleep(6000);
  const after = await titles(p2);
  ok(JSON.stringify(before) === JSON.stringify(after) && (await p2.$eval("#q", e => e.value)) === "Live 3", "an active search is left alone when the copy arrives");
  const ready = await p2.$eval("#copyToast", e => e.textContent).catch(() => "");
  ok(/ready/.test(ready) && /Open it/.test(ready), `a ready card appears instead (${ready.slice(0, 50)})`);
  await p2.$eval("#q", e => { e.value = ""; e.dispatchEvent(new Event("input", { bubbles: true })); }); await sleep(300);
  await p2.click("#openReadyCopy"); await p2.waitForFunction(() => /\d,\d{3} titles/.test(document.querySelector("#status").textContent), { timeout: 8000 });
  ok(!(await p2.$("#copyToast")), "opening the full collection removes the card");
});

scenario("bad static data: corrupt, wrong shape, HTML 200, truncated gzip all fall back to live and are never saved", async b => {
  const good = JSON.stringify({ ver: 1, finished: Date.now(), total: 2, sc: "", rows: makeRows("alpha", 2) });
  const cases = { corrupt: Buffer.from("not json at all"), htmlok: Buffer.from("<html>home</html>"), shape: zlib.gzipSync(JSON.stringify({ rows: [[1, 2, 3]], finished: Date.now() })), trunc: zlib.gzipSync(good).subarray(0, 20), empty: zlib.gzipSync(JSON.stringify({ rows: [], finished: Date.now() })) };
  for (const [name, body] of Object.entries(cases)) {
    const W = world({ snap: { alpha: { body } } });
    const { page, context } = await newPage(b, W);
    await page.goto(`https://${HOST}/`, { waitUntil: "domcontentloaded" });
    await pickLibrary(page, "alpha"); await waitCards(page, 12);
    ok((await titles(page))[0].includes("Live"), `${name}: falls back to live results`);
    await sleep(300); await page.close();
    const p2 = (await newPage(b, W, { ctx: context })).page;
    await p2.goto(`https://${HOST}/`, { waitUntil: "domcontentloaded" }); await openSaved(p2); await waitCards(p2, 12);
    ok((await titles(p2))[0].includes("Live"), `${name}: nothing bad was saved on the device`);
    await p2.close();
  }
});

scenario("IndexedDB unavailable: site still works, copy re-downloaded", async b => {
  const W = world({ snap: { alpha: { body: snapBody(makeRows("alpha", 3000)), delay: 200 } } });
  const { page } = await newPage(b, W, { idbBroken: true });
  await page.goto(`https://${HOST}/`, { waitUntil: "domcontentloaded" });
  await pickLibrary(page, "alpha"); await waitCards(page, 12);
  await page.waitForFunction(() => /\d,\d{3} titles/.test(document.querySelector("#status").textContent), { timeout: 8000 });
  ok(true, "instant copy works without any storage");
  ok(page.errors.length === 0, `no page errors ${page.errors.slice(0, 1)}`);
});

scenario("rapid library switching: a slow copy for the library you left never replaces the current one", async b => {
  const W = world({ snap: { alpha: { body: snapBody(makeRows("alpha", 3000)), delay: 6000 }, beta: { body: snapBody(makeRows("beta", 3000)), delay: 100 } } });
  const { page } = await newPage(b, W);
  await page.goto(`https://${HOST}/`, { waitUntil: "domcontentloaded" });
  await pickLibrary(page, "alpha"); await sleep(300);
  await page.evaluate(() => document.querySelector("#libBtn").click()); await sleep(200); await page.evaluate(() => document.querySelector("#addLib")?.click()); await sleep(300);
  // back on the home page: choose the other library
  await page.waitForSelector("#pickInput", { visible: true });
  await page.$eval("#pickInput", e => { e.value = ""; }); await page.type("#pickInput", "https://beta.bibliocommons.com/");
  await page.evaluate(() => document.querySelector("#pickForm").requestSubmit());
  await waitCards(page, 12);
  await page.waitForFunction(() => /\d,\d{3} titles/.test(document.querySelector("#status").textContent), { timeout: 8000 });
  await sleep(7000);   // alpha's slow copy has arrived by now
  const t = await titles(page);
  ok(t.every(x => x.includes("BETA")), `still showing Beta after Alpha's copy arrived (${t[0]})`);
  ok(await page.$eval("#libBtn", e => /Beta/.test(e.textContent)), "header still names Beta");
});

scenario("live failure does not retry forever; Try again works", async b => {
  const W = world({ searchFail: true });
  const { page } = await newPage(b, W);
  await page.goto(`https://${HOST}/`, { waitUntil: "domcontentloaded" });
  await pickLibrary(page, "gamma"); await sleep(5000);
  const n1 = W.searchReqs.length;
  ok(n1 >= 1 && n1 <= 3, `a failed first page is not retried in a loop (${n1} requests in 5 s)`);
  ok(!!(await page.$("#retryMore")), "a Try again button is shown");
  W.searchFail = false;
  await page.click("#retryMore"); await waitCards(page, 12, 8000);
  ok(true, "Try again loads the shelf");
});

scenario("favorites, watchlist and account state: a signed-in account's data is shown and saved, nothing is deleted", async b => {
  const fav = { id: "Salphac3", title: "ALPHA Movie 3 Delta", sub: "", f: "d", fmt: "DVD", disc: 2003, img: null, avail: true, holds: 0, genres: [], tv: false, plat: "", r: 0, v: 0, imdb: null, fy: null, url: "https://alpha.bibliocommons.com/v2/record/Salphac3", n: 3, lib: "alpha", added: Date.now() };
  const data = { lib: "alpha", libName: "Alpha Public Library", faves: { "alpha:Salphac3": fav }, watch: null };
  const W = world({ me: { uid: "u1", data, passkeys: 1 }, snap: { alpha: { body: snapBody(makeRows("alpha", 400)) } } });
  const { page } = await newPage(b, W);
  await page.goto(`https://${HOST}/`, { waitUntil: "domcontentloaded" });
  await openSaved(page); await waitCards(page, 12, 15000);
  ok(await page.$eval("#acctBtn", e => !/Sign in/.test(e.textContent)), "account button shows signed-in state");
  await page.evaluate(() => document.querySelector('[data-tab="faves"]').click()); await sleep(500);
  ok((await page.$$eval("#favGrid .card", e => e.length)) >= 1, "the saved favorite is listed");
  await page.evaluate(() => document.querySelector('[data-tab="browse"]').click()); await sleep(200);
  await page.click("#grid .card"); await sleep(300);
  await page.click("#detailBody [data-fav]"); await sleep(3800);     // saves are batched for 3 s
  ok(W.puts.length >= 1, `saved to the account (${W.puts.length} PUT)`);
  const last = W.puts[W.puts.length - 1].data || {};
  ok(Object.keys(last.faves || {}).length >= 2 && !!last.faves["alpha:Salphac3"], `the earlier favorite is kept alongside the new one (${Object.keys(last.faves || {}).length} total)`);
  ok(!W.reqs.some(r => /delete|logout/.test(r)), "no delete or sign-out request was made");
});

scenario("home page: one box for the catalog link, three steps, a pasted link opens by itself", async b => {
  const W = world({ snap: { seattle: { body: snapBody(makeRows("seattle", 800)) } } });
  const { page } = await newPage(b, W, { viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true } });
  await page.goto(`https://${HOST}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#pickInput", { visible: true }); await sleep(400);
  const home = await page.evaluate(() => ({
    inputs: [...document.querySelectorAll("#pick .hero-card input")].filter(e => e.offsetParent).length,
    buttons: [...document.querySelectorAll("#pick button")].filter(e => e.offsetParent && /open/i.test(e.textContent)).length,
    label: document.querySelector("#pickForm label").textContent, steps: [...document.querySelectorAll(".how-steps li")].map(l => l.textContent),
    list: !!document.querySelector("#libList"), dir: performance.getEntriesByType("resource").some(r => r.name.includes("directory.json")) }));
  ok(home.inputs === 1 && home.buttons === 1, `one box and one Open button (${home.inputs} / ${home.buttons})`);
  ok(home.label === "Paste your library's catalog link" && home.steps.length === 3, `label and 3 steps: "${home.label}"`);
  ok(!home.list && !home.dir, "no town search and no library directory download");
  try { await page.screenshot({ path: path.join(os.tmpdir(), "nl-home-one-box.png") }); } catch {}
  // a name is not a link: a clear line pointing at the steps
  await page.type("#pickInput", "Potsdam Public Library"); await page.evaluate(() => document.querySelector("#pickForm").requestSubmit()); await sleep(200);
  ok(/doesn't look like a link/.test(await page.$eval("#pickErr", e => e.textContent)), "a typed name gets pointed at the 3 steps");
  // pasting a link opens it with no button press
  await page.$eval("#pickInput", e => { e.value = ""; e.focus(); });
  await page.evaluate(() => { const i = document.querySelector("#pickInput"); i.value = "https://roxbury.aspendiscovery.org/?browseCategory=x"; i.dispatchEvent(new ClipboardEvent("paste", { bubbles: true })); });
  await waitCards(page, 12);
  ok(/Roxbury/.test(await page.$eval("#libBtn", e => e.textContent)), "a pasted link opened by itself");
  ok(page.errors.length === 0, `no page errors ${page.errors.slice(0, 1)}`);
});

scenario("a library we cannot read yet: browse the nationwide shelf and check titles at your library", async b => {
  const W = world({ pages: { "robeson.nccardinal.org": "<title>Robeson County Public Library | NC Cardinal</title>" } });
  const { page } = await newPage(b, W);
  await page.goto(`https://${HOST}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#pickInput", { visible: true });
  await page.type("#pickInput", "https://robeson.nccardinal.org/eg/opac/home"); await page.evaluate(() => document.querySelector("#pickForm").requestSubmit());
  const t0 = Date.now();
  await page.waitForSelector("#guestIntro[open]", { timeout: 8000 });
  const intro = await page.$eval("#guestIntro", e => e.textContent.replace(/\s+/g, " "));
  ok(/We can't read Robeson County Public Library's catalog yet/.test(intro) && /Check at Robeson County Public Library/.test(intro) && /Show me the movies/.test(intro), `a clear pop-up explains it: "${intro.slice(2, 90)}"`);
  await waitCards(page, 12);
  note("guest mode: paste a catalog link -> first movies (ms)", Date.now() - t0);
  ok(/Robeson County Public Library/.test(await page.$eval("#libBtn", e => e.textContent)), "header names the library (from its catalog's page title)");
  const st = await status(page); ok(/\d[\d,]* popular movies/.test(st), `a real nationwide shelf: "${st.trim().slice(0, 40)}"`);
  ok((await page.$$("#grid .avail")).length === 0, "no on-the-shelf / all-out labels (we cannot know)");
  ok(!/DVD|Blu-ray/.test((await page.$$eval("#grid .meta", e => e.slice(0, 20).map(x => x.textContent))).join(" ")), "no format shown either");
  ok(await page.$eval("#fmt", e => getComputedStyle(e).display === "none"), "the Both / Blu-ray / DVD / Games switch is hidden");
  ok(await page.$eval("#sort", e => e.value === "pop" && e.options[0].textContent === "Most popular"), "opens on Most popular");
  ok(!(await page.$("#copyToast")), "no corner card on top of the movies");
  ok(/popular movies · Tap one to check it at Robeson County Public Library/.test(await status(page)), `a reminder above the movies: "${(await status(page)).slice(0, 80)}"`);
  await page.type("#q", "godfather"); await sleep(600);
  const sl = await page.$eval("#status a", a => [a.textContent, a.href]).catch(() => null);
  ok(sl && /Search Robeson County Public Library for “godfather”/.test(sl[0]) && sl[1].includes("robeson.nccardinal.org/eg/opac/results?query=godfather"), `a search offers the library's own catalog (${sl?.[0]})`);
  await page.$eval("#q", e => { e.value = ""; e.dispatchEvent(new Event("input")); }); await sleep(500);
  await page.click("#filtBtn"); await sleep(200);
  ok(!(await page.$("#onShelfF")), "the filters have no 'On the shelf now' toggle");
  await page.evaluate(() => document.querySelector("#filters").close()); await sleep(500);
  await page.click("#grid .card .cover"); await sleep(400);
  const d = await page.$eval("#detailBody", e => ({ links: [...e.querySelectorAll("a")].map(a => [a.textContent.trim(), a.href]), text: e.textContent }));
  const check = d.links.find(l => /^Check at/.test(l[0]));
  ok(check && check[0] === "Check at Robeson County Public Library" && check[1].startsWith("https://robeson.nccardinal.org/eg/opac/results?query="), `detail button searches the catalog: "${check?.[0]}"`);
  ok(!/Place a hold|Get in line|On the shelf|All checked out/.test(d.text), "no hold button and no shelf status");
  ok(d.links.some(l => /Trailer/.test(l[0])) && d.links.some(l => /IMDb/.test(l[0])), "trailer and IMDb are still there");
  ok(W.searchReqs.length === 0 && W.availReqs.length === 0 && W.wants.length === 0 && W.oldSnapCalls === 0, "no live search, availability, copy request or old snapshot call");
  // each catalog system: the button searches that library's own catalog, never a web search
  for (const [pasted, expectStart] of [["https://denville.aspendiscovery.org/", "https://denville.aspendiscovery.org/Search/Results?lookfor="],
    ["https://mclinc.polarislibrary.com/polaris/logon.aspx?ctx=1.1033.0.0.1&Header=1", "https://mclinc.polarislibrary.com/polaris/search/searchresults.aspx?ctx=1.1033.0.0.1&type=Keyword&term="],
    ["https://pottsville.chilipac.com/r1s/eg/opac/home", "https://pottsville.chilipac.com/r1s/eg/opac/results?query="],
    ["https://catalog.lacountylibrary.org/client/en_US/default", "https://catalog.lacountylibrary.org/client/en_US/default/search/results?qu="],
    ["https://mdpls.na.iiivega.com/", "https://mdpls.na.iiivega.com/search?query="], ["catalog.freelibrary.org", "https://catalog.freelibrary.org/"]]) {
    await page.evaluate(() => document.querySelector("#detail").close()).catch(() => {}); await sleep(500);
    await page.evaluate(() => document.querySelector("#libBtn").click()); await sleep(200); await page.evaluate(() => document.querySelector("#addLib")?.click()); await page.waitForSelector("#pickInput", { visible: true });
    await page.$eval("#grid", e => { e.innerHTML = ""; });
    await page.$eval("#pickInput", e => { e.value = ""; }); await page.type("#pickInput", pasted); await page.evaluate(() => document.querySelector("#pickForm").requestSubmit());
    await waitCards(page, 12); await sleep(300); await page.click("#grid .card .cover"); await sleep(400);
    const href = await page.$eval("#detailBody", e => [...e.querySelectorAll("a")].find(a => /^Check at/.test(a.textContent))?.href);
    ok(href && href.startsWith(expectStart) && !/google/.test(href), `${pasted.slice(0, 40)}: searches the library's own catalog (${href?.slice(0, 80)})`);
  }
  ok(!(await page.evaluate(() => document.documentElement.innerHTML)).includes("google.com/search"), "no Google search link anywhere");
  await page.evaluate(() => document.querySelector("#detail").close()).catch(() => {}); await sleep(500);
  await page.evaluate(() => document.querySelector("#libBtn").click()); await sleep(200); await page.evaluate(() => document.querySelector("#addLib")?.click()); await page.waitForSelector("#pickInput", { visible: true });
  await page.$eval("#pickInput", e => { e.value = ""; }); await page.type("#pickInput", "https://robeson.nccardinal.org/eg/opac/home"); await page.evaluate(() => document.querySelector("#pickForm").requestSubmit());
  await sleep(1500);
  ok(!(await page.$("#guestIntro[open]")), "the pop-up shows once per library, not every visit");
  ok(page.errors.length === 0, `no page errors ${page.errors.slice(0, 1)}`);
});

scenario("a Vega catalog: not copied yet = popular shelf + one copy request, then its own shelf when the copy lands", async b => {
  const ID = "vega.sdpl.na5.iiivega.com";
  const rows = makeRows("v", 60).map((r, i) => { r[0] = `fg-${i}-uuid`; return r; });
  const body = zlib.gzipSync(JSON.stringify({ ver: Date.now(), finished: Date.now(), total: rows.length, sc: "", rec: "https://sdpl.na5.iiivega.com/search/card?id={id}&entityType=FormatGroup", sys: "vega", rows }));
  const W = world();
  const { page } = await newPage(b, W);
  await page.goto(`https://${HOST}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#pickInput", { visible: true });
  await page.type("#pickInput", "https://sdpl.na5.iiivega.com/search?query=alien"); await page.evaluate(() => document.querySelector("#pickForm").requestSubmit());
  await page.waitForSelector("#guestIntro[open]", { timeout: 8000 });
  const intro = await page.$eval("#guestIntro", e => e.textContent.replace(/\s+/g, " "));
  ok(/We're copying your library's shelves now/.test(intro) && /within the hour/.test(intro), `the pop-up says it's being copied: "${intro.slice(2, 70)}"`);
  await waitCards(page, 12); await sleep(800);
  ok(/popular movies/.test(await status(page)), "meanwhile: the popular shelf");
  ok(W.wants.filter(w => w === ID).length === 1, `one copy request for ${ID} (${JSON.stringify(W.wants)})`);
  ok(W.searchReqs.length === 0 && W.availReqs.length === 0, "no BiblioCommons live calls for a Vega library");
  // the copy lands: the next visit moves the visitor onto the library's own shelf
  W.snap[ID] = { body };
  await page.reload({ waitUntil: "domcontentloaded" });
  await openSaved(page);
  await page.waitForFunction(() => /titles/.test(document.querySelector("#status")?.textContent || ""), { timeout: 15000 });
  await waitCards(page, 12);
  ok(/\d+ titles/.test(await status(page)), `its own shelf: "${(await status(page)).slice(0, 40)}"`);
  ok(await page.evaluate(() => JSON.parse(localStorage.getItem("nl")).lib) === ID, "the saved library is now the Vega library");
  const libs = await page.evaluate(() => JSON.parse(localStorage.getItem("nl")).libs.map(e => e.lib));
  ok(libs.filter(l => l === "shelf").length === 0 && libs.includes(ID), `the waiting entry was replaced, not duplicated (${libs})`);
  await page.click("#filtBtn"); await sleep(200);
  ok(!(await page.$("[data-coll]")), "no BiblioCommons-only collections in the filters");
  await page.evaluate(() => document.querySelector("#filters").close()); await sleep(400);
  await page.click("#grid .card .cover"); await sleep(400);
  const hold = await page.$eval("#detailBody", e => [...e.querySelectorAll("a.btn")].find(a => /Place a hold|Get in line/.test(a.textContent))?.href);
  ok(hold && hold.startsWith("https://sdpl.na5.iiivega.com/search/card?id=fg-"), `hold button opens the record at the library (${hold})`);
  await sleep(500);
  ok(W.searchReqs.length === 0 && W.availReqs.length === 0, `still no BiblioCommons live calls (${W.searchReqs.length}, ${W.availReqs.length})`);
  await page.evaluate(() => document.querySelector("#detail").close()); await sleep(300);
  await page.type("#q", "movie 3"); await sleep(600);
  const sl = await page.$eval("#status a", a => a.href).catch(() => "");
  ok(sl.startsWith("https://sdpl.na5.iiivega.com/search?query=movie%203"), `searching offers the library's own catalog (${sl})`);
  // a shared link to the Vega library opens it directly
  const { page: p2 } = await newPage(b, W);
  await p2.goto(`https://${HOST}/?lib=${ID}`, { waitUntil: "domcontentloaded" });
  await waitCards(p2, 12);
  ok(/\d+ titles/.test(await status(p2)), "a shared ?lib= link opens the copied Vega library");
  ok(page.errors.length === 0 && p2.errors.length === 0, `no page errors ${page.errors.concat(p2.errors).slice(0, 1)}`);
  // a catalog that reports no shelf status (older LS2 PAC): no "all checked out" anywhere
  const NA = "carl.lima.tlcdelivers.com", naRows = makeRows("n", 60).map(r => { r[6] = 0; return r; });
  W.snap[NA] = { body: zlib.gzipSync(JSON.stringify({ ver: Date.now(), finished: Date.now(), total: 60, sc: "", rec: "https://lima.tlcdelivers.com/#section=resource&resourceid={id}", sys: "carl", na: 1, rows: naRows })) };
  const { page: p3 } = await newPage(b, W);
  await p3.goto(`https://${HOST}/?lib=${NA}`, { waitUntil: "domcontentloaded" });
  await waitCards(p3, 12);
  ok((await p3.$$("#grid .avail")).length === 0, "no shelf labels on cards when the catalog doesn't report them");
  await p3.click("#grid .card .cover"); await sleep(400);
  const t3 = await p3.$eval("#detailBody", e => e.textContent);
  ok(!/All checked out|Get in line|Place a hold/.test(t3) && /See it at/.test(t3), "movie page: no shelf status, a plain 'See it at' link");
});

scenario("finding your library: paste any catalog link or website, no second paste", async b => {
  const W = world({ websites: { "spl.org": "seattle" }, libs: [["seattle", "The Seattle Public Library"], ["alpha", "Alpha Public Library"]], snap: { seattle: { body: snapBody(makeRows("seattle", 800)) } },
    pages: { "pottstownlibrary.org": `<title>Home | Pottstown Regional Public Library</title><a href="https://mclinc.polarislibrary.com/polaris/logon.aspx?ctx=1.1033.0.0.1">Catalog</a>`,
      "smalltownlib.org": `<title>Smalltown Library</title><p>Hours and events</p>`,
      "find.minlib.net": `<title>Attention Required! | Cloudflare</title> find.minlib.net used aspendiscovery` }, walled: { "find.minlib.net": 1 } });
  const { page } = await newPage(b, W);
  await page.goto(`https://${HOST}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#pickInput", { visible: true });
  const paste = async v => {
    if (!(await page.$eval("#pick", e => !e.hidden))) { await page.evaluate(() => document.querySelector("#libBtn").click()); await sleep(200); await page.evaluate(() => document.querySelector("#addLib")?.click()); await page.waitForSelector("#pickInput", { visible: true }); }
    await page.$eval("#grid", e => { e.innerHTML = ""; });      // so the next wait sees the new shelf, not the last one
    await page.$eval("#pickInput", e => { e.value = ""; }); await page.type("#pickInput", v); await page.evaluate(() => document.querySelector("#pickForm").requestSubmit());
  };
  const checkHref = async () => { await page.click("#grid .card .cover"); await sleep(400); const h = await page.$eval("#detailBody", e => { const a = [...e.querySelectorAll("a")].find(a => /^Check at/.test(a.textContent)); return a && [a.textContent, a.href]; }); await page.evaluate(() => document.querySelector("#detail").close()); await sleep(500); return h; };
  // Chris's own example: an Aspen catalog behind a bot wall
  await paste("https://roxbury.aspendiscovery.org/?browseCategory=roxbury_new_york_times_best_sellers");
  await waitCards(page, 12);
  ok(!(await page.$("#nope")), "the Roxbury link goes straight to movies, no second screen");
  ok(/Roxbury/.test(await page.$eval("#libBtn", e => e.textContent)), "named from the link: Roxbury");
  let h = await checkHref();
  ok(h && h[0] === "Check at Roxbury" && h[1].startsWith("https://roxbury.aspendiscovery.org/Search/Results?lookfor="), `Check at Roxbury searches its catalog (${h?.[1]?.slice(0, 70)})`);
  await sleep(300);
  ok(W.requests.some(r => r.host === "roxbury.aspendiscovery.org" && r.vendor === "aspen"), "counted with its catalog system");
  // a library website (not the catalog): we read it, find the catalog, and use the library's name from the page
  await paste("pottstownlibrary.org"); await waitCards(page, 12);
  h = await checkHref();
  ok(h && h[0] === "Check at Pottstown Regional Public Library" && h[1].includes("mclinc.polarislibrary.com/polaris/search/searchresults.aspx"), `a homepage finds its Polaris catalog (${h?.[0]})`);
  // a catalog on its own domain that blocks programs: its block page still names the system
  await paste("find.minlib.net"); await waitCards(page, 12);
  h = await checkHref();
  ok(h && h[1].startsWith("https://find.minlib.net/Search/Results?lookfor="), `a walled catalog on its own domain still gets a title search (${h?.[1]?.slice(0, 60)})`);
  // a website with no catalog link: we ask for the catalog itself, and skipping still works
  await paste("smalltownlib.org");
  await page.waitForSelector("#browseAnyway", { timeout: 4000 });
  ok(/looks like your library's website/.test(await page.$eval("#pickErr", e => e.textContent)), "a website without a catalog link asks for the catalog link, in the same box");
  await page.click("#browseAnyway"); await waitCards(page, 12);
  h = await checkHref();
  ok(h && h[1].startsWith("https://smalltownlib.org"), `skipping still opens movies; Check opens their website (${h?.[1]})`);
  // a BiblioCommons library website opens its real shelf
  await paste("https://www.spl.org/"); await waitCards(page, 12);
  ok(/Seattle/.test(await page.$eval("#libBtn", e => e.textContent)), "pasting a normal library website opens that library");
  // nonsense: a helpful line, nothing counted
  const n0 = W.requests.length;
  await paste("qqzzxxww"); await sleep(400);
  const err = await page.$eval("#pickErr", e => e.textContent);
  ok(/link/.test(err) && !/not found/i.test(err) && W.requests.length === n0, `nonsense gets a helpful line: "${err}"`);
  ok(page.errors.length === 0, `no page errors ${page.errors.slice(0, 1)}`);
});

scenario("sign-up: a new account sets up any library, saves it, and another device opens to it", async b => {
  const W = world({ pages: { "mclinc.polarislibrary.com": "<title>MCLINC Library Catalog</title>" } });
  const { page } = await newPage(b, W);
  await page.goto(`https://${HOST}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#pickInput", { visible: true });
  await page.click("#acctBtn"); await page.waitForSelector("#account[open]");
  const signup = await page.$("#mkCode");
  ok(!!signup, "the sign-in window offers an account");
  await page.evaluate(() => document.querySelector("#mkCode").click());
  await page.waitForFunction(() => /Save this code/.test(document.querySelector("#acctBody")?.textContent || ""), { timeout: 5000 });
  ok(true, "account made, backup code shown");
  await page.evaluate(() => document.querySelector("#savedCode").click()); await sleep(300);
  const step = await page.$eval("#acctBody", e => e.textContent).catch(() => "");
  ok(/set up your library/.test(step) && !!(await page.$("#findLib")), `the library step appears and works: "${step.replace(/\s+/g, " ").slice(0, 60)}"`);
  await page.evaluate(() => document.querySelector("#findLib").click()); await sleep(600);
  ok(await page.$eval("#pickInput", e => document.activeElement === e && !document.querySelector("#account").open), "it hands over to the library search with the box ready");
  await page.type("#pickInput", "https://mclinc.polarislibrary.com/polaris/logon.aspx?ctx=1.1033.0.0.1"); await page.evaluate(() => document.querySelector("#pickForm").requestSubmit());
  await waitCards(page, 12); await sleep(500);
  const last = W.puts[W.puts.length - 1]?.data || {};
  ok(last.lib === "shelf" && last.guest?.catalog?.url?.includes("mclinc.polarislibrary.com") && last.libName === "MCLINC Library Catalog", `the library and its catalog are saved to the account right away (${JSON.stringify({ lib: last.lib, name: last.libName })})`);
  ok(/saved to your account/.test(await page.evaluate(() => document.querySelector(".toast")?.textContent || "")), "a short confirmation");
  ok(page.errors.length === 0, `no page errors ${page.errors.slice(0, 1)}`);
  // another device: signs in, opens straight to the same library with the same Check link
  const W2 = world({ me: { uid: "new1", data: W.me.data, passkeys: 0 } });
  const p2 = (await newPage(b, W2)).page;
  await p2.goto(`https://${HOST}/`, { waitUntil: "domcontentloaded" });
  await openSaved(p2); await waitCards(p2, 12);
  ok(/MCLINC/.test(await p2.$eval("#libBtn", e => e.textContent)), "the other device opens to the same library");
  await p2.click("#grid .card .cover"); await sleep(400);
  const href = await p2.$eval("#detailBody", e => [...e.querySelectorAll("a")].find(a => /^Check at/.test(a.textContent))?.href);
  ok(href?.includes("mclinc.polarislibrary.com/polaris/search/"), "and its Check button searches the same catalog");
  ok(p2.errors.length === 0, `no page errors ${p2.errors.slice(0, 1)}`);
});

scenario("email sign-ups: the lower-right card, the footer link, the can't-read pop-up, and a one-time prompt on the shelf", async b => {
  const W = world({ snap: { alpha: { body: snapBody(makeRows("alpha", 400)) } } });
  const { page, context } = await newPage(b, W, { askEmail: true });
  await page.goto(`https://${HOST}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#pickInput", { visible: true });
  ok(!(await page.$(".updates-box")), "no sign-up box crowding the home page");
  // the little card arrives on its own after a while, lower right
  await page.waitForSelector("#updToast", { timeout: 6000 });
  const pos = await page.$eval("#updToast", e => { const r = e.getBoundingClientRect(); return { right: innerWidth - r.right, bottom: innerHeight - r.bottom, w: r.width }; });
  ok(pos.right < 40 && pos.bottom < 40 && pos.w <= 340, `a small card in the lower right (${JSON.stringify(pos)})`);
  await page.type("#updToast input[type=email]", "not-an-email"); await page.click("#updToast button[type=submit]"); await sleep(200);
  ok(/doesn't look right/.test(await page.$eval("#updToast .err", e => e.textContent)), "a bad email gets a clear line, nothing sent");
  await page.$eval("#updToast input[type=email]", e => { e.value = ""; }); await page.type("#updToast input[type=email]", "reader@example.com"); await page.click("#updToast button[type=submit]"); await sleep(400);
  ok(W.notifies?.length === 1 && W.notifies[0].email === "reader@example.com" && W.notifies[0].kind === "updates", `the card saves an updates sign-up (${JSON.stringify(W.notifies?.[0])})`);
  ok(/on the list/.test(await page.$eval("#updToast .err", e => e.textContent)), "and says thanks");
  await sleep(2800);
  ok(!(await page.$("#updToast")), "then tucks itself away");
  // no Updates button in the nav; the footer link brings the same little card back
  ok(!(await page.$("#updatesBtn, #updatesDlg")), "no Updates button or sign-up dialog, only the card");
  await page.evaluate(() => document.querySelector("#updatesFoot").click());
  await page.waitForSelector("#updToast", { timeout: 2000 });
  const pos2 = await page.$eval("#updToast", e => { const r = e.getBoundingClientRect(); return { right: innerWidth - r.right, bottom: innerHeight - r.bottom, focused: document.activeElement === e.querySelector("input[type=email]") }; });
  ok(pos2.right < 40 && pos2.bottom < 40 && pos2.focused, `the footer's Get updates link pops the same card, ready to type (${JSON.stringify(pos2)})`);
  await page.click("#updToast .ct-x"); await sleep(200);
  // a library we can't read: the pop-up has a notify box, with an optional updates tick
  await page.type("#pickInput", "https://roxbury.aspendiscovery.org/"); await page.evaluate(() => document.querySelector("#pickForm").requestSubmit());
  await page.waitForSelector("#guestIntro[open] .email-form");
  await page.type("#guestIntro input[type=email]", "fan@example.com"); await page.click("#guestIntro input[name=updates]"); await page.click("#guestIntro .email-form button[type=submit]"); await sleep(500);
  const lib = W.notifies.find(n => n.kind === "library"), upd = W.notifies.filter(n => n.email === "fan@example.com" && n.kind === "updates");
  ok(lib && lib.email === "fan@example.com" && lib.lib.url.startsWith("https://roxbury.aspendiscovery.org") && lib.lib.name === "Roxbury" && upd.length === 1, "the pop-up saves 'tell me when Roxbury is ready' with its catalog link, plus updates when ticked");
  ok(/email you when Roxbury's shelves are ready/.test(await page.$eval("#guestIntro .email-form .err", e => e.textContent)), "and says what happens next");
  await page.close();
  // a new device on a real library: the prompt shows once, a little while in
  const W2 = world({ snap: { alpha: { body: snapBody(makeRows("alpha", 400)) } } });
  const p2 = (await newPage(b, W2, { askEmail: true })).page;
  await p2.goto(`https://${HOST}/`, { waitUntil: "domcontentloaded" });
  await pickLibrary(p2, "alpha"); await waitCards(p2, 12);
  await p2.waitForSelector("#updToast", { timeout: 6000 });
  ok(true, "a one-time sign-up prompt appears on the shelf after a short while");
  await p2.type("#updToast input[type=email]", "later@example.com"); await p2.click("#updToast button[type=submit]"); await sleep(400);
  ok(W2.notifies?.[0]?.email === "later@example.com", "the prompt saves the email");
  await p2.click("#updToast .ct-x"); await sleep(200);
  await p2.goto(`https://${HOST}/`, { waitUntil: "domcontentloaded" }); await openSaved(p2); await waitCards(p2, 12); await sleep(3000);
  ok(!(await p2.$("#updToast")), "and never shows again on that device");
  ok(p2.errors.length === 0, `no page errors ${p2.errors.slice(0, 1)}`);
});

scenario("visit counter: one anonymous tick per device per day, new vs returning, silent without storage", async b => {
  const W = world({});
  const { page, context } = await newPage(b, W);
  await page.goto(`https://${HOST}/`, { waitUntil: "domcontentloaded" }); await sleep(600);
  ok(W.visits?.length === 1 && W.visits[0].new === true, `first ever visit sends one tick marked new (${JSON.stringify(W.visits)})`);
  const body = JSON.stringify(W.visits[0]);
  ok(body === '{"new":true}', `the tick carries nothing else (${body})`);
  await page.reload({ waitUntil: "domcontentloaded" }); await sleep(500);
  ok(W.visits.length === 1, "a reload the same day does not count again");
  await page.close();
  const p2 = (await newPage(b, W, { ctx: context })).page;
  await p2.goto(`https://${HOST}/`, { waitUntil: "domcontentloaded" }); await sleep(500);
  ok(W.visits.length === 1, "another tab the same day does not count again");
  await p2.evaluate(() => localStorage.setItem("nl-day", "2000-01-01")); await p2.reload({ waitUntil: "domcontentloaded" }); await sleep(600);
  ok(W.visits.length === 2 && W.visits[1].new === false, `next day: counted again, as a returning device (${JSON.stringify(W.visits[1])})`);
  const W2 = world({});
  const p3 = (await newPage(b, W2)).page;
  await p3.evaluateOnNewDocument(() => { Object.defineProperty(window, "localStorage", { get() { throw new Error("blocked"); } }); });
  await p3.goto(`https://${HOST}/`, { waitUntil: "domcontentloaded" }); await sleep(600);
  ok(!(W2.visits?.length), "storage blocked: no tick at all, so no device is counted over and over");
});

scenario("narrow phone layout: no sideways scrolling on home, shelf, detail", async b => {
  const W = world({ snap: { alpha: { body: snapBody(makeRows("alpha", 3000, { games: 100 })) } } });
  const { page } = await newPage(b, W, { viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true } });
  await page.goto(`https://${HOST}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#pickInput", { visible: true }); await sleep(500);
  const ov = () => page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  let o = await ov(); ok(o.sw <= o.cw, `home: no overflow (${o.sw} vs ${o.cw})`);
  await pickLibrary(page, "alpha"); await waitCards(page, 12); await sleep(500);
  o = await ov(); ok(o.sw <= o.cw, `shelf: no overflow (${o.sw} vs ${o.cw})`);
  const logo = await page.$eval(".brand img", img => {
    const { width, height } = img.getBoundingClientRect();
    return { width, height };
  });
  ok(logo.width === 32 && logo.height === 32, `shelf logo: 32 × 32 (${logo.width} × ${logo.height})`);
  await page.click("#grid .card"); await sleep(500);
  const d = await page.$eval("#detail", e => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, w: innerWidth }; });
  ok(d.l >= -1 && d.r <= d.w + 1, `detail sheet fits the screen (${Math.round(d.l)}..${Math.round(d.r)} of ${d.w})`);
  await page.evaluate(() => document.querySelector("#detail").close()); await sleep(500);   // closing a dialog triggers a delayed history.back()
  await page.evaluate(() => document.querySelector("#libBtn").click()); await sleep(200);
  const lm = await page.$eval("#account", e => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, w: innerWidth }; });
  ok(lm.l >= -1 && lm.r <= lm.w + 1, `library list fits the screen (${Math.round(lm.l)}..${Math.round(lm.r)} of ${lm.w})`);
  await page.evaluate(() => document.querySelector("#addLib")?.click());
  await page.waitForSelector("#pickInput", { visible: true }); await page.type("#pickInput", "https://beta.bibliocommons.com/"); await page.evaluate(() => document.querySelector("#pickForm").requestSubmit());
  await page.waitForSelector("#copyToast", { timeout: 8000 });
  const m = await page.$eval("#copyToast", e => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, b: r.bottom, w: innerWidth, h: innerHeight }; });
  ok(m.l >= 0 && m.r <= m.w && m.b <= m.h, `corner card fits a phone screen (${Math.round(m.l)}..${Math.round(m.r)} of ${m.w})`);
  try { await page.screenshot({ path: path.join(os.tmpdir(), "nl-mobile-toast.png") }); } catch {}
});

scenario("several library cards: the list remembers each library, All my libraries merges them, a hold button per library", async b => {
  const W = world({ snap: { alpha: { body: snapBody(makeRows("alpha", 300, { prefix: "FILM" })) }, beta: { body: snapBody(makeRows("beta", 200, { prefix: "FILM" })) } } });
  const { page } = await newPage(b, W);
  await page.goto(`https://${HOST}/`, { waitUntil: "domcontentloaded" });
  await pickLibrary(page, "alpha"); await waitCards(page, 12);
  await page.evaluate(() => document.querySelector("#libBtn").click()); await sleep(200);
  ok(!(await page.$("[data-lib-mine]")), "one library: no combined option yet");
  await page.evaluate(() => document.querySelector("#addLib").click());
  await pickLibrary(page, "beta");
  await page.waitForFunction(() => /Beta/.test(document.querySelector("#libBtn").textContent) && !document.querySelector("#shelf").hidden, { timeout: 20000 }); await waitCards(page, 12);
  await page.evaluate(() => document.querySelector("#libBtn").click()); await sleep(200);
  const names = await page.$$eval("[data-lib-i]", bs => bs.map(x => x.textContent));
  ok(names.length === 2, `both libraries listed (${names.join(" | ")})`);
  await page.evaluate(() => document.querySelector("[data-lib-mine]").click());
  await page.waitForFunction(() => /from 2 libraries/.test(document.querySelector("#status").textContent), { timeout: 20000 });
  const st = await page.$eval("#status", e => e.textContent);
  ok(/^300 titles/.test(st), `films both libraries carry become one card (${st})`);
  ok(/All my libraries/.test(await page.$eval("#libBtn", e => e.textContent)), "header says All my libraries");
  await page.type("#q", "film movie 7 delta"); await sleep(600);
  await page.evaluate(() => [...document.querySelectorAll("#grid .card")].find(c => c.querySelector(".ttl").textContent.trim() === "FILM Movie 7 Delta").querySelector(".cover").click()); await sleep(500);
  const holds = await page.$$eval("#detailBody .actions a.btn", as => as.filter(a => /at /.test(a.textContent)).map(a => a.href));
  ok(holds.length === 2 && holds.some(h => h.includes("alpha.")) && holds.some(h => h.includes("beta.")), `a hold button for each library (${holds.length})`);
  await page.evaluate(() => document.querySelector("#detail").close()); await sleep(500);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => /from 2 libraries/.test(document.querySelector("#status")?.textContent || ""), { timeout: 20000 }).catch(() => {});
  ok(/All my libraries/.test(await page.$eval("#libBtn", e => e.textContent)), "a reload stays on All my libraries");
  ok(page.errors.length === 0, `no page errors ${page.errors.slice(0, 1)}`);
});

// ---- run ------------------------------------------------------------------------------------------------
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-first-run", "--disable-gpu", ...(process.env.CI ? ["--no-sandbox"] : [])] });
try {
  for (const [name, fn] of SCENARIOS) {
    if (ONLY && !name.includes(ONLY)) continue;
    console.log(`\n== ${name}`);
    try { await Promise.race([fn(browser), sleep(120e3).then(() => { throw new Error("scenario timed out"); })]); }
    catch (e) { fail++; console.log("  FAIL: scenario error:", e.message.split("\n")[0]); }
  }
} finally { await browser.close().catch(() => {}); }
console.log(`\n${pass} passed, ${fail} failed`);
if (results.length) console.log("measurements:", JSON.stringify(Object.fromEntries(results)));
process.exit(fail ? 1 : 0);
