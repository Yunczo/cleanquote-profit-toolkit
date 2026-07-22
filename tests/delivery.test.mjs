import assert from "node:assert/strict";
import test from "node:test";
import {
  acknowledgementMayRetry,
  bindQuoteCommitmentToTransaction,
  countAcceptedRelayPublishes,
  deliveryMatchesQuoteCommitment,
  quoteCommitmentFromSellerQuote,
  rememberSellerQuoteCommitment,
  selectCompleteDelivery,
} from "../src/delivery.js";

const quoteId = `cq-${"1".repeat(32)}`;
const otherQuoteId = `cq-${"2".repeat(32)}`;
const deliveryId = `cqd_${"3".repeat(32)}`;
const txid = "4".repeat(64);
const otherTxid = "5".repeat(64);
const hash = "a".repeat(64);
const otherHash = "b".repeat(64);

function signedQuote(overrides = {}) {
  return {
    version: 2,
    product: "cleanquote-v1",
    action: "quote",
    requestId: "request-1",
    quoteId,
    amountSats: 7_500,
    usdPrice: 9,
    referenceBtcUsd: 120_000,
    address: "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH",
    expiresAt: "2026-07-22T07:00:00.000Z",
    productVersion: "cleanquote-v1",
    productSha256: hash,
    message: "Pay only this signed quote.",
    ...overrides,
  };
}

function paidCommitment() {
  return bindQuoteCommitmentToTransaction(
    quoteCommitmentFromSellerQuote(signedQuote()),
    txid,
  );
}

function commitmentMap() {
  return new Map([[quoteId, paidCommitment()]]);
}

function chunk(part, overrides = {}) {
  return {
    version: 2,
    product: "cleanquote-v1",
    action: "delivery_chunk",
    deliveryId,
    quoteId,
    txid,
    filename: "CleanQuote_Product.zip",
    mime: "application/zip",
    productVersion: "cleanquote-v1",
    part,
    total: 3,
    sha256: hash,
    size: 18,
    data: Buffer.from(`part-${part}`).toString("base64"),
    createdAt: part,
    ...overrides,
  };
}

test("validates a signed quote and binds exactly one submitted transaction", () => {
  const commitment = quoteCommitmentFromSellerQuote(signedQuote());
  assert.deepEqual(commitment, {
    quoteId,
    productVersion: "cleanquote-v1",
    productSha256: hash,
    submittedTxid: null,
  });
  assert.equal(bindQuoteCommitmentToTransaction(commitment, txid).submittedTxid, txid);
  assert.throws(
    () => bindQuoteCommitmentToTransaction(paidCommitment(), otherTxid),
    /different submitted transaction/,
  );
  assert.throws(
    () => bindQuoteCommitmentToTransaction(undefined, txid),
    /commitment is invalid/,
  );
  assert.throws(
    () => quoteCommitmentFromSellerQuote(signedQuote({ productSha256: "invalid" })),
    /invalid commitment/,
  );
  assert.throws(
    () => quoteCommitmentFromSellerQuote({ ...signedQuote(), extra: true }),
    /invalid schema/,
  );
});

test("signed quote commitments are idempotent and cannot be overwritten", () => {
  const commitments = new Map();
  assert.equal(rememberSellerQuoteCommitment(commitments, signedQuote()), true);
  assert.equal(rememberSellerQuoteCommitment(commitments, signedQuote()), false);
  assert.equal(commitments.get(quoteId).productSha256, hash);
  assert.throws(
    () => rememberSellerQuoteCommitment(
      commitments,
      signedQuote({ productSha256: otherHash }),
    ),
    /conflicts with the saved product commitment/,
  );
  assert.equal(commitments.get(quoteId).productSha256, hash);
});

test("deduplicates retry chunks by logical delivery part", () => {
  const selected = selectCompleteDelivery([
    chunk(1),
    chunk(2),
    chunk(1, { createdAt: 20 }),
    chunk(3),
    chunk(2, { createdAt: 21 }),
  ], commitmentMap());
  assert.deepEqual(selected.map((part) => part.part), [1, 2, 3]);
  assert.equal(selected[0].createdAt, 20);
  assert.equal(selected[1].createdAt, 21);
});

