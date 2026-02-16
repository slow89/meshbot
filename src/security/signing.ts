import * as crypto from "node:crypto";

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
