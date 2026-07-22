import {
  SimplePool,
  generateSecretKey,
  getPublicKey,
  nip17,
  nip19,
} from "nostr-tools";
import { bytesToHex } from "nostr-tools/utils";
import {
  acknowledgementMayRetry,
  bindQuoteCommitmentToTransaction,
  countAcceptedRelayPublishes,
  deliveryMatchesQuoteCommitment,
  isCommittedDeliveryChunk,
  normalizeQuoteCommitment,
  rememberSellerQuoteCommitment,
  selectCompleteDelivery,
} from "./delivery.js";
import { verifiedUnwrapEvent } from "./verified-nip17.js";

const SELLER_PUBLIC_KEY =
  "350390e2ddcb4d14a0802cff6c1ce47868871d6719cff65d4ecf9eca1bc276a3";
const RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.primal.net",
  "wss://nostr.mom",
];
const STORAGE_KEY = "cleanquote-order-ticket-encrypted-v2";
const COMMITMENTS_KEY = "cleanquote-order-commitments-encrypted-v2";
const SENT_AT_KEY = "cleanquote-order-sent-at-v2";
const ACK_ATTEMPTS_KEY = "cleanquote-order-ack-attempts-v3";
const ACK_RETRY_SECONDS = 15 * 60;
const COMMITMENTS_AAD = new TextEncoder().encode("cleanquote-order-commitments-v2");
const QUOTE_ID_PATTERN = /^cq-[0-9a-f]{32}$/;
const TXID_PATTERN = /^[0-9a-f]{64}$/;

const orderForm = document.querySelector("#cleanquote-order-form");
const statusBox = document.querySelector("#order-status");
const ticketBox = document.querySelector("#order-ticket-id");
const repliesBox = document.querySelector("#order-replies");
const refreshButton = document.querySelector("#order-refresh");
const downloadBox = document.querySelector("#order-download");
const passphraseInput = document.querySelector("#ticket-passphrase");
const clearTicketButton = document.querySelector("#order-clear-ticket");

if (
  !orderForm ||
  !statusBox ||
  !ticketBox ||
  !repliesBox ||
  !refreshButton ||
  !downloadBox ||
  !passphraseInput ||
  !clearTicketButton
) {
  throw new Error("CleanQuote order markup is incomplete");
}

// Remove the legacy plaintext ticket format. There were no real buyer tickets
// when v2 launched, so preserving it would only retain an origin-wide secret.
window.localStorage.removeItem("cleanquote-order-ticket-key-v1");
window.localStorage.removeItem("cleanquote-order-sent-at-v1");
window.localStorage.removeItem("cleanquote-order-acked-deliveries-v2");
window.localStorage.removeItem("cleanquote-order-ack-attempts-v2");

let ticketSecretKey;
let ticketPublicKey;
let ticketStorageKey;
let quoteCommitments = new Map();

function randomBytes(length) {
  return crypto.getRandomValues(new Uint8Array(length));
}

function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function deriveStorageKey(passphrase, salt) {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: 250_000 },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function unlockTicket(passphrase) {
  if (ticketSecretKey && ticketPublicKey && ticketStorageKey) return;
  if (typeof passphrase !== "string" || passphrase.length < 12) {
    throw new Error("Use a ticket passphrase of at least 12 characters");
  }

  const stored = window.localStorage.getItem(STORAGE_KEY);
  let derivedKey;
  if (stored) {
    try {
      const record = JSON.parse(stored);
      if (record.version !== 2) throw new Error("Unknown ticket backup version");
      const salt = decodeFixedBase64(record.salt, 16);
      const iv = decodeFixedBase64(record.iv, 12);
      const ciphertext = decodeFixedBase64(record.ciphertext, 48);
      derivedKey = await deriveStorageKey(passphrase, salt);
      const plaintext = new Uint8Array(
        await crypto.subtle.decrypt({ name: "AES-GCM", iv }, derivedKey, ciphertext),
      );
      if (plaintext.length !== 32) throw new Error("Ticket backup is invalid");
      ticketSecretKey = plaintext;
    } catch {
      throw new Error("The ticket passphrase is wrong or its encrypted backup is damaged");
    }
  } else {
    ticketSecretKey = generateSecretKey();
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    derivedKey = await deriveStorageKey(passphrase, salt);
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-GCM", iv }, derivedKey, ticketSecretKey),
    );
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        salt: bytesToBase64(salt),
        iv: bytesToBase64(iv),
        ciphertext: bytesToBase64(ciphertext),
      }),
    );
  }
  ticketStorageKey = derivedKey;
  try {
    quoteCommitments = await loadQuoteCommitments(ticketStorageKey);
  } catch (error) {
    ticketSecretKey?.fill(0);
    ticketSecretKey = undefined;
    ticketStorageKey = undefined;
    throw error;
  }
  ticketPublicKey = getPublicKey(ticketSecretKey);
  ticketBox.textContent = nip19.npubEncode(ticketPublicKey);
  passphraseInput.setAttribute("aria-invalid", "false");
}

