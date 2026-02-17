import { describe, it, expect } from "vitest";
import { generateMeshKey, generateSigningKeyPair } from "../src/security/keys.js";
import {
  signMessage,
  verifyHmac,
  isTimestampValid,
  NonceTracker,
  generateNonce,
  canonicalizeJson,
  signEnvelopeEd25519,
  verifyEnvelopeEd25519,
  parseEnvelopePayload,
  type SignableMessage,
} from "../src/security/signing.js";
import type { ManifestPayload } from "../src/config/types.js";

describe("key generation", () => {
  it("generates a 256-bit base64 key", () => {
    const key = generateMeshKey();
    const buf = Buffer.from(key, "base64");
    expect(buf.length).toBe(32);
  });

  it("generates unique keys", () => {
    const a = generateMeshKey();
    const b = generateMeshKey();
    expect(a).not.toBe(b);
  });
});

describe("HMAC signing", () => {
  const key = generateMeshKey();
  const msg: SignableMessage = {
    id: "test-id",
    type: "message",
    payload: "hello world",
    timestamp: Date.now(),
    nonce: generateNonce(),
  };

  it("produces a hex string", () => {
    const hmac = signMessage(key, msg);
    expect(hmac).toMatch(/^[a-f0-9]{64}$/);
  });

  it("verifies a valid signature", () => {
    const hmac = signMessage(key, msg);
    expect(verifyHmac(key, msg, hmac)).toBe(true);
  });

  it("rejects a wrong key", () => {
    const hmac = signMessage(key, msg);
    const wrongKey = generateMeshKey();
    expect(verifyHmac(wrongKey, msg, hmac)).toBe(false);
  });

  it("rejects a tampered payload", () => {
    const hmac = signMessage(key, msg);
    const tampered = { ...msg, payload: "tampered" };
    expect(verifyHmac(key, tampered, hmac)).toBe(false);
  });

  it("rejects a tampered timestamp", () => {
    const hmac = signMessage(key, msg);
    const tampered = { ...msg, timestamp: msg.timestamp + 1 };
    expect(verifyHmac(key, tampered, hmac)).toBe(false);
  });
});

describe("timestamp validation", () => {
  it("accepts a fresh timestamp", () => {
    expect(isTimestampValid(Date.now(), 60)).toBe(true);
  });

  it("accepts a timestamp within the window", () => {
    expect(isTimestampValid(Date.now() - 30_000, 60)).toBe(true);
  });

  it("rejects a timestamp outside the window", () => {
    expect(isTimestampValid(Date.now() - 120_000, 60)).toBe(false);
  });

  it("rejects a far-future timestamp", () => {
    expect(isTimestampValid(Date.now() + 120_000, 60)).toBe(false);
  });
});

describe("nonce tracker", () => {
  it("accepts a new nonce", () => {
    const tracker = new NonceTracker(60);
    expect(tracker.check("nonce-1", Date.now())).toBe(true);
  });

  it("rejects a duplicate nonce", () => {
    const tracker = new NonceTracker(60);
    tracker.check("nonce-1", Date.now());
    expect(tracker.check("nonce-1", Date.now())).toBe(false);
  });

  it("accepts different nonces", () => {
    const tracker = new NonceTracker(60);
    expect(tracker.check("nonce-1", Date.now())).toBe(true);
    expect(tracker.check("nonce-2", Date.now())).toBe(true);
  });

  it("prunes old nonces", () => {
    const tracker = new NonceTracker(1); // 1 second window
    const oldTimestamp = Date.now() - 2000;
    tracker.check("old-nonce", oldTimestamp);

    // After pruning, old nonce should be gone
    // We need to trigger prune by checking a new nonce
    tracker.check("new-nonce", Date.now());

    // Old nonce should be pruned and accepted again
    expect(tracker.check("old-nonce", Date.now())).toBe(true);
  });
});

describe("nonce generation", () => {
  it("generates a UUID", () => {
    const nonce = generateNonce();
    expect(nonce).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });

  it("generates unique nonces", () => {
    const a = generateNonce();
    const b = generateNonce();
    expect(a).not.toBe(b);
  });
});

describe("manifest signing", () => {
  it("creates a deterministic canonical JSON representation", () => {
    const a = canonicalizeJson({ b: 2, a: 1, c: { y: 2, x: 1 } });
    const b = canonicalizeJson({ c: { x: 1, y: 2 }, a: 1, b: 2 });
    expect(a).toBe(b);
  });

  it("signs and verifies a manifest envelope", () => {
    const { privateKeyPem, publicKeyPem } = generateSigningKeyPair();
    const payload: ManifestPayload = {
      v: 1,
      mesh: "test-mesh",
      version: 1,
      issuedAt: "2026-02-17T00:00:00.000Z",
      security: {
        replayWindowSeconds: 60,
        maxMessageSizeBytes: 1_048_576,
      },
      transport: { meshKey: generateMeshKey() },
      agents: {
        dev: { url: "https://dev.example.com:9820" },
      },
      revocations: {
        inviteJti: [],
        agents: [],
      },
    };

    const envelope = signEnvelopeEd25519(payload, privateKeyPem, "root-2026-02-17");
    expect(verifyEnvelopeEd25519(envelope, publicKeyPem)).toBe(true);

    const decoded = parseEnvelopePayload(envelope) as ManifestPayload;
    expect(decoded.mesh).toBe(payload.mesh);
    expect(decoded.agents["dev"]?.url).toBe("https://dev.example.com:9820");
  });

  it("rejects verification with a different public key", () => {
    const signer = generateSigningKeyPair();
    const other = generateSigningKeyPair();
    const envelope = signEnvelopeEd25519({ ok: true }, signer.privateKeyPem, "root-kid");
    expect(verifyEnvelopeEd25519(envelope, other.publicKeyPem)).toBe(false);
  });
});
