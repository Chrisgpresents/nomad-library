// The website check (/api/library) with the network mocked: pasting any normal library website should find the catalog.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readCatalogLink, readerId, isReaderLib, readerCatalog } from "../public/catalog.js";
import { onRequestGet as library } from "../functions/api/library.js";
import { onRequestPost as request } from "../functions/api/request.js";
import { onRequestPost as notify } from "../functions/api/notify.js";
import { onRequestGet as unsubscribe } from "../functions/api/unsubscribe.js";

const stored = new Map();
globalThis.caches = { default: { async match(k) { return stored.get(k.url)?.clone(); }, async put(k, r) { stored.set(k.url, r.clone()); } } };
const original = globalThis.fetch;
const bc = (slug, site) => Response.json({ entities: { libraries: { [slug]: { longName: `${slug} library`, cmsUrl: site } } } });
// a fake internet: pages by URL, BiblioCommons answers for known slugs
function internet(pages, known) {
  globalThis.fetch = async (url) => {
    const u = String(url);
    const g = u.match(/gateway\.bibliocommons\.com\/v2\/libraries\/([a-z0-9-]+)$/);
    if (g) return known[g[1]] ? bc(g[1], known[g[1]]) : new Response("{}", { status: 404 });
    const p = pages[u] || pages[u.replace(/\/$/, "")];
    if (!p) return new Response("nope", { status: 404 });
    if (p.redirect) { const r = new Response(p.html || "<html></html>", { headers: { "content-type": "text/html" } }); Object.defineProperty(r, "url", { value: p.redirect }); return r; }
    if (p.status) return new Response("blocked", { status: p.status });
    return new Response(p.html, { headers: { "content-type": "text/html" } });
  };
}
const env = (libs = {}) => ({ DB: { prepare: sql => ({ bind: (...a) => ({ first: async () => (libs[a[0]] ? { slug: a[0], name: libs[a[0]] } : null), run: async () => ({}) }) }) } });
const ask = async (q, e = env()) => { const r = await library({ request: new Request("https://x/api/library?q=" + encodeURIComponent(q)), env: e, waitUntil() {} }); return { status: r.status, body: await r.json() }; };