ticketBox.textContent = window.localStorage.getItem(STORAGE_KEY)
  ? "Encrypted ticket found — enter its passphrase"
  : "Enter a passphrase to create an encrypted ticket";

function setStatus(message, state = "neutral") {
  statusBox.textContent = message;
  statusBox.dataset.state = state;
}

async function publish(event) {
  const pool = new SimplePool({ enableReconnect: false });
  try {
    return await Promise.allSettled(pool.publish(RELAYS, event, { maxWait: 9_000 }));
  } finally {
    window.setTimeout(() => pool.destroy(), 250);
  }
}

function decodeBase64(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error("Invalid base64 data");
  }
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function decodeFixedBase64(value, expectedLength) {
  if (typeof value !== "string" || value.length > 128) {
    throw new Error("Invalid encrypted ticket field");
  }
  const decoded = decodeBase64(value);
  if (decoded.length !== expectedLength) throw new Error("Invalid encrypted ticket field");
  return decoded;
}

function decodeBoundedBase64(value, maximumLength) {
  if (typeof value !== "string" || value.length > maximumLength * 2) {
    throw new Error("Invalid encrypted commitment field");
  }
  const decoded = decodeBase64(value);
  if (decoded.length < 1 || decoded.length > maximumLength) {
    throw new Error("Invalid encrypted commitment field");
  }
  return decoded;
}

async function loadQuoteCommitments(storageKey) {
  const stored = window.localStorage.getItem(COMMITMENTS_KEY);
  if (!stored) return new Map();

  let plaintext;
  try {
    const envelope = JSON.parse(stored);
    if (
      !envelope ||
      typeof envelope !== "object" ||
      Array.isArray(envelope) ||
      Object.keys(envelope).sort().join(",") !== "ciphertext,iv,version" ||
      envelope.version !== 2
    ) {
      throw new Error("Unknown commitment backup version");
    }
    const iv = decodeFixedBase64(envelope.iv, 12);
    const ciphertext = decodeBoundedBase64(envelope.ciphertext, 200_000);
    plaintext = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv, additionalData: COMMITMENTS_AAD },
        storageKey,
        ciphertext,
      ),
    );
    const record = JSON.parse(new TextDecoder().decode(plaintext));
    if (
      !record ||
      typeof record !== "object" ||
      Array.isArray(record) ||
      Object.keys(record).sort().join(",") !== "quotes,version" ||
      record.version !== 2 ||
      !Array.isArray(record.quotes) ||
      record.quotes.length > 500
    ) {
      throw new Error("Encrypted quote commitment record is invalid");
    }
    const commitments = new Map();
    for (const value of record.quotes) {
      const commitment = normalizeQuoteCommitment(value);
      if (commitments.has(commitment.quoteId)) {
        throw new Error("Encrypted quote commitment record contains a duplicate quote");
      }
      commitments.set(commitment.quoteId, commitment);
    }
    return commitments;
  } catch {
    throw new Error("The encrypted quote commitments are damaged or do not match this ticket");
  } finally {
    plaintext?.fill(0);
  }
}

async function persistQuoteCommitments() {
  if (!ticketStorageKey) throw new Error("Unlock the ticket before saving quote commitments");
  if (quoteCommitments.size > 500) throw new Error("This ticket has too many quote commitments");
  const quotes = [...quoteCommitments.values()]
    .map((value) => normalizeQuoteCommitment(value))
    .sort((left, right) => left.quoteId.localeCompare(right.quoteId));
  const plaintext = new TextEncoder().encode(JSON.stringify({ version: 2, quotes }));
  const iv = randomBytes(12);
  try {
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: COMMITMENTS_AAD },
        ticketStorageKey,
        plaintext,
      ),
    );
    window.localStorage.setItem(
      COMMITMENTS_KEY,
      JSON.stringify({
        version: 2,
        iv: bytesToBase64(iv),
        ciphertext: bytesToBase64(ciphertext),
      }),
    );
  } finally {
    plaintext.fill(0);
  }
}

