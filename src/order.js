import {
  SimplePool,
  generateSecretKey,
  getPublicKey,
  nip17,
  nip19,
} from "nostr-tools";
import { bytesToHex, hexToBytes } from "nostr-tools/utils";

const SELLER_PUBLIC_KEY =
  "350390e2ddcb4d14a0802cff6c1ce47868871d6719cff65d4ecf9eca1bc276a3";
const RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.primal.net",
  "wss://nostr.mom",
];
const STORAGE_KEY = "cleanquote-order-ticket-key-v1";
const SENT_AT_KEY = "cleanquote-order-sent-at-v1";

const orderForm = document.querySelector("#cleanquote-order-form");
const statusBox = document.querySelector("#order-status");
const ticketBox = document.querySelector("#order-ticket-id");
const repliesBox = document.querySelector("#order-replies");
const refreshButton = document.querySelector("#order-refresh");
const downloadBox = document.querySelector("#order-download");

if (!orderForm || !statusBox || !ticketBox || !repliesBox || !refreshButton || !downloadBox) {
  throw new Error("CleanQuote order markup is incomplete");
}

function loadOrCreateTicketKey() {
  let stored = window.localStorage.getItem(STORAGE_KEY);
  if (!stored || !/^[0-9a-f]{64}$/.test(stored)) {
    stored = bytesToHex(generateSecretKey());
    window.localStorage.setItem(STORAGE_KEY, stored);
  }
  return hexToBytes(stored);
}

const ticketSecretKey = loadOrCreateTicketKey();
const ticketPublicKey = getPublicKey(ticketSecretKey);
ticketBox.textContent = nip19.npubEncode(ticketPublicKey);

function setStatus(message, state = "neutral") {
  statusBox.textContent = message;
  statusBox.dataset.state = state;
}

function acceptedRelayCount(results) {
  return results.filter(
    (result) =>
      result.status === "fulfilled" &&
      !/(failure|failed|error|reject|blocked|rate)/i.test(String(result.value)),
  ).length;
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
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return bytesToHex(new Uint8Array(digest));
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

  const byDelivery = new Map();
  for (const chunk of chunks) {
    if (!chunk.deliveryId || !Number.isInteger(chunk.part) || !Number.isInteger(chunk.total)) continue;
    const group = byDelivery.get(chunk.deliveryId) || [];
    group.push(chunk);
    byDelivery.set(chunk.deliveryId, group);
  }

  const complete = [...byDelivery.values()]
    .filter((group) => group.length === group[0].total)
    .sort((a, b) => Math.max(...b.map((item) => item.createdAt)) - Math.max(...a.map((item) => item.createdAt)))[0];

  if (!complete) {
    downloadBox.textContent = "Encrypted delivery is arriving in parts. Refresh again shortly.";
    downloadBox.hidden = false;
    return;
  }

  const ordered = [...complete].sort((a, b) => a.part - b.part);
  const first = ordered[0];
  if (ordered.some((item, index) => item.part !== index + 1 || item.total !== first.total || item.sha256 !== first.sha256)) {
    downloadBox.textContent = "Delivery parts did not match. Do not use the file; request a fresh delivery.";
    downloadBox.hidden = false;
    return;
  }

  try {
    const bytes = decodeBase64(ordered.map((item) => item.data).join(""));
    const actualHash = await sha256Hex(bytes);
    if (actualHash !== first.sha256) throw new Error("Checksum mismatch");

    const link = document.createElement("a");
    link.className = "button button-lime";
    link.download = first.filename || "CleanQuote_Product.zip";
    link.href = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
    link.textContent = "Download verified CleanQuote ZIP";
    const proof = document.createElement("small");
    proof.textContent = `SHA-256 verified: ${actualHash}`;
    downloadBox.append(link, proof);
    downloadBox.hidden = false;
  } catch {
    downloadBox.textContent = "The encrypted file failed its checksum. Do not use it; request a fresh delivery.";
    downloadBox.hidden = false;
  }
}

async function loadReplies() {
  refreshButton.disabled = true;
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

    for (const wrap of unique) {
      try {
        const rumor = nip17.unwrapEvent(wrap, ticketSecretKey);
        if (rumor.pubkey !== SELLER_PUBLIC_KEY) continue;
        let parsed;
        try {
          parsed = JSON.parse(rumor.content);
        } catch {
          parsed = { message: rumor.content };
        }

        if (parsed.type === "cleanquote_file_chunk") {
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

  if (!details || !formData.get("private-safe") || !formData.get("terms")) {
    setStatus("Add a message and confirm both order safeguards.", "error");
    return;
  }

  const payload = {
    version: 1,
    product: "cleanquote-v1",
    requestId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    ticketPublicKey,
    summary: "CleanQuote digital product order",
    publicUrl: window.location.href,
    details,
  };

  submitButton.disabled = true;
  setStatus("Encrypting and sending the order request…");

  try {
    const wrapped = nip17.wrapEvent(
      ticketSecretKey,
      { publicKey: SELLER_PUBLIC_KEY, relayUrl: RELAYS[0] },
      JSON.stringify(payload),
      "CleanQuote order",
    );
    const results = await publish(wrapped);
    const accepted = acceptedRelayCount(results);
    if (accepted < 1) throw new Error("No relay accepted the request");

    if (!window.localStorage.getItem(SENT_AT_KEY)) {
      window.localStorage.setItem(SENT_AT_KEY, String(Math.floor(Date.now() / 1000)));
    }
    orderForm.reset();
    setStatus(
      `Encrypted request sent through ${accepted} relay${accepted === 1 ? "" : "s"}. Keep this browser storage and check for a signed reply within 24 hours.`,
      "success",
    );
  } catch {
    setStatus("The request was not accepted by a relay. Nothing was charged; try again later.", "error");
  } finally {
    submitButton.disabled = false;
  }
});

refreshButton.addEventListener("click", loadReplies);
if (window.localStorage.getItem(SENT_AT_KEY)) loadReplies();