await test("a pasted catalog address works as before", async () => {
  internet({}, { chipublib: "https://www.chipublib.org" });
  const r = await ask("https://chipublib.bibliocommons.com/v2/search?query=x");
  assert.equal(r.status, 200); assert.equal(r.body.slug, "chipublib");
});
await test("a normal library website: the catalog link on its homepage is followed", async () => {
  internet({
    "https://smalltown.org": { html: '<a href="/about">About</a> <a href="https://catalog.smalltown.org/search">Search the catalog</a>' },
    "https://catalog.smalltown.org/search": { redirect: "https://smalltown.bibliocommons.com/v2/search", html: "" },
  }, { smalltown: "https://smalltown.org" });
  const r = await ask("smalltown.org");
  assert.equal(r.status, 200); assert.equal(r.body.slug, "smalltown");
});
await test("a homepage that only links to BiblioCommons somewhere in its text", async () => {
  internet({ "https://lib.example.org": { html: '<script>var u="https://eastport.bibliocommons.com/v2/home"</script>' } }, { eastport: "https://lib.example.org" });
  assert.equal((await ask("https://lib.example.org")).body.slug, "eastport");
});
await test("a guess from the web address is believed only when the library's own site agrees", async () => {
  internet({ "https://nypl.org": { html: "<html>no links</html>" }, "https://spl.org": { html: "<html>no links</html>" } },
    { nypl: "https://nypl.bibliocms.com", spl: "http://bibliocms.com/" });
  assert.equal((await ask("nypl.org")).body.slug, "nypl", "nypl.org -> nypl, its own site is nypl.bibliocms.com");
  const wrong = await ask("spl.org");
  assert.equal(wrong.status, 404, "spl.org must NOT open BiblioCommons' unrelated 'spl' (Stratford)"); assert.equal(wrong.body.unsupported, true);
});
await test("a known library website whose homepage hides its catalog still opens", async () => {
  internet({ "https://vpl.ca": { status: 403 } }, { vpl: "http://bibliocms.com/" });
  assert.equal((await ask("https://www.vpl.ca/")).body.slug, "vpl");
});
await test("another catalog system is recognized from the link alone, with a title search for it", async () => {
  internet({ "https://roxbury.aspendiscovery.org": { status: 403 } }, {});
  const r = await ask("https://roxbury.aspendiscovery.org/?browseCategory=x");
  assert.equal(r.status, 404); assert.equal(r.body.unsupported, true);
  assert.equal(r.body.vendor, "aspen"); assert.equal(r.body.host, "roxbury.aspendiscovery.org"); assert.equal(r.body.name, "Roxbury");
  assert.equal(r.body.catalog.find, "https://roxbury.aspendiscovery.org/Search/Results?lookfor={q}&searchIndex=Keyword&searchSource=local");
  assert.doesNotMatch(r.body.error, /catalog|BiblioCommons/i, "the message never uses jargon");
  // a homepage whose "Catalog" link leads to a Polaris catalog on another domain
  internet({ "https://freelibrary.org": { html: '<title>Home | Free Library of Somewhere</title><a href="https://catalog.freelibrary.org/">Catalog</a>' },
    "https://catalog.freelibrary.org/": { html: '<a href="/polaris/search/default.aspx?ctx=3.1033.0.0.6">Search</a> PowerPAC' } }, {});
  const p = await ask("freelibrary.org");
  assert.equal(p.status, 404); assert.equal(p.body.vendor, "polaris"); assert.equal(p.body.name, "Free Library of Somewhere");
  assert.match(p.body.catalog.find, /^https:\/\/catalog\.freelibrary\.org\/polaris\/search\/searchresults\.aspx\?ctx=1\.1033\.0\.0\.1&type=Keyword&term=\{q\}/);
  // nothing recognizable: the website itself is the fallback, flagged as unknown so the page asks for the catalog link
  internet({ "https://tinylib.org": { html: "<title>Tiny Library</title><p>Hours</p>" } }, {});
  const t = await ask("tinylib.org");
  assert.equal(t.status, 404); assert.equal(t.body.unknown, true); assert.equal(t.body.catalog.url, "https://tinylib.org");
});
await test("Corvina WebPac and the Monguz portal (Szabó Ervin Library, Budapest) are recognized, each with a title search", async () => {
  internet({}, {});
  // not read as Sierra, even though the address has "/WebPac/"
  const a = await ask("https://saman.fszek.hu/WebPac/CorvinaWeb?action=advancedsearchpage");
  assert.equal(a.status, 404); assert.equal(a.body.vendor, "corvina"); assert.equal(a.body.host, "saman.fszek.hu");
  assert.equal(a.body.catalog.find, "https://saman.fszek.hu/WebPac/CorvinaWeb?action=find&index0=ZUTY&text0={q}&textlogic0=and&pagesize=10");
  const b = await ask("https://fszekonline.fszek.hu/search/-/search/clearform");
  assert.equal(b.status, 404); assert.equal(b.body.vendor, "monguz"); assert.equal(b.body.host, "fszekonline.fszek.hu");
  assert.equal(b.body.catalog.find, "https://fszekonline.fszek.hu/search?p_p_id=GenericSearch_WAR_akfweb&p_p_lifecycle=1&p_p_state=normal&p_p_mode=view&_GenericSearch_WAR_akfweb_searchType=simple&term={q}&type=allFields&dbid=solr");
  // a library homepage that links to either one
  internet({ "https://fszek.hu": { html: '<title>Home | Fővárosi Szabó Ervin Könyvtár</title><a href="https://fszekonline.fszek.hu/search/-/search/clearform">Katalógus</a>' } }, {});
  const h = await ask("fszek.hu");
  assert.equal(h.body.vendor, "monguz"); assert.match(h.body.catalog.find, /term=\{q\}/);
});
await test("a Corvina catalog gets a copy id the copier's reader agrees with (nomad-library-data/readers/corvina.mjs libFromUrl)", () => {
  const id = u => readerId(readCatalogLink(u));
  assert.equal(id("https://saman.fszek.hu/WebPac/CorvinaWeb?action=advancedsearchpage"), "corvina.saman.fszek.hu");
  assert.equal(id("https://saman.fszek.hu/WebPac/CorvinaWeb;jsessionid=AB12?action=find"), "corvina.saman.fszek.hu");
  assert.equal(id("https://x.hu/katalogus/CorvinaWeb"), "corvina.x.hu_katalogus-corvinaweb");
  assert.ok(isReaderLib("corvina.saman.fszek.hu"));
  assert.equal(readerCatalog("corvina.saman.fszek.hu").find, "https://saman.fszek.hu/WebPac/CorvinaWeb?action=find&index0=ZUTY&text0={q}&textlogic0=and&pagesize=10");
});
await test("a site that is down or slow returns a controlled answer", async () => {
  globalThis.fetch = async () => { throw new DOMException("timeout", "TimeoutError"); };
  const r = await ask("down.example.org"); assert.equal(r.status, 404); assert.equal(r.body.unsupported, true);
});
await test("counting a request: validated, clipped, one statement", async () => {
  let sql = "", args = [];
  const e = { DB: { prepare: s => ({ first: async () => ({ n: 3 }), bind: (...a) => { sql = s; args = a; return { run: async () => ({}), first: async () => ({ n: 3 }) }; } }) } };
  const post = body => request({ request: new Request("https://x/api/request", { method: "POST", body: JSON.stringify(body) }), env: e });
  assert.equal((await post({})).status, 400);
  assert.equal((await post({ name: "Denville Free Public Library", city: "Denville", st: "nj", vendor: "Aspen Discovery" })).status, 200);
  assert.match(sql, /ON CONFLICT\(key\) DO UPDATE SET n = n \+ 1/); assert.equal(args[3], "NJ");
  await post({ name: "x".repeat(900) }); assert.ok(args[1].length <= 120);
});
await test("email sign-ups: checked, robots ignored, a duplicate is one row, the library's catalog is kept", async () => {
  const rows = new Map();
  const e = { DB: { prepare: sql => ({
    first: async () => ({ n: rows.size }),
    bind: (...a) => ({
      run: async () => { if (/^INSERT INTO emails/.test(sql)) { const k = a.slice(0, 3).join("|"); if (!rows.has(k)) rows.set(k, a); } if (/^DELETE FROM emails/.test(sql)) for (const [k, r] of rows) if (r[0] === a[0]) rows.delete(k); return {}; },
      first: async () => [...rows.values()].find(r => r[6] === a[0]) ? { email: [...rows.values()].find(r => r[6] === a[0])[0] } : null }) }) } };
  const post = body => notify({ request: new Request("https://x/api/notify", { method: "POST", body: JSON.stringify(body) }), env: e });
  assert.equal((await post({ email: "nope" })).status, 400);
  assert.equal((await post({ email: "bot@example.com", website: "http://spam" })).status, 200); assert.equal(rows.size, 0, "the hidden robot field saves nothing");
  assert.equal((await post({ email: " Fan@Example.com ", kind: "library", lib: { name: "Roxbury", url: "https://roxbury.aspendiscovery.org/?browseCategory=x" } })).status, 200);
  await post({ email: "fan@example.com", kind: "library", lib: { name: "Roxbury", url: "https://roxbury.aspendiscovery.org/" } });
  await post({ email: "fan@example.com", kind: "updates" });
  assert.equal(rows.size, 2, "the same library twice is one row; updates is its own row");
  const lib = [...rows.values()].find(r => r[1] === "library");
  assert.deepEqual(lib.slice(0, 6), ["fan@example.com", "library", "roxbury.aspendiscovery.org", "Roxbury", "https://roxbury.aspendiscovery.org/?browseCategory=x", "aspen"]);
  assert.match(lib[6], /^[A-Za-z0-9_-]{24}$/, "each row has an unsubscribe token");
  const r = await unsubscribe({ request: new Request("https://x/api/unsubscribe?t=" + lib[6]), env: e });
  assert.match(await r.text(), /unsubscribed/); assert.equal(rows.size, 0, "unsubscribe deletes every row for that address");
});
globalThis.fetch = original;
