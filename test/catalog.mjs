// readerId for Aspen must stay identical to libFromUrl in nomad-library-data/readers/aspen.mjs.
import assert from "node:assert/strict";
import test from "node:test";
import { READER_SYSTEMS, readCatalogLink, readerId, readerCatalog } from "../public/catalog.js";

test("aspen is a reader and its id is the host", () => {
  assert.ok(READER_SYSTEMS.includes("aspen"));
  const rox = readCatalogLink("https://roxbury.aspendiscovery.org/?browseCategory=x");
  assert.equal(rox.system, "aspen");
  assert.equal(readerId(rox), "aspen.roxbury.aspendiscovery.org");
  assert.equal(rox.find, "https://roxbury.aspendiscovery.org/Search/Results?lookfor={q}&searchIndex=Keyword&searchSource=local");
  const www = readCatalogLink("https://www.catalog.example.org/Search/Results?lookfor=alien");
  assert.equal(www.system, "aspen");
  assert.equal(readerId(www), "aspen.catalog.example.org");
  assert.equal(readerId(readCatalogLink("https://aspendiscovery.org/")), "");
  assert.equal(readerId(readCatalogLink("https://help.aspendiscovery.org/")), "");
  assert.equal(readerId(readCatalogLink("https://community.aspendiscovery.org/")), "");
  assert.equal(readerId(readCatalogLink("https://dev.aspendiscovery.org/")), "");
  const ent = readCatalogLink("https://catalog.lacountylibrary.org/client/en_US/default");
  assert.equal(ent.system, "enterprise");
  assert.match(readerId(ent), /^enterprise\./);
  const back = readerCatalog("aspen.roxbury.aspendiscovery.org");
  assert.equal(back.system, "aspen");
  assert.match(back.find, /^https:\/\/roxbury\.aspendiscovery\.org\/Search\/Results\?lookfor=\{q\}/);
});
