import {
  getEventHash,
  getPublicKey,
  nip44,
  validateEvent,
  verifyEvent,
} from "nostr-tools";

function requireRecipient(tags, recipientPublicKey, layer) {
  const recipients = tags.filter((tag) => tag[0] === "p").map((tag) => tag[1]);
  if (recipients.length < 1 || !recipients.includes(recipientPublicKey)) {
    throw new Error(`${layer} does not name the intended recipient`);
  }
}

function decryptJson(content, recipientSecretKey, senderPublicKey, layer) {
  const conversationKey = nip44.getConversationKey(recipientSecretKey, senderPublicKey);
  let parsed;
  try {
    parsed = JSON.parse(nip44.decrypt(content, conversationKey));
  } catch {
    throw new Error(`${layer} could not be authenticated and decrypted`);
  }
  return parsed;
}

function verifySignedEvent(event) {
  if (!validateEvent(event)) return false;
  // Build a plain event so nostr-tools cannot reuse an in-process verification
  // cache after a caller has mutated a previously signed object.
  return verifyEvent({
    id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    tags: event.tags.map((tag) => [...tag]),
    content: event.content,
    sig: event.sig,
  });
}

/**
 * Fully authenticate a NIP-59 gift wrap carrying a NIP-17 direct message.
 * `nip17.unwrapEvent` only decrypts; this routine additionally validates the
 * signed wrap and seal and binds the rumor author to the seal signer.
 */
export function verifiedUnwrapEvent(wrap, recipientSecretKey, expectedRecipientPublicKey) {
  const recipientPublicKey = getPublicKey(recipientSecretKey);
  if (expectedRecipientPublicKey && expectedRecipientPublicKey !== recipientPublicKey) {
    throw new Error("Recipient key does not match the expected public key");
  }
  if (!validateEvent(wrap) || wrap.kind !== 1059 || !verifySignedEvent(wrap)) {
    throw new Error("Gift wrap signature or structure is invalid");
  }
  requireRecipient(wrap.tags, recipientPublicKey, "Gift wrap");

  const seal = decryptJson(
    wrap.content,
    recipientSecretKey,
    wrap.pubkey,
    "Gift wrap",
  );
  if (
    !validateEvent(seal) ||
    seal.kind !== 13 ||
    seal.tags.length !== 0 ||
    !verifySignedEvent(seal)
  ) {
    throw new Error("Seal signature or structure is invalid");
  }

  const rumor = decryptJson(
    seal.content,
    recipientSecretKey,
    seal.pubkey,
    "Seal",
  );
  if (!validateEvent(rumor) || rumor.kind !== 14) {
    throw new Error("Direct-message rumor structure is invalid");
  }
  if (rumor.pubkey !== seal.pubkey) {
    throw new Error("Rumor author is not the authenticated seal signer");
  }
  if (typeof rumor.id !== "string" || getEventHash(rumor) !== rumor.id) {
    throw new Error("Rumor identifier does not match its contents");
  }
  requireRecipient(rumor.tags, recipientPublicKey, "Direct-message rumor");

  return { rumor, seal, wrap };
}