test("rejects incomplete or internally inconsistent deliveries", () => {
  assert.equal(selectCompleteDelivery([chunk(1), chunk(3)], commitmentMap()), undefined);
  assert.equal(
    selectCompleteDelivery([chunk(1), chunk(2), chunk(3, { size: 99 })], commitmentMap()),
    undefined,
  );
  assert.equal(
    selectCompleteDelivery([chunk(1), chunk(2), chunk(3, { total: 4 })], commitmentMap()),
    undefined,
  );
});

test("rejects wrong-quote, wrong-hash, and wrong-transaction delivery chunks", () => {
  const commitments = commitmentMap();
  assert.equal(selectCompleteDelivery([chunk(1, { total: 1 })], new Map()), undefined);
  assert.equal(
    selectCompleteDelivery(
      [chunk(1, { total: 1 })],
      new Map([[quoteId, quoteCommitmentFromSellerQuote(signedQuote())]]),
    ),
    undefined,
  );
  assert.equal(
    selectCompleteDelivery([chunk(1, { total: 1, quoteId: otherQuoteId })], commitments),
    undefined,
  );
  assert.equal(
    selectCompleteDelivery([chunk(1, { total: 1, sha256: otherHash })], commitments),
    undefined,
  );
  assert.equal(
    selectCompleteDelivery([chunk(1, { total: 1, txid: otherTxid })], commitments),
    undefined,
  );
  assert.equal(deliveryMatchesQuoteCommitment(chunk(1), paidCommitment()), true);
  assert.equal(deliveryMatchesQuoteCommitment(chunk(1, { txid: otherTxid }), paidCommitment()), false);
});

test("a newer wrong delivery cannot mask an older complete committed delivery", () => {
  const valid = [1, 2, 3].map((part) => chunk(part));
  const wrong = [1, 2, 3].map((part) => chunk(part, {
    deliveryId: `cqd_${"7".repeat(32)}`,
    sha256: otherHash,
    createdAt: 100 + part,
  }));
  const selected = selectCompleteDelivery([...valid, ...wrong], commitmentMap());
  assert.equal(selected[0].deliveryId, deliveryId);
  assert.equal(selected[0].sha256, hash);
});

test("the same delivery ID cannot cross-mix two quotes", () => {
  const otherCommitment = bindQuoteCommitmentToTransaction(
    quoteCommitmentFromSellerQuote(signedQuote({
      quoteId: otherQuoteId,
      productSha256: otherHash,
    })),
    otherTxid,
  );
  const commitments = commitmentMap();
  commitments.set(otherQuoteId, otherCommitment);
  assert.equal(
    selectCompleteDelivery([
      chunk(1),
      chunk(3),
      chunk(2, {
        quoteId: otherQuoteId,
        txid: otherTxid,
        sha256: otherHash,
      }),
    ], commitments),
    undefined,
  );
});

test("prefers the newest complete committed delivery", () => {
  const older = [1, 2, 3].map((part) => chunk(part));
  const newer = [1, 2].map((part) =>
    chunk(part, {
      deliveryId: `cqd_${"6".repeat(32)}`,
      total: 2,
      createdAt: 100 + part,
    }),
  );
  assert.equal(selectCompleteDelivery([...older, ...newer], commitmentMap())[0].deliveryId, newer[0].deliveryId);
});

test("relay-accepted acknowledgements become retryable after a bounded delay", () => {
  assert.equal(acknowledgementMayRetry(1_000, 1_599, 600), false);
  assert.equal(acknowledgementMayRetry(1_000, 1_600, 600), true);
  assert.equal(acknowledgementMayRetry(undefined, 1_600, 600), true);
});

test("relay connection failures are not counted as acknowledgement submission", () => {
  assert.equal(countAcceptedRelayPublishes([
    { status: "fulfilled", value: "OK" },
    { status: "fulfilled", value: "connection failure: timeout" },
    { status: "rejected", reason: new Error("blocked") },
  ]), 1);
  assert.equal(countAcceptedRelayPublishes([
    { status: "fulfilled", value: "rate limited" },
    { status: "fulfilled", value: "failed: auth" },
  ]), 0);
});
