#!/usr/bin/env python3
"""Builds public/colls.json: the films in each collection chip, as IMDb ids without "tt".

The browser matches these against a library's copy, so collections work for every catalog we copy and need no
server. Source: Wikidata (CC0). Run it now and then; the lists change slowly.
  python3 tools/build_collections.py
"""
import json, os, urllib.parse, urllib.request

UA = "NomadLibraryCollections/1.0 (https://library.nomadovernormal.com)"
QUERIES = {
    # any Academy Award won (award received = a category of the Academy Awards)
    "oscar": "SELECT DISTINCT ?imdb WHERE { ?f wdt:P166 ?a . ?a wdt:P31 wd:Q19020 . ?f wdt:P345 ?imdb }",
    # part of the National Film Registry
    "registry": "SELECT DISTINCT ?imdb WHERE { ?f wdt:P361 wd:Q823422 . ?f wdt:P345 ?imdb }",
    # has a Criterion Collection film id
    "criterion": "SELECT DISTINCT ?imdb WHERE { ?f wdt:P9584 ?c . ?f wdt:P345 ?imdb }",
    # produced by Studio Ghibli
    "ghibli": "SELECT DISTINCT ?imdb WHERE { ?f wdt:P272 wd:Q182950 . ?f wdt:P345 ?imdb }",
}

def run(q):
    u = "https://query.wikidata.org/sparql?" + urllib.parse.urlencode({"query": q, "format": "json"})
    with urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": UA}), timeout=180) as r:
        return [b["imdb"]["value"] for b in json.load(r)["results"]["bindings"]]

out = {}
for k, q in QUERIES.items():
    ids = sorted({int(x[2:]) for x in run(q) if x.startswith("tt") and x[2:].isdigit()})
    if len(ids) < 30: raise SystemExit(f"{k}: only {len(ids)} films, refusing to write a broken list")
    out[k] = ids
    print(k, len(ids))
path = os.path.join(os.path.dirname(__file__), "..", "public", "colls.json")
with open(path, "w") as f: json.dump(out, f, separators=(",", ":"))
print("wrote", os.path.getsize(path), "bytes")
