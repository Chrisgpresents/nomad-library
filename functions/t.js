// GET /t?q=The Shining 1980            -> straight to the best YouTube trailer (opened in a new tab)
// GET /t?q=The Shining 1980&format=json -> { vid, search } for the in-page trailer player
// Resolved once, then kept in the edge cache, so nothing is fetched ahead of time.
// Picking (11.1.26, people saw wrong trailers): the old code took the first videoId on the search page, which can be a
// promoted video, a Short or another film. Now each result's title is read and the first one that names this film and
// says "trailer" wins (the year helps, reactions/reviews/fan-made lose); the first result is only the fallback.
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const flat = s => String(s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
const BAD = /\b(reaction|reacts?|review|explained|ending|fan ?made|parody|honest trailer|recap|breakdown|easter eggs?|scene|clip|interview)\b/;

export function best(html, q) {
  const year = (q.match(/\b(19|20)\d{2}\s*$/) || [""])[0].trim();
  const film = flat(year ? q.slice(0, q.lastIndexOf(year)) : q);
  const found = [];
  const re = /"videoRenderer":\{"videoId":"([A-Za-z0-9_-]{11})"[\s\S]{0,1500}?"title":\{"runs":\[\{"text":"((?:[^"\\]|\\.)*)"/g;
  for (let m; (m = re.exec(html)) && found.length < 15;) found.push({ id: m[1], t: flat(JSON.parse(`"${m[2]}"`)) });
  let pick = null, top = -1;
  for (const [i, c] of found.entries()) {
    let s = 0;
    if (film && (` ${c.t} `).includes(` ${film} `)) s += 4;
    if (/\btrailer\b/.test(c.t)) s += 2;
    if (year && c.t.includes(year)) s += 1;
    else if (year && /\b(19|20)\d{2}\b/.test(c.t)) s -= 2;   // names another year: likely a remake or a different film
    if (BAD.test(c.t)) s -= 4;
    s -= i * 0.01;                      // ties go to YouTube's own order
    if (s > top) { top = s; pick = c; }
  }
  // Nothing names the film: show "couldn't find a trailer" (with a YouTube search link) rather than an unrelated video.
  return pick && top >= 4 ? pick.id : "";
}

export async function onRequestGet(ctx) {
  const u = new URL(ctx.request.url);
  const q = (u.searchParams.get("q") || "").trim().slice(0, 140);
  const asJson = u.searchParams.get("format") === "json";
  // games (&g=1) search for the game's trailer, so a fan film with the same name loses (feedback 260)
  const game = u.searchParams.get("g") === "1";
  const search = "https://www.youtube.com/results?search_query=" + encodeURIComponent(q + (game ? " game trailer" : " trailer"));
  const answer = vid => asJson
    ? new Response(JSON.stringify({ vid, search }), { headers: { "content-type": "application/json", "cache-control": "public, max-age=3600" } })
    : Response.redirect(vid ? `https://www.youtube.com/watch?v=${vid}` : search, 302);
  if (!q) return answer("");
  const key = new Request("https://nomad-library.cache/t3/" + (game ? "g/" : "") + encodeURIComponent(q.toLowerCase()));
  const hit = await caches.default.match(key);
  let vid = hit ? await hit.text() : null;
  if (!hit) {
    try {
      const r = await fetch(search, { headers: { "User-Agent": UA, "Accept-Language": "en-US,en" } });
      vid = best(await r.text(), q);
    } catch { vid = ""; }
    ctx.waitUntil(caches.default.put(key, new Response(vid, {
      headers: { "cache-control": `public, max-age=${vid ? 60 * 60 * 24 * 120 : 60 * 60 * 6}` },
    })));
  }
  return answer(vid);
}
