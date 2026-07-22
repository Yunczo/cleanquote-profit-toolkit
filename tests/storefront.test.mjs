import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("storefront exposes a truthful order boundary", async () => {
  const html = await readFile(new URL("docs/index.html", root), "utf8");
  assert.match(html, /\$9<\/strong><span>USD equivalent in Bitcoin/);
  assert.match(html, /Pay only after that reply/);
  assert.match(html, /within 24 hours of one blockchain confirmation/);
  assert.match(html, /does not guarantee profit|Does it guarantee profit/i);
  assert.doesNotMatch(html, /instant download/i);
});

test("paid product is not published in the site tree", async () => {
  const html = await readFile(new URL("docs/index.html", root), "utf8");
  assert.doesNotMatch(html, /CleanQuote_Product\.zip/);
  assert.doesNotMatch(html, /1AHjXAgf9DEErm21HVjr59uwSoZSoT9qre/);
});

test("order client pins the seller key and verifies delivered bytes", async () => {
  const source = await readFile(new URL("src/order.js", root), "utf8");
  assert.match(source, /350390e2ddcb4d14a0802cff6c1ce47868871d6719cff65d4ecf9eca1bc276a3/);
  assert.match(source, /rumor\.pubkey !== SELLER_PUBLIC_KEY/);
  assert.match(source, /SHA-256/);
  assert.match(source, /actualHash !== first\.sha256/);
});
