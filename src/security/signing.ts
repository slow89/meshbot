import * as crypto from "node:crypto";
import type { SignedEnvelope } from "../config/types.js";

export interface SignableMessage {
  id: string;
  type: string;
  payload: string;
  timestamp: number;
  nonce: string;
}

export function signMessage(key: string, msg: SignableMessage): string {
  const data = `${msg.id}|${msg.type}|${msg.payload}|${String(msg.timestamp)}|${msg.nonce}`;
  return crypto.createHmac("sha256", key).update(data).digest("hex");
}

export function verifyHmac(
  key: string,
  msg: SignableMessage,
  hmac: string
): boolean {
  const expected = signMessage(key, msg);
  return crypto.timingSafeEqual(
    Buffer.from(expected, "hex"),
    Buffer.from(hmac, "hex")
  );
}

/**
 * Validates timestamp is within the replay window.
 */
export function isTimestampValid(
  timestamp: number,
  windowSeconds: number
): boolean {
  const now = Date.now();
  const diff = Math.abs(now - timestamp);
  return diff <= windowSeconds * 1000;
}

/**
 * Simple nonce tracker using a Set with automatic cleanup.
 * Nonces older than the window are pruned periodically.
 */
export class NonceTracker {
  private seen = new Map<string, number>(); // nonce -> timestamp
  private windowMs: number;

  constructor(windowSeconds: number) {
    this.windowMs = windowSeconds * 1000;
  }

  /**
   * Returns true if the nonce is new (not a replay).
   * Returns false if the nonce was already seen (replay attack).
   */
  check(nonce: string, timestamp: number): boolean {
    this.prune();
    if (this.seen.has(nonce)) {
      return false;
    }
    this.seen.set(nonce, timestamp);
    return true;
  }

  private prune(): void {
    const cutoff = Date.now() - this.windowMs;
    for (const [nonce, ts] of this.seen) {
      if (ts < cutoff) {
        this.seen.delete(nonce);
      }
    }
  }
}

export function generateNonce(): string {
  return crypto.randomUUID();
}

function encodeBase64Url(input: Buffer): string {
  return input.toString("base64url");
}

function decodeBase64Url(input: string): Buffer {
  return Buffer.from(input, "base64url");
}

function canonicalizeValue(value: unknown): string {
  if (value === null) return "null";

  const valueType = typeof value;
  if (valueType === "string") return JSON.stringify(value);
  if (valueType === "boolean") return value ? "true" : "false";

  if (valueType === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Cannot canonicalize non-finite numbers");
    }
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeValue(item)).join(",")}]`;
  }

  if (valueType === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort((a, b) => a.localeCompare(b));
    const pairs = keys.map((key) => `${JSON.stringify(key)}:${canonicalizeValue(record[key])}`);
    return `{${pairs.join(",")}}`;
  }

  throw new Error(`Cannot canonicalize value of type "${valueType}"`);
}

export function canonicalizeJson(value: unknown): string {
  return canonicalizeValue(value);
}

export function signEnvelopeEd25519(
  payload: unknown,
  privateKeyPem: string,
  kid: string
): SignedEnvelope {
  const payloadJson = canonicalizeJson(payload);
  const payloadBytes = Buffer.from(payloadJson, "utf-8");
  const signature = crypto.sign(null, payloadBytes, privateKeyPem);

  return {
    alg: "Ed25519",
    kid,
    payload: encodeBase64Url(payloadBytes),
    sig: encodeBase64Url(signature),
  };
}

export function verifyEnvelopeEd25519(
  envelope: SignedEnvelope,
  publicKeyPem: string
): boolean {
  try {
    const payloadBytes = decodeBase64Url(envelope.payload);
    const signature = decodeBase64Url(envelope.sig);
    return crypto.verify(null, payloadBytes, publicKeyPem, signature);
  } catch {
    return false;
  }
}

export function parseEnvelopePayload(envelope: SignedEnvelope): unknown {
  const payloadBytes = decodeBase64Url(envelope.payload);
  const payloadJson = payloadBytes.toString("utf-8");
  return JSON.parse(payloadJson) as unknown;
}
