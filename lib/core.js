// Shared server code: the BiblioCommons gateway, IMDb matching, sessions.
// Every library on BiblioCommons answers the same public JSON gateway, so one
// code path serves all of them. No API keys anywhere.

export const GW = "https://gateway.bibliocommons.com/v2/libraries";
// Say who we are. Since about 11.3.26 the gateway answers 403 to a Chrome user agent that lacks the rest of a
// real browser's headers, and lets an honest program name through (measured 11.21.26: 60 of 60 at ~1/s).
const UA = "NomadLibrary/1.0 (+https://library.nomadovernormal.com)";

export const json = (data, init = {}) =>
  new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json; charset=utf-8", ...(init.headers || {}) },
  });

export const SLUG_RE = /^[a-z0-9-]{2,40}$/;

// Fetch through the edge cache so a busy library costs the gateway one call per window.
export async function cachedFetch(ctx, url, ttl) {
  const cache = caches.default;
  const key = new Request(url, { method: "GET" });
  const hit = await cache.match(key);
  if (hit) return hit;
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(12000) });
  if (!r.ok) return r;
  const body = await r.text();
  const res = new Response(body, {
    headers: { "content-type": "application/json", "cache-control": `public, max-age=${ttl}` },
  });
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

export async function gw(ctx, path, ttl = 1800) {
  try {
    const r = await cachedFetch(ctx, `${GW}/${path}`, ttl);
    const d = await r.json().catch(() => null);
    return { ok: r.ok && !!d, status: d ? r.status : 502, d };
  } catch { return { ok: false, status: 502, d: null }; }
}

// ---- library lookup ------------------------------------------------------

// Accepts a slug, a catalog URL, or anything containing "<slug>.bibliocommons.com".
export function slugFrom(input) {
  const s = String(input || "").trim().toLowerCase();
  const m = s.match(/([a-z0-9-]+)\.bibliocommons\.com/);
  if (m) return m[1];
  if (SLUG_RE.test(s) && !s.includes(" ")) return s;
  return null;
}

export async function libraryInfo(ctx, slug) {
  if (!SLUG_RE.test(slug)) return null;
  const known = await ctx.env.DB.prepare("SELECT slug, name FROM libs WHERE slug = ? AND name IS NOT NULL").bind(slug).first();
  if (known) return { slug: known.slug, name: known.name };
  const { ok, d } = await gw(ctx, slug, 86400);
  const L = ok && d?.entities?.libraries && Object.values(d.entities.libraries)[0];
  if (L) return { slug, name: L.longName || L.shortName || slug, short: L.shortName || "", site: L.cmsUrl || "" };
  // Since November 2026 the gateway refuses our server, but the library's own BiblioCommons page still names it
  // (an unknown slug lands on /info/select_library, which has no site name)
  try {
    const r = await fetch(`https://${slug}.bibliocommons.com/`, { headers: { "User-Agent": UA, Accept: "text/html" }, cf: { cacheTtl: 86400 }, signal: AbortSignal.timeout(8000) });
    if (!r.ok || new URL(r.url).hostname !== `${slug}.bibliocommons.com` || /select_library/.test(r.url)) return null;
    const name = ((await r.text()).slice(0, 80000).match(/property="og:site_name"\s+content="([^"]{2,120})"/) || [])[1];
    if (!name) return null;
    return { slug, name: name.replace(/&amp;/g, "&").replace(/&#39;|&#x27;/g, "'").replace(/&quot;/g, '"'), short: "", site: "" };
  } catch { return null; }
}

// ---- shaping records -----------------------------------------------------

const yearOf = v => { const m = String(v || "").match(/(19|20)\d{2}/); return m ? +m[0] : null; };
const isTV = br => {
  const pool = [br.title, br.subtitle, ...(br.subjectHeadings || []), ...(br.genreForm || [])].join(" ").toLowerCase();
  return /television (programs|series|comedies|mini)|season \d|complete (series|season)|\bseason\b/.test(pool);
};

export function shape(slug, id, b) {
  const br = b.briefInfo || {}, av = b.availability || {};
  const j = br.jacket || {};
  const desc = (br.description || "").replace(/\s+/g, " ").trim();
  const f = br.format === "VIDEO_GAME" ? "g" : br.format === "BLURAY" ? "b" : "d";
  const platforms = [[/switch\s*2/i, "Switch 2"], [/nintendo switch|\bswitch\b/i, "Switch"], [/playstation\s*5|\bps5\b/i, "PS5"], [/playstation\s*4|\bps4\b/i, "PS4"], [/xbox series|series x/i, "Xbox Series"], [/xbox one/i, "Xbox One"], [/\bxbox\b/i, "Xbox"], [/\bwii u\b/i, "Wii U"], [/\bwii\b/i, "Wii"], [/3ds/i, "3DS"]];
  const platformText = [br.title, br.subtitle, br.edition, br.callNumber].join(" ");
  return {
    id,
    title: (br.title || "").trim(),
    sub: (br.subtitle || "").trim(),
    f, plat: f === "g" ? platforms.find(([re]) => re.test(platformText))?.[1] || "" : "",
    fmt: br.format === "BLURAY" ? "Blu-ray" : br.format === "DVD" ? "DVD" : (br.format || ""),
    disc: yearOf(br.publicationDate),
    img: j.large || j.medium || j.small || null,
    desc: desc.length > 320 ? desc.slice(0, 317).replace(/\s\S*$/, "") + "…" : desc,
    tv: isTV(br),
    avail: av.status === "AVAILABLE" || (av.availableCopies || 0) > 0,
    copies: av.availableCopies || 0,
    total: av.totalCopies || 0,
    holds: av.heldCopies || 0,
    url: `https://${slug}.bibliocommons.com/v2/record/${id}`,
  };
}

// ---- sessions --------------------------------------------------------------
// A signed cookie, so checking who you are never touches the database.

const enc = new TextEncoder();
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}
export async function sign(env, payload, ttlSec) {
  const body = b64u(enc.encode(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec })));
  return `${body}.${await hmac(env.AUTH_SECRET, body)}`;
}
export async function verify(env, token) {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  if ((await hmac(env.AUTH_SECRET, body)) !== sig) return null;
  try {
    const p = JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/")));
    return p.exp > Date.now() / 1000 ? p : null;
  } catch { return null; }
}
export function cookie(req, name) {
  const m = (req.headers.get("cookie") || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : null;
}
export const setCookie = (name, val, maxAge) =>
  `${name}=${val}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

export async function currentUser(env, req) {
  const p = await verify(env, cookie(req, "nl_s"));
  return p?.uid || null;
}

// Same, but also checks the account still exists. A sign-in left over from a deleted
// account counts as signed out, so it can never pick up a new passkey or data.
export async function liveUser(env, req) {
  const uid = await currentUser(env, req);
  if (!uid) return null;
  const u = await env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(uid).first();
  return u ? uid : null;
}
export const CLEAR_SESSION = "nl_s=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax";

export async function sha256(s) {
  return b64u(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}
export const randomId = (n = 16) => b64u(crypto.getRandomValues(new Uint8Array(n)));
export { b64u };
