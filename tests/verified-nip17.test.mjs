import assert from "node:assert/strict";
import test from "node:test";
import {
  finalizeEvent,
  generateSecretKey,
  getEventHash,
  getPublicKey,
  nip17,
  nip44,
} from "nostr-tools";
import { verifiedUnwrapEvent } from "../src/verified-nip17.js";

function encryptedEvent(content, senderSecretKey, recipientPublicKey, kind, tags = []) {
  return finalizeEvent(
    {
      kind,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: nip44.encrypt(
        typeof content === "string" ? content : JSON.stringify(content),
        nip44.getConversationKey(senderSecretKey, recipientPublicKey),
      ),
    },
    senderSecretKey,
  );
}

function wrapSeal(seal, recipientPublicKey) {
  const wrapSecretKey = generateSecretKey();
  return encryptedEvent(
    seal,
    wrapSecretKey,
    recipientPublicKey,
    1059,
    [["p", recipientPublicKey]],
  );
}

function forgedSenderWrap({
  actualSenderSecretKey,
  claimedSenderPublicKey,
  recipientPublicKey,
  rumorKind = 14,
  rumorRecipient = recipientPublicKey,
  corruptRumorId = false,
}) {
  const rumor = {
    kind: rumorKind,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["p", rumorRecipient]],
    content: "forged payload",
    pubkey: claimedSenderPublicKey,
  };
  rumor.id = corruptRumorId ? "0".repeat(64) : getEventHash(rumor);
  const seal = encryptedEvent(
    rumor,
    actualSenderSecretKey,
    recipientPublicKey,
    13,
  );
  return wrapSeal(seal, recipientPublicKey);
}

test("accepts a correctly signed and recipient-bound NIP-17 message", () => {
  const sender = generateSecretKey();
  const recipient = generateSecretKey();
  const recipientPublicKey = getPublicKey(recipient);
  const wrap = nip17.wrapEvent(
    sender,
    { publicKey: recipientPublicKey, relayUrl: "wss://relay.example" },
    "hello",
    "test",
  );
  const { rumor, seal } = verifiedUnwrapEvent(wrap, recipient, recipientPublicKey);
  assert.equal(rumor.content, "hello");
  assert.equal(rumor.pubkey, getPublicKey(sender));
  assert.equal(seal.pubkey, rumor.pubkey);
});

test("rejects a rumor that claims a different sender than the seal signer", () => {
  const seller = generateSecretKey();
  const attacker = generateSecretKey();
  const recipient = generateSecretKey();
  const wrap = forgedSenderWrap({
    actualSenderSecretKey: attacker,
    claimedSenderPublicKey: getPublicKey(seller),
    recipientPublicKey: getPublicKey(recipient),
  });
  assert.throws(
    () => verifiedUnwrapEvent(wrap, recipient, getPublicKey(recipient)),
    /authenticated seal signer/,
  );
});

test("rejects invalid wrap and seal signatures", () => {
  const sender = generateSecretKey();
  const recipient = generateSecretKey();
  const recipientPublicKey = getPublicKey(recipient);
  const valid = nip17.wrapEvent(
    sender,
    { publicKey: recipientPublicKey },
    "hello",
  );
  const badWrap = { ...valid, sig: `${valid.sig.slice(0, -1)}${valid.sig.endsWith("0") ? "1" : "0"}` };
  assert.throws(() => verifiedUnwrapEvent(badWrap, recipient, recipientPublicKey), /Gift wrap/);

  const seal = JSON.parse(
    nip44.decrypt(
      valid.content,
      nip44.getConversationKey(recipient, valid.pubkey),
    ),
  );
  seal.sig = `${seal.sig.slice(0, -1)}${seal.sig.endsWith("0") ? "1" : "0"}`;
  const badSealWrap = wrapSeal(seal, recipientPublicKey);
  assert.throws(() => verifiedUnwrapEvent(badSealWrap, recipient, recipientPublicKey), /Seal signature/);
});

test("rejects rumor id, kind, and recipient mismatches", () => {
  const sender = generateSecretKey();
  const recipient = generateSecretKey();
  const otherRecipient = generateSecretKey();
  const base = {
    actualSenderSecretKey: sender,
    claimedSenderPublicKey: getPublicKey(sender),
    recipientPublicKey: getPublicKey(recipient),
  };
  assert.throws(
    () => verifiedUnwrapEvent(forgedSenderWrap({ ...base, corruptRumorId: true }), recipient),
    /identifier/,
  );
  assert.throws(
    () => verifiedUnwrapEvent(forgedSenderWrap({ ...base, rumorKind: 1 }), recipient),
    /rumor structure/,
  );
  assert.throws(
    () => verifiedUnwrapEvent(
      forgedSenderWrap({ ...base, rumorRecipient: getPublicKey(otherRecipient) }),
      recipient,
    ),
    /intended recipient/,
  );
});
