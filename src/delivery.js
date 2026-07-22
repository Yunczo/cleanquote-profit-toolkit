const QUOTE_ID_PATTERN = /^cq-[0-9a-f]{32}$/;
const DELIVERY_ID_PATTERN = /^cqd_[0-9a-f]{32}$/;
const HEX_64_PATTERN = /^[0-9a-f]{64}$/;
const ADDRESS_PATTERN = /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

export function quoteCommitmentFromSellerQuote(payload) {
  const keys = [
    "version",
    "product",
    "action",
    "requestId",
    "quoteId",
    "amountSats",
    "usdPrice",
    "referenceBtcUsd",
    "address",
    "expiresAt",
    "productVersion",
    "productSha256",
    "message",
  ];
  if (!isRecord(payload) || !hasExactKeys(payload, keys)) {
    throw new Error("Signed quote has an invalid schema");
  }
  if (payload.version !== 2 || payload.product !== "cleanquote-v1" || payload.action !== "quote") {
    throw new Error("Signed quote has an invalid protocol identity");
  }
  if (
    typeof payload.requestId !== "string" ||
    payload.requestId.length < 1 ||
    payload.requestId.length > 100 ||
    !QUOTE_ID_PATTERN.test(payload.quoteId) ||
    !Number.isSafeInteger(payload.amountSats) ||
    payload.amountSats < 1 ||
    !Number.isFinite(payload.usdPrice) ||
    payload.usdPrice <= 0 ||
    !Number.isFinite(payload.referenceBtcUsd) ||
    payload.referenceBtcUsd <= 0 ||
    !ADDRESS_PATTERN.test(payload.address) ||
    payload.productVersion !== "cleanquote-v1" ||
    !HEX_64_PATTERN.test(payload.productSha256) ||
    typeof payload.message !== "string" ||
    payload.message.length < 1 ||
    payload.message.length > 6_000
  ) {
    throw new Error("Signed quote contains an invalid commitment");
  }
  const expiresAt = Date.parse(payload.expiresAt);
  if (!Number.isFinite(expiresAt) || new Date(expiresAt).toISOString() !== payload.expiresAt) {
    throw new Error("Signed quote expiry is not canonical");
  }
  return {
    quoteId: payload.quoteId,
    productVersion: payload.productVersion,
    productSha256: payload.productSha256,
    submittedTxid: null,
  };
}

export function normalizeQuoteCommitment(value) {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["quoteId", "productVersion", "productSha256", "submittedTxid"]) ||
    !QUOTE_ID_PATTERN.test(value.quoteId) ||
    value.productVersion !== "cleanquote-v1" ||
    !HEX_64_PATTERN.test(value.productSha256) ||
    !(value.submittedTxid === null || HEX_64_PATTERN.test(value.submittedTxid))
  ) {
    throw new Error("Encrypted quote commitment is invalid");
  }
  return { ...value };
}

export function bindQuoteCommitmentToTransaction(commitment, txid) {
  const normalized = normalizeQuoteCommitment(commitment);
  if (!HEX_64_PATTERN.test(txid)) throw new Error("Transaction ID is invalid");
  if (normalized.submittedTxid && normalized.submittedTxid !== txid) {
    throw new Error("This quote is already bound to a different submitted transaction ID");
  }
  return { ...normalized, submittedTxid: txid };
}

export function rememberSellerQuoteCommitment(commitments, payload) {
  if (!(commitments instanceof Map)) throw new Error("Quote commitment store is unavailable");
  const incoming = quoteCommitmentFromSellerQuote(payload);
  const existing = commitments.get(incoming.quoteId);
  if (!existing) {
    commitments.set(incoming.quoteId, incoming);
    return true;
  }
  const normalized = normalizeQuoteCommitment(existing);
  if (
    normalized.productVersion !== incoming.productVersion ||
    normalized.productSha256 !== incoming.productSha256
  ) {
    throw new Error("A signed quote conflicts with the saved product commitment");
  }
  return false;
}