async function rememberSubmittedTransaction(quoteId, txid) {
  const existing = quoteCommitments.get(quoteId);
  if (!existing) {
    throw new Error("Refresh signed replies before submitting payment for this quote");
  }
  const bound = bindQuoteCommitmentToTransaction(existing, txid);
  if (existing.submittedTxid === bound.submittedTxid) return;
  quoteCommitments.set(quoteId, bound);
  try {
    await persistQuoteCommitments();
  } catch (error) {
    quoteCommitments.set(quoteId, existing);
    throw error;
  }
}

function readAcknowledgementAttempts() {
  try {
    const values = JSON.parse(window.localStorage.getItem(ACK_ATTEMPTS_KEY) || "[]");
    if (!Array.isArray(values)) return new Map();
    const attempts = new Map();
    for (const value of values.slice(-500)) {
      if (
        value &&
        typeof value.fingerprint === "string" &&
        /^[0-9a-f]{64}$/.test(value.fingerprint) &&
        Number.isSafeInteger(value.sentAt) &&
        value.sentAt > 0
      ) {
        attempts.set(value.fingerprint, value.sentAt);
      }
    }
    return attempts;
  } catch {
    return new Map();
  }
}

function rememberAcknowledgementAttempt(fingerprint, sentAt) {
  const values = readAcknowledgementAttempts();
  values.set(fingerprint, sentAt);
  window.localStorage.setItem(
    ACK_ATTEMPTS_KEY,
    JSON.stringify([...values].slice(-500).map(([storedFingerprint, storedAt]) => ({
      fingerprint: storedFingerprint,
      sentAt: storedAt,
    }))),
  );
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return bytesToHex(new Uint8Array(digest));
}

async function acknowledgeDelivery(delivery, commitment) {
  if (!deliveryMatchesQuoteCommitment(delivery, commitment)) {
    throw new Error("Delivery does not match the signed quote and submitted transaction");
  }
  const acknowledgementFingerprint = await sha256Hex(new TextEncoder().encode([
    "cleanquote-delivery-ack-attempt-v3",
    delivery.quoteId,
    delivery.txid,
    delivery.deliveryId,
    delivery.sha256,
  ].join("\u0000")));
  const now = Math.floor(Date.now() / 1_000);
  const lastSentAt = readAcknowledgementAttempts().get(acknowledgementFingerprint);
  if (!acknowledgementMayRetry(lastSentAt, now, ACK_RETRY_SECONDS)) return "recent";

  const payload = {
    version: 2,
    product: "cleanquote-v1",
    action: "delivery_ack",
    quoteId: delivery.quoteId,
    deliveryId: delivery.deliveryId,
    sha256: delivery.sha256,
    ticketPublicKey,
  };
  const wrapped = nip17.wrapEvent(
    ticketSecretKey,
    { publicKey: SELLER_PUBLIC_KEY, relayUrl: RELAYS[0] },
    JSON.stringify(payload),
    "CleanQuote delivery acknowledgement",
  );
  const accepted = countAcceptedRelayPublishes(await publish(wrapped));
  if (accepted < 1) return "failed";
  rememberAcknowledgementAttempt(acknowledgementFingerprint, now);
  return "sent";
}

function renderMessages(messages) {
  repliesBox.replaceChildren();
  if (messages.length === 0) {
    repliesBox.hidden = true;
    return;
  }

  for (const message of messages) {
    const item = document.createElement("article");
    item.className = "order-message";
    const time = document.createElement("time");
    time.dateTime = new Date(message.createdAt * 1000).toISOString();
    time.textContent = new Date(message.createdAt * 1000).toLocaleString();
    const body = document.createElement("p");
    body.textContent = message.text;
    item.append(time, body);
    repliesBox.append(item);
  }
  repliesBox.hidden = false;
}

