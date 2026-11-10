// GET /api/library?q=<catalog link, library website, or code>
//   -> { slug, name }                                   a BiblioCommons library: its whole shelf opens
//   -> 404 { unsupported, catalog: {url, host, system, find}, name }   any other catalog: browse movies here, and every
//      "Check at" button searches that catalog for the title (opened by the visitor's own browser, so bot walls don't matter)
// Most people know their library's website, not its catalog address, so a homepage works too: we read it for the catalog.
import { json, slugFrom, libraryInfo, gw, SLUG_RE } from "../../lib/core.js";
import { readCatalogLink, catalogSystem, nameFromHost, looksLikeCatalog } from "../../public/catalog.js";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const NOPE = "We can't show that library yet.";

// Websites we already know belong to a BiblioCommons library, for homepages that hide their catalog from programs.
const KNOWN_SITES = {
  "vpl.ca": "vpl", "burnabypl.ca": "burnaby", "surreylibraries.ca": "surrey", "fvrl.bc.ca": "fvrl", "orl.bc.ca": "orl", "nvcl.ca": "nvcl",
  "whistlerlibrary.ca": "whistler", "barrielibrary.ca": "barrie", "austintexas.gov": "austin", "library.austintexas.gov": "austin",
};
// A catalog system named in a page (also works on the "blocked" page some catalogs send programs).
const PAGE_SIGNS = [["aspen", /aspendiscovery|Aspen Discovery/i], ["vega", /iiivega|Vega Discover/i], ["polaris", /PowerPAC|\/polaris\//i],
  ["enterprise", /SirsiDynix Enterprise|\/client\/en_US\//], ["koha", /cgi-bin\/koha|Koha online catalog/i], ["evergreen", /\/eg\/opac|Evergreen/],
  ["encore", /\/iii\/encore/i], ["carl", /CARL[•.]?Connect|ls2pac/i],
  ["open", /OCLC\.OPEN\.PL\.DNN|\/Mediensuche\/Einfache-Suche/i]];
const systemInPage = html => (PAGE_SIGNS.find(([, re]) => re.test(html)) || [""])[0];
const decode = t => t.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
  .replace(/&amp;/g, "&").replace(/&rsquo;|&lsquo;/g, "'").replace(/&ndash;|&mdash;/g, "-").replace(/&nbsp;/g, " ");
// "Home | Pottstown Regional Public Library" -> "Pottstown Regional Public Library"
const nameInPage = html => {
  const t = decode((html.match(/<title[^>]*>([^<]{3,200})<\/title>/i) || [])[1] || "");
  const part = t.split(/\s[|–—-]\s|\s::\s/).map(x => x.trim().replace(/^(welcome to|visit us at|home of)\s+(the\s+)?/i, "")).find(x => /librar/i.test(x) && x.length <= 80 && /\S+\s+\S+/.test(x) && !/^(the\s+)?(public\s+)?(library|libraries)(\s+(home|homepage|website|catalog))?$|^(home|welcome|catalog|search)\b/i.test(x));
  return part || "";
};
// Every address on the page that is plainly a library catalog, in page order. One cheap scan, so a big homepage stays fast.
const CATALOG_URL = /https?:\/\/[^\s"'<>()]*?(?:bibliocommons\.com|aspendiscovery\.org|iiivega\.com|\/iii\/encore|polarislibrary\.com|\/polaris\/|\.sirsi\.net|\/client\/[a-z]{2}_[A-Z]{2}|\/eg2?\/opac|\/cgi-bin\/koha|\/search~S\d|ls2pac|biblionix\.com|booksys\.net|spydus|\/Mediensuche\/|\/Permalink\.aspx\?)[^\s"'<>()]*/g;
function catalogUrls(html) {
  const out = [];
  for (const m of html.matchAll(CATALOG_URL)) { const u = decode(m[0]); if (!/gateway\.bibliocommons|cdn|assets|\.(js|css|png|jpe?g|svg|gif)(\?|$)/i.test(u) && !out.includes(u)) out.push(u); if (out.length >= 8) break; }
  return out;
}
const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };

async function get(url, ms = 9000) {
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" }, redirect: "follow", cf: { cacheTtl: 86400 }, signal: AbortSignal.timeout(ms) });
  const html = (await r.text().catch(() => "")).slice(0, 400000);   // a "blocked" page can still name the catalog system
  return { url: r.url || url, status: r.status, html };
}
function slugIn(url, html) {
  if (/\.bibliocommons\.com/i.test(url)) return slugFrom(url);
  const counts = {};
  for (const m of html.matchAll(/https?:\/\/([a-z0-9-]+)\.bibliocommons\.com/gi)) {
    const s = m[1].toLowerCase();
    if (!["www", "gateway", "help", "api", "cdn", "assets"].includes(s) && !/cdn|static|assets/.test(s)) counts[s] = (counts[s] || 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}

// Reads a library's own website for its catalog, so nobody has to know what a "catalog link" is:
// the page itself, then the links on it that look like "Catalog" or "Search", then a guess from the web address.
// -> { slug } for BiblioCommons, or { catalog, name } for any other catalog we could recognize, or {} when nothing was found.
async function fromWebsite(ctx, input) {
  let url = String(input || "").trim();
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  const host = hostOf(url);
  if (!/\.[a-z]{2,}$/i.test(host)) return {};
  if (KNOWN_SITES[host]) return { slug: KNOWN_SITES[host], host };
  let name = "", pageSystem = "", finalUrl = url;
  try {
    const first = await get(url);
    finalUrl = first.url || url;
    name = nameInPage(first.html);
    let slug = first.status < 400 && slugIn(first.url, first.html);
    if (slug) return { slug, host };
    if (catalogSystem(finalUrl)) return { catalog: readCatalogLink(finalUrl), name };
    pageSystem = systemInPage(first.html.slice(0, 80000));
    // an address on the page that is plainly a catalog wins; otherwise follow up to three links that say "Catalog" or "Search"
    for (const u of catalogUrls(first.html)) if (catalogSystem(u) && catalogSystem(u) !== "bibliocommons" && !SOCIAL.test(u)) return { catalog: readCatalogLink(u), name };
    const links = [];
    for (const m of first.html.slice(0, 200000).matchAll(/<a\s[^>]*?href=["']([^"'#][^"']*)["'][^>]*>([^<]{0,80})/gi)) {
      const href = decode(m[1]), text = m[2];
      if (/^(mailto|tel|javascript):/i.test(href)) continue;
      let abs; try { abs = new URL(href, finalUrl).href; } catch { continue; }
      if (/catalog|katalog|mediensuche|opac|search the|find (books|a book|materials)|library catalog|discover/i.test(text + " " + href) && !SOCIAL.test(abs) && !links.includes(abs)) links.push(abs);
      if (links.length >= 3) break;
    }
    for (const u of links.slice(0, 3)) {
      try {
        const g = await get(u, 7000);
        slug = g.status < 400 && slugIn(g.url, g.html);
        if (slug) return { slug, host };
        if (catalogSystem(g.url)) return { catalog: readCatalogLink(g.url), name };
        const inner = catalogUrls(g.html).find(x => catalogSystem(x) && catalogSystem(x) !== "bibliocommons");
        if (inner) return { catalog: readCatalogLink(inner), name };
        const sys = systemInPage(g.html.slice(0, 80000));
        if (sys) return { catalog: readCatalogLink(g.url, sys), name };
      } catch {}
    }
  } catch {}
  if (pageSystem) return { catalog: readCatalogLink(finalUrl, pageSystem), name };
  // many libraries use their own short name as the BiblioCommons name (nypl.org -> nypl)
  const guess = host.split(".")[0];
  if (SLUG_RE.test(guess)) return { slug: guess, guess: true, host, name, page: finalUrl };
  return { name, page: finalUrl };
}
const SOCIAL = /facebook|twitter|instagram|youtube|google\.|libbyapp|overdrive|hoopla|kanopy|linkedin|pinterest|tiktok|libcal|libguides/i;

// A Vega catalog on the library's own domain (catalog.dclibrary.org) runs on "<code>.<region>.iiivega.com" behind it:
// /lookup names the code, config.js the region. We copy it under that address.
async function vegaHost(host) {
  try {
    const [code, cfg] = await Promise.all([get(`https://${host}/lookup`, 4000), get(`https://${host}/config.js`, 4000)]);
    const c = code.html.trim().toLowerCase(), env = (cfg.html.match(/ENVIRONMENT\s*=\s*'([a-z0-9]+)'/) || [])[1];
    return /^[a-z0-9-]{2,30}$/.test(c) && env ? `${c}.${env}.iiivega.com` : "";
  } catch { return ""; }
}

export async function onRequestGet(ctx) {
  const q = new URL(ctx.request.url).searchParams.get("q") || "";
  if (!q.trim()) return json({ error: "Type your library's name or town, or paste its website." }, { status: 400 });
  let slug = slugFrom(q);
  let info = slug && await libraryInfo(ctx, slug);
  let other = null;     // { catalog, name } for a catalog that isn't BiblioCommons
  const looksLikeLink = /[./]/.test(q);
  if (!info && looksLikeLink) {
    const direct = readCatalogLink(q);
    if (direct?.system && direct.system !== "bibliocommons") {
      // the catalog's own page title usually names the library ("Catalog Home | Minuteman Library Network"); a blocked page just goes unnamed
      let name = nameFromHost(direct.host);
      if (!name) try { const g = await get(direct.url, 4000); if (g.status < 400) name = nameInPage(g.html); } catch {}
      other = { catalog: direct, name };
    }
    else {
      const found = await fromWebsite(ctx, q);
      if (found.slug) {
        slug = found.slug; info = await libraryInfo(ctx, slug);
        // a guess from the web address is only believed when the library's own website agrees (spl.org is Seattle, not BiblioCommons' "spl")
        if (info && found.guess) {
          const { d } = await gw(ctx, slug, 86400);
          const site = Object.values(d?.entities?.libraries || {})[0]?.cmsUrl || "";
          if (!hostOf(site).split(".").includes(slug)) info = null;
        }
      }
      if (!info && found.catalog) other = { catalog: found.catalog, name: found.name || nameFromHost(found.catalog.host) };
      // nothing recognizable: a catalog page of a kind we don't know is still their catalog; a plain homepage means we ask for the catalog link
      else if (!info && direct) other = looksLikeCatalog(direct) ? { catalog: direct, name: found.name || "" } : { catalog: { ...direct, url: found.page || direct.url }, name: found.name || "", unknown: true };
    }
  }
  if (!info) {
    const c = other?.catalog;
    if (c?.system === "vega" && !/\.iiivega\.com$/i.test(c.host || "")) c.vega = await vegaHost(c.host);
    return json({ error: NOPE, unsupported: true, vendor: c?.system || "", host: c?.host || "", catalog: c || null, name: other?.name || "", unknown: !!other?.unknown },
      { status: 404, headers: { "cache-control": "public, max-age=3600" } });
  }
  // remember it so it shows up in everyone's library search
  ctx.waitUntil(ctx.env.DB.prepare("INSERT OR IGNORE INTO libs (slug, name) VALUES (?, ?)").bind(info.slug, info.name).run().catch(() => {}));
  return json(info, { headers: { "cache-control": "public, max-age=86400" } });
}
