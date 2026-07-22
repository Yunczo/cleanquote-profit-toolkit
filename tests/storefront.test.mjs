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
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /connect-src wss:\/\/relay\.damus\.io/);
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
  assert.match(source, /verifiedUnwrapEvent/);
  assert.doesNotMatch(source, /nip17\.unwrapEvent/);
  assert.match(source, /SHA-256/);
  assert.match(source, /actualHash !== commitment\.productSha256/);
  assert.match(source, /selectCompleteDelivery\(chunks, quoteCommitments\)/);
  assert.match(source, /deliveryMatchesQuoteCommitment\(first, commitment\)/);
  assert.match(source, /action: "delivery_ack"/);
});

test("order ticket is encrypted at rest and payment references are structured", async () => {
  const [html, source] = await Promise.all([
    readFile(new URL("docs/index.html", root), "utf8"),
    readFile(new URL("src/order.js", root), "utf8"),
  ]);
  assert.match(html, /Ticket passphrase/);
  assert.match(html, /There is no account recovery/);
  assert.match(html, /non-reversible receipt fingerprints/);
  assert.match(html, /never plaintext quote IDs or transaction IDs/);
  assert.match(html, /ciphertext and relay metadata can persist on public relays/);
  assert.match(html, /public on Bitcoin/);
  assert.match(html, /public Nostr profile/);
  assert.match(html, /name="quoteId"/);
  assert.match(html, /name="txid"/);
  assert.match(html, /business or trade, not as a consumer/);
  assert.match(source, /PBKDF2/);
  assert.match(source, /AES-GCM/);
  assert.match(source, /cleanquote-order-ticket-encrypted-v2/);
  assert.match(source, /cleanquote-order-commitments-encrypted-v2/);
  assert.match(source, /additionalData: COMMITMENTS_AAD/);
  assert.doesNotMatch(source, /setItem\("cleanquote-order-ticket-key-v1"/);
  assert.match(source, /action: quoteId \? "payment" : "quote_request"/);
  assert.match(source, /QUOTE_ID_PATTERN/);
  assert.match(source, /TXID_PATTERN/);
});

test("payment and delivery fail closed against authenticated quote commitments", async () => {
  const source = await readFile(new URL("src/order.js", root), "utf8");
  assert.match(source, /rememberSellerQuoteCommitment\(quoteCommitments, parsed\)/);
  assert.match(source, /Refresh signed replies before submitting payment for this quote/);
  assert.match(source, /rememberSubmittedTransaction\(quoteId, txid\)/);
  assert.match(source, /delivery\.quoteId.*delivery\.txid.*delivery\.deliveryId.*delivery\.sha256/s);
  assert.match(source, /does not match a signed quote and submitted transaction saved by this ticket/);
});

test("relay acceptance is described as pending and acknowledgement can retry", async () => {
  const source = await readFile(new URL("src/order.js", root), "utf8");
  assert.match(source, /ACK_RETRY_SECONDS/);
  assert.match(source, /acknowledgementMayRetry/);
  assert.match(source, /server confirmation is pending/i);
  assert.doesNotMatch(source, /acknowledged to stop retries/i);

  const attemptsStart = source.indexOf("function readAcknowledgementAttempts()");
  const attemptsEnd = source.indexOf("async function sha256Hex", attemptsStart);
  assert.ok(attemptsStart >= 0 && attemptsEnd > attemptsStart);
  const persistedAttempts = source.slice(attemptsStart, attemptsEnd);
  assert.match(persistedAttempts, /fingerprint/);
  assert.doesNotMatch(persistedAttempts, /quoteId|txid|deliveryId|sha256/);
  assert.match(source, /const acknowledgementFingerprint = await sha256Hex/);
  assert.match(source, /rememberAcknowledgementAttempt\(acknowledgementFingerprint, now\)/);
  assert.doesNotMatch(source, /acknowledgementKey = `\$\{delivery\.quoteId\}/);
});

test("storefront publishes and links the cost-first pricing guide", async () => {
  const [home, guide, sitemap] = await Promise.all([
    readFile(new URL("docs/index.html", root), "utf8"),
    readFile(new URL("docs/guides/how-to-price-a-cleaning-job.html", root), "utf8"),
    readFile(new URL("docs/sitemap.xml", root), "utf8"),
  ]);
  const guidePath = "guides/how-to-price-a-cleaning-job.html";
  assert.match(home, new RegExp(guidePath.replaceAll(".", "\\.")));
  assert.match(sitemap, /cleanquote-profit-toolkit\/guides\/how-to-price-a-cleaning-job\.html/);
  assert.match(guide, /P = C ÷ \(1 − m\)/);
  assert.match(guide, /Margin is not markup/);
  assert.match(guide, /does not guarantee profit/i);
});