async function renderDelivery(chunks) {
  downloadBox.replaceChildren();
  downloadBox.hidden = true;
  if (chunks.length === 0) return;

  const complete = selectCompleteDelivery(chunks, quoteCommitments);

  if (!complete) {
    downloadBox.textContent = chunks.some((chunk) => isCommittedDeliveryChunk(chunk, quoteCommitments))
      ? "Encrypted delivery is arriving in committed parts. Refresh again shortly."
      : "The received delivery does not match a signed quote and submitted transaction saved by this ticket. No file or receipt was created.";
    downloadBox.hidden = false;
    return;
  }

  const first = complete[0];
  const commitment = quoteCommitments.get(first.quoteId);

  let link;
  let proof;
  try {
    if (!deliveryMatchesQuoteCommitment(first, commitment)) {
      throw new Error("Delivery commitment mismatch");
    }
    const bytes = decodeBase64(complete.map((item) => item.data).join(""));
    if (bytes.length !== first.size) throw new Error("Delivery size mismatch");
    const actualHash = await sha256Hex(bytes);
    if (actualHash !== commitment.productSha256) throw new Error("Checksum mismatch");

    link = document.createElement("a");
    link.className = "button button-lime";
    const filename = String(first.filename || "CleanQuote_Product.zip")
      .replace(/^.*[\\/]/, "")
      .replace(/[^A-Za-z0-9._ ()-]/g, "_")
      .slice(0, 160);
    link.download = filename || "CleanQuote_Product.zip";
    link.href = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
    link.textContent = "Download verified CleanQuote ZIP";
    proof = document.createElement("small");
    proof.textContent = `SHA-256 verified: ${actualHash}`;
  } catch {
    downloadBox.textContent = "The encrypted file failed its checksum. Do not use it; request a fresh delivery.";
    downloadBox.hidden = false;
    return;
  }

  const acknowledgement = document.createElement("small");
  try {
    const acknowledgementState = await acknowledgeDelivery(first, commitment);
    acknowledgement.textContent = {
      sent: "Encrypted receipt sent to a relay; server confirmation is pending.",
      recent: "An encrypted receipt was sent recently; server confirmation remains pending. Refresh later to retry if needed.",
      failed: "The file is verified, but no relay accepted the encrypted receipt. Refresh later to retry.",
    }[acknowledgementState];
  } catch {
    acknowledgement.textContent = "The file is verified, but the encrypted receipt could not be submitted. Server confirmation is pending; refresh later to retry.";
  }
  downloadBox.append(link, proof, acknowledgement);
  downloadBox.hidden = false;
}

async function loadReplies() {
  refreshButton.disabled = true;
  try {
    await unlockTicket(passphraseInput.value);
  } catch (error) {
    passphraseInput.setAttribute("aria-invalid", "true");
    setStatus(error instanceof Error ? error.message : "The ticket could not be unlocked.", "error");
    refreshButton.disabled = false;
    return;
  }

  setStatus("Checking the encrypted order inbox…");
  const pool = new SimplePool({ enableReconnect: false });
  try {
    const sentAt = Number(window.localStorage.getItem(SENT_AT_KEY) || 0);
    const filter = { kinds: [1059], "#p": [ticketPublicKey], limit: 200 };
    if (sentAt > 0) filter.since = Math.max(0, sentAt - 3 * 86_400);

    const wraps = await pool.querySync(RELAYS, filter, { maxWait: 9_000 });
    const unique = [...new Map(wraps.map((event) => [event.id, event])).values()];
    const messages = [];
    const chunks = [];
    let commitmentsChanged = false;

    for (const wrap of unique) {
      try {
        const { rumor } = verifiedUnwrapEvent(
          wrap,
          ticketSecretKey,
          ticketPublicKey,
        );
        if (rumor.pubkey !== SELLER_PUBLIC_KEY) continue;
        let parsed;
        try {
          parsed = JSON.parse(rumor.content);
        } catch {
          parsed = { message: rumor.content };
        }

        if (parsed.version === 2 && parsed.action === "quote") {
          commitmentsChanged = rememberSellerQuoteCommitment(quoteCommitments, parsed) || commitmentsChanged;
          messages.push({
            createdAt: rumor.created_at,
            text: parsed.message,
          });
        } else if (parsed.version === 2 && parsed.action === "delivery_chunk") {
          chunks.push({ ...parsed, createdAt: rumor.created_at });
        } else {
          messages.push({
            createdAt: rumor.created_at,
            text: String(parsed.message || rumor.content).slice(0, 6_000),
          });
        }
      } catch {
        // Ignore malformed events and events not decryptable with this browser's ticket key.
      }
    }

    if (commitmentsChanged) await persistQuoteCommitments();
    messages.sort((a, b) => a.createdAt - b.createdAt);
    renderMessages(messages);
    await renderDelivery(chunks);

    if (messages.length === 0 && chunks.length === 0) {
      setStatus(
        sentAt > 0
          ? "No signed reply yet. Keep this browser storage and check again within 24 hours."
          : "No order request has been sent from this browser yet.",
      );
    } else {
      setStatus("Signed seller replies found. Review the newest message below.", "success");
    }
  } catch {
    setStatus("The relay inbox could not be reached. Try refresh again shortly.", "error");
  } finally {
    pool.destroy();
    refreshButton.disabled = false;
  }
}

orderForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submitButton = orderForm.querySelector("button[type='submit']");
  const formData = new FormData(orderForm);
  const details = String(formData.get("details") || "").trim();

  if (
    !details ||
    !formData.get("private-safe") ||
    !formData.get("terms") ||
    !formData.get("business-only")
  ) {
    setStatus("Add a message and confirm all three order safeguards.", "error");
    return;
  }

  const enteredQuoteId = String(formData.get("quoteId") || "").trim().toLowerCase();
  const enteredTxid = String(formData.get("txid") || "").trim().toLowerCase();
  const quoteIds = new Set(
    [enteredQuoteId, ...(details.match(/\bcq-[0-9a-f]{32}\b/gi) || [])]
      .filter(Boolean)
      .map((value) => value.toLowerCase()),
  );
  const txids = new Set(
    [enteredTxid, ...(details.match(/\b[0-9a-f]{64}\b/gi) || [])]
      .filter(Boolean)
      .map((value) => value.toLowerCase()),
  );

  if (quoteIds.size > 1 || txids.size > 1) {
    setStatus("Use exactly one quote ID and one transaction ID for a payment follow-up.", "error");
    return;
  }
  const quoteId = [...quoteIds][0];
  const txid = [...txids][0];
  if (Boolean(quoteId) !== Boolean(txid)) {
    setStatus("A payment follow-up requires both the exact quote ID and the 64-character transaction ID.", "error");
    return;
  }
  if ((quoteId && !QUOTE_ID_PATTERN.test(quoteId)) || (txid && !TXID_PATTERN.test(txid))) {
    setStatus("The quote ID or transaction ID format is invalid.", "error");
    return;
  }

  submitButton.disabled = true;
  setStatus("Unlocking the ticket and encrypting the request…");

  try {
    await unlockTicket(passphraseInput.value);
    if (quoteId) await rememberSubmittedTransaction(quoteId, txid);
    const publicUrl = new URL(window.location.href);
    publicUrl.hash = "";
    publicUrl.search = "";
    const payload = {
      version: 2,
      product: "cleanquote-v1",
      action: quoteId ? "payment" : "quote_request",
      ticketPublicKey,
      requestId: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      publicUrl: publicUrl.href,
      details,
      ...(quoteId ? { quoteId, txid } : {}),
    };
    const wrapped = nip17.wrapEvent(
      ticketSecretKey,
      { publicKey: SELLER_PUBLIC_KEY, relayUrl: RELAYS[0] },
      JSON.stringify(payload),
      "CleanQuote order",
    );
    const results = await publish(wrapped);
    const accepted = countAcceptedRelayPublishes(results);
    if (accepted < 1) throw new Error("No relay accepted the request");

    if (!window.localStorage.getItem(SENT_AT_KEY)) {
      window.localStorage.setItem(SENT_AT_KEY, String(Math.floor(Date.now() / 1000)));
    }
    orderForm.reset();
    setStatus(
      `Encrypted ${quoteId ? "payment follow-up" : "quote request"} sent through ${accepted} relay${accepted === 1 ? "" : "s"}. Keep the encrypted ticket and passphrase, then check for a signed reply within 24 hours.`,
      "success",
    );
  } catch (error) {
    passphraseInput.setAttribute("aria-invalid", "true");
    setStatus(
      error instanceof Error && /passphrase|ticket|quote|transaction/i.test(error.message)
        ? error.message
        : "The request was not accepted by a relay. Nothing was charged; try again later.",
      "error",
    );
  } finally {
    submitButton.disabled = false;
  }
});

refreshButton.addEventListener("click", loadReplies);
clearTicketButton.addEventListener("click", () => {
  if (
    !window.confirm(
      "Clear this encrypted ticket? This cannot be recovered. Do not continue if you have paid and still need the delivery.",
    )
  ) {
    return;
  }
  if (ticketSecretKey) ticketSecretKey.fill(0);
  ticketSecretKey = undefined;
  ticketPublicKey = undefined;
  ticketStorageKey = undefined;
  quoteCommitments = new Map();
  window.localStorage.removeItem(STORAGE_KEY);
  window.localStorage.removeItem(COMMITMENTS_KEY);
  window.localStorage.removeItem(SENT_AT_KEY);
  window.localStorage.removeItem(ACK_ATTEMPTS_KEY);
  passphraseInput.value = "";
  ticketBox.textContent = "Enter a passphrase to create a new encrypted ticket";
  renderMessages([]);
  downloadBox.replaceChildren();
  downloadBox.hidden = true;
  setStatus("Encrypted ticket cleared. A previous ticket cannot be recovered from this browser.");
});

setStatus(
  window.localStorage.getItem(STORAGE_KEY)
    ? "Enter the ticket passphrase to send or check encrypted messages."
    : "Create a ticket passphrase before sending a quote request. Nothing is charged by this form.",
);
