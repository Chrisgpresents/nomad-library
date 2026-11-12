// Any library catalog link -> which catalog system it is, and a link that searches it for a title.
// Shared by the page (app.js) and the server (functions/api/library.js). No network here: it only reads the address.
// The search link is opened by the visitor's own browser, so it works even when a catalog blocks other websites.

const SYSTEMS = [
  // [code, test on the whole address]
  ["bibliocommons", /\.bibliocommons\.com/i],
  ["enterprise", /\.sirsi\.net|\/client\/[a-z]{2}_[A-Z]{2}\b/i],   // before Aspen: Aspen's "/search/results" test matches Enterprise links too
  ["aspen", /aspendiscovery\.org|[?&]browseCategory=|\/(Search\/Results|GroupedWork|Union\/Search|MyAccount\/Home)\b/i],
  ["vega", /iiivega\.com/i],
  ["encore", /\/iii\/encore/i],
  ["polaris", /polarislibrary\.com|\/polaris\//i],
  ["evergreen", /\/eg2?\/opac|\/eg2\/|\.evergreen\./i],
  ["koha", /\/cgi-bin\/koha|koha/i],
  ["corvina", /corvinaweb/i],   // before Sierra: "/WebPac/CorvinaWeb" would read as Sierra's WebPAC
  ["monguz", /akfweb|\/(search|results)\/-\/(search|results)\b/i],   // Monguz's Liferay portal (fszekonline.fszek.hu); same backend as Corvina
  ["sierra", /\/search~S\d+|\/search\/[a-zX]\?|\/patroninfo|\/screens\/|webpac/i],
  ["carl", /ls2pac\.|carlconnect|carl\.org|[a-z0-9-]+\.tlcdelivers\.com|[?#&]section=(search|home)/i],
  ["spydus", /spydus/i],
  ["apollo", /biblionix\.com/i],
  ["atriuum", /booksys\.net/i],
];

// Words that are never a library's name, for naming a library from its catalog address.
const GENERIC = /^(www\d?|catalog|catalogue|search|find|opac|webpac|pac|ls2pac|discover|discovery|encore|polaris|library|lib|my|online|ent|apps?|portal|vega|na|bc|cat|ils|sirsi|koha|eg|evergreen|go|new|home|secure)$/i;

const SEARCH_KEYS = /^(q|query|term|terms|lookfor|searchterm|searchterms|search|keyword|keywords|kw|qu|searcharg|searchtext|text|t)$/i;
// A link that is itself a catalog page (not a library homepage): "catalog.x.org", "x.org/catalog", "x.org/search?q=...".
export function looksLikeCatalog(cat) {
  if (!cat) return false;
  if (cat.system || cat.find) return true;
  const u = new URL(cat.url);
  return /^(catalog|catalogue|search|find|opac|webpac|discover|discovery|encore|polaris|pac|ls2pac|library-catalog)\./i.test(u.hostname) || /catalog|opac|\/search|discover/i.test(u.pathname);
}

export function catalogSystem(href) {
  return (SYSTEMS.find(([, re]) => re.test(href)) || [""])[0];
}

// -> { url, host, system, find } where find has {q} where the title goes; null when it is not a web address.
// knownSystem: the system when the page itself told us (a catalog on the library's own domain).
export function readCatalogLink(input, knownSystem = "") {
  let s = String(input || "").trim();
  if (!s || /\s/.test(s) || !/[.]/.test(s)) return null;
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (!/\.[a-z]{2,}$/i.test(u.hostname)) return null;
  const href = u.href, system = knownSystem || catalogSystem(href);
  const o = u.origin, p = u.pathname, qp = u.searchParams;
  let find = "";
  switch (system) {
    case "aspen": find = `${o}/Search/Results?lookfor={q}&searchIndex=Keyword&searchSource=local`; break;
    case "vega": find = `${o}/search?query={q}&searchType=everything&pageSize=10`; break;
    case "encore": find = `${o}/iii/encore/search/C__S{q}__Orightresult__U`; break;
    case "polaris": {
      const ctx = /^[\d.]+$/.test(qp.get("ctx") || "") ? qp.get("ctx") : "1.1033.0.0.1";
      find = `${o}/polaris/search/searchresults.aspx?ctx=${ctx}&type=Keyword&term={q}&by=KW&sort=RELEVANCE&limit=&query=&page=0`; break;
    }
    case "enterprise": {
      const m = p.match(/\/client\/([a-z]{2}_[A-Z]{2})\/([^/]+)/);
      find = `${o}/client/${m ? m[1] : "en_US"}/${m ? m[2] : "default"}/search/results?qu={q}`; break;
    }
    case "evergreen": {
      const pre = (p.match(/^(.*?)\/eg2?\//) || ["", ""])[1];
      const locg = /^\d+$/.test(qp.get("locg") || "") ? `&locg=${qp.get("locg")}` : "";
      find = `${o}${pre}/eg/opac/results?query={q}&qtype=keyword${locg}`; break;
    }
    case "koha": find = `${o}/cgi-bin/koha/opac-search.pl?q={q}`; break;
    case "sierra": {
      const scope = (p.match(/\/search(~S\d+)/) || ["", ""])[1];
      find = `${o}/search${scope}/X?SEARCH={q}&SORT=D`; break;
    }
    case "corvina": {
      const pre = (p.match(/^(.*?\/CorvinaWeb)/i) || ["", "/WebPac/CorvinaWeb"])[1];
      find = `${o}${pre}?action=find&index0=ZUTY&text0={q}&textlogic0=and&pagesize=10`; break;
    }
    case "monguz": find = `${o}/search?p_p_id=GenericSearch_WAR_akfweb&p_p_lifecycle=1&p_p_state=normal&p_p_mode=view&_GenericSearch_WAR_akfweb_searchType=simple&term={q}&type=allFields&dbid=solr`; break;
    case "carl": find = `${o}/?section=search&term={q}`; break;
    case "spydus": find = `${o}/cgi-bin/spydus.exe/ENQ/WPAC/BIBENQ?ENTRY={q}&ENTRY_NAME=BS&ENTRY_TYPE=K&NRECS=20`; break;
    default: {
      // a catalog we don't know by name: if the link is a search, put the title where the search words were
      const key = [...qp.keys()].find(k => SEARCH_KEYS.test(k) && qp.get(k));
      if (key) { const v = new URL(href); v.searchParams.set(key, "QQQ"); find = v.href.replace("QQQ", "{q}"); }
    }
  }
  return { url: href, host: u.hostname.replace(/^www\./, ""), system, find };
}

// A friendly name from the address when nothing better is known: roxbury.aspendiscovery.org -> "Roxbury".
// Only hosted catalogs carry the library's own name in the address, so anything else stays unnamed.
export function nameFromHost(host) {
  const parts = String(host || "").toLowerCase().split(".");
  if (parts.length < 3 || !/aspendiscovery\.org$|bibliocommons\.com$/.test(host)) return "";
  const w = parts[0];
  if (GENERIC.test(w) || w.length < 3) return "";
  return w.charAt(0).toUpperCase() + w.slice(1);
}

// The link that searches this catalog for one title. Falls back to the catalog the visitor gave us.
export function searchLink(cat, title) {
  if (!cat) return "";
  const t = String(title || "").replace(/\s+\/.*$/, "").replace(/\(.*?\)|\[.*?\]/g, " ").replace(/[:;]/g, " ").replace(/\s+/g, " ").trim();
  const q = encodeURIComponent(t || String(title || ""));
  if (cat.find && cat.find.includes("{q}")) return cat.find.replace("{q}", q);
  return cat.url || (cat.host ? `https://${cat.host}/` : "");
}

// ---- catalogs Nomad Library copies itself (readers in the nomad-library-data repo) ---------------------------
// Library ids look like "vega.sdpl.na5.iiivega.com" ("<system>.<host>", plus "_<scope>" for some systems). BiblioCommons
// slugs never contain a dot, so a dot is how both the page and the server tell them apart.
export const isReaderLib = lib => typeof lib === "string" && /^[a-z0-9]+\.[a-z0-9.-]+(_[a-z0-9-]+)?$/.test(lib);
export const READER_SYSTEMS = ["vega", "polaris", "enterprise", "carl", "spydus", "encore", "corvina"];
// A catalog link -> the id we copy it under, or "" when we can't copy that system yet.
// These mirror libFromUrl() in nomad-library-data/readers/<system>.mjs; the copier refuses a link whose id differs.
export function readerId(cat) {
  if (!cat || !READER_SYSTEMS.includes(cat.system)) return "";
  if (cat.system === "vega") {
    const vh = String(cat.vega || cat.host || "").toLowerCase();   // cat.vega: the real address behind a library's own domain (api/library.js)
    return /^[a-z0-9-]+\.[a-z0-9]+\.iiivega\.com$/.test(vh) ? "vega." + vh : "";
  }
  let u; try { u = new URL(cat.url); } catch { return ""; }
  if (!/^https?:$/.test(u.protocol)) return "";
  const host = u.hostname.toLowerCase(), clean = id => id.replace(/[^a-z0-9._-]/g, "-");
  if (cat.system === "polaris") {
    const c = (u.searchParams.get("ctx") || "").toLowerCase();
    return clean("polaris." + host + (/^[0-9.]+$/.test(c) ? "_" + c.replace(/\./g, "-") : ""));
  }
  if (cat.system === "enterprise") {
    const segs = u.pathname.split("/").filter(Boolean), ci = segs.indexOf("client");
    let profile = "default";
    if (ci >= 0) {
      const r = segs.slice(ci + 1);
      if (r[0] === "rss" && r[1] === "hitlist" && r[2]) profile = r[2];
      else if (/^[a-z]{2}_[A-Z]{2}$/.test(r[0] || "") && r[1]) profile = r[1];
      else if (r[0] && !/^(assets|search|rss|ctx|custom|ws|css)$/i.test(r[0])) profile = r[0];
    }
    let p = profile; try { p = decodeURIComponent(profile); } catch {}
    return clean(`enterprise.${host}_${p.replace(/[^A-Za-z0-9._-]/g, "-").toLowerCase()}`);
  }
  if (cat.system === "encore") return ("encore." + host).replace(/[^a-z0-9._-]/g, "");
  if (cat.system === "spydus") {
    const m = u.pathname.match(/^(.*?\/cgi-bin\/spydus\.exe)/i), prefix = m ? m[1] : "/cgi-bin/spydus.exe";
    return ("spydus." + host + (prefix === "/cgi-bin/spydus.exe" ? "" : "_" + prefix.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase())).replace(/[^a-z0-9._-]/g, "");
  }
  if (cat.system === "corvina") {
    const m = u.pathname.match(/^(.*?\/CorvinaWeb)/i), prefix = m ? m[1] : "/WebPac/CorvinaWeb";
    return ("corvina." + host + (prefix === "/WebPac/CorvinaWeb" ? "" : "_" + prefix.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase())).replace(/[^a-z0-9._-]/g, "");
  }
  if (cat.system === "carl") return /^(www\.)?tlcdelivers\.com$/.test(host) ? "" : clean("carl." + host);   // tlcdelivers.com itself is the vendor's site
  return "";
}
// The link the copier reads this library from.
export const readerUrl = cat => cat?.system === "vega" ? `https://${cat.vega || cat.host}/` : cat?.url || "";
// The catalog behind a reader id, for "Check at" and whole-catalog search links (a saved link is better: url).
export function readerCatalog(lib, url) {
  if (!isReaderLib(lib)) return null;
  if (url) { const c = readCatalogLink(url, lib.split(".")[0]); if (c) return c; }
  const sys = lib.split(".")[0], host = lib.slice(sys.length + 1).split("_")[0];
  return readCatalogLink("https://" + host + "/", sys);
}