export function deliveryMatchesQuoteCommitment(chunk, commitment) {
  if (!isRecord(chunk) || !isRecord(commitment)) return false;
  try {
    const normalized = normalizeQuoteCommitment(commitment);
    return (
      normalized.submittedTxid !== null &&
      chunk.quoteId === normalized.quoteId &&
      chunk.productVersion === normalized.productVersion &&
      chunk.sha256 === normalized.productSha256 &&
      chunk.txid === normalized.submittedTxid
    );
  } catch {
    return false;
  }
}

export function isCommittedDeliveryChunk(chunk, commitments) {
  if (!(commitments instanceof Map)) return false;
  return (
    isRecord(chunk) &&
    chunk.version === 2 &&
    chunk.product === "cleanquote-v1" &&
    chunk.action === "delivery_chunk" &&
    DELIVERY_ID_PATTERN.test(chunk.deliveryId) &&
    QUOTE_ID_PATTERN.test(chunk.quoteId) &&
    HEX_64_PATTERN.test(chunk.txid) &&
    Number.isInteger(chunk.part) &&
    Number.isInteger(chunk.total) &&
    chunk.part >= 1 &&
    chunk.total >= 1 &&
    chunk.part <= chunk.total &&
    chunk.total <= 10_000 &&
    HEX_64_PATTERN.test(chunk.sha256) &&
    chunk.filename === "CleanQuote_Product.zip" &&
    chunk.mime === "application/zip" &&
    chunk.productVersion === "cleanquote-v1" &&
    Number.isSafeInteger(chunk.size) &&
    chunk.size >= 1 &&
    chunk.size <= 100_000_000 &&
    typeof chunk.data === "string" &&
    chunk.data.length <= 10_000 &&
    BASE64_PATTERN.test(chunk.data) &&
    deliveryMatchesQuoteCommitment(chunk, commitments.get(chunk.quoteId))
  );
}

export function selectCompleteDelivery(chunks, commitments) {
  if (!Array.isArray(chunks) || !(commitments instanceof Map)) return undefined;
  const deliveries = new Map();

  for (const chunk of chunks) {
    if (!isCommittedDeliveryChunk(chunk, commitments)) continue;

    const logicalDelivery = [
      chunk.quoteId,
      chunk.txid,
      chunk.deliveryId,
      chunk.sha256,
      chunk.total,
      chunk.filename,
      chunk.mime,
      chunk.productVersion,
      chunk.size,
    ].join(":");
    let delivery = deliveries.get(logicalDelivery);
    if (!delivery) {
      delivery = new Map();
      deliveries.set(logicalDelivery, delivery);
    }
    const existing = delivery.get(chunk.part);
    if (!existing || Number(chunk.createdAt || 0) >= Number(existing.createdAt || 0)) {
      delivery.set(chunk.part, chunk);
    }
  }

  return [...deliveries.values()]
    .map((parts) => [...parts.values()].sort((left, right) => left.part - right.part))
    .filter((parts) => {
      if (parts.length < 1) return false;
      const first = parts[0];
      return (
        parts.length === first.total &&
        parts.every(
          (part, index) =>
            part.part === index + 1 &&
            part.total === first.total &&
            part.sha256 === first.sha256 &&
            part.quoteId === first.quoteId &&
            part.txid === first.txid &&
            part.filename === first.filename &&
            part.mime === first.mime &&
            part.productVersion === first.productVersion &&
            part.size === first.size,
        )
      );
    })
    .sort(
      (left, right) =>
        Math.max(...right.map((part) => Number(part.createdAt || 0))) -
        Math.max(...left.map((part) => Number(part.createdAt || 0))),
    )[0];
}

export function acknowledgementMayRetry(lastSentAt, now, retryAfterSeconds) {
  return (
    !Number.isSafeInteger(lastSentAt) ||
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(retryAfterSeconds) ||
    retryAfterSeconds < 1 ||
    now - lastSentAt >= retryAfterSeconds
  );
}

export function countAcceptedRelayPublishes(results) {
  if (!Array.isArray(results)) return 0;
  return results.filter(
    (result) =>
      result?.status === "fulfilled" &&
      !/(failure|failed|error|reject|blocked|rate)/i.test(String(result.value)),
  ).length;
}
