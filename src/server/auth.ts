import type { Request, Response, NextFunction } from "express";
import {
  verifyHmac,
  isTimestampValid,
  NonceTracker,
  type SignableMessage,
} from "../security/signing.js";
import type { MeshMessage } from "../queue/message-queue.js";

export function createAuthMiddleware(
  meshKey: string,
  replayWindowSeconds: number,
  maxMessageSizeBytes: number
) {
  const nonceTracker = new NonceTracker(replayWindowSeconds);

  return (req: Request, res: Response, next: NextFunction) => {
    // Check bearer token
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      res.status(401).json({ error: "Missing or invalid authorization" });
      return;
    }
    const token = authHeader.slice(7);
    if (token !== meshKey) {
      res.status(401).json({ error: "Invalid mesh key" });
      return;
    }

    // Some authenticated endpoints (e.g. bootstrap manifest/head)
    // use GET and do not carry signed mesh message bodies.
    if (req.method === "GET") {
      next();
      return;
    }

    // Size check
    const contentLength = parseInt(
      req.headers["content-length"] ?? "0",
      10
    );
    if (contentLength > maxMessageSizeBytes) {
      res.status(413).json({ error: "Message too large" });
      return;
    }

    // The body should already be parsed as JSON by express.json()
    const msg = req.body as MeshMessage | undefined;
    if (!msg?.id || !msg.nonce || !msg.timestamp || !msg.hmac) {
      res.status(400).json({ error: "Invalid message format" });
      return;
    }

    // Timestamp check
    if (!isTimestampValid(msg.timestamp, replayWindowSeconds)) {
      res.status(400).json({ error: "Message timestamp expired" });
      return;
    }

    // Nonce check (replay protection)
    if (!nonceTracker.check(msg.nonce, msg.timestamp)) {
      res.status(400).json({ error: "Duplicate nonce (replay detected)" });
      return;
    }

    // HMAC verification
    const signable: SignableMessage = {
      id: msg.id,
      type: msg.type,
      payload: msg.payload,
      timestamp: msg.timestamp,
      nonce: msg.nonce,
    };
    if (!verifyHmac(meshKey, signable, msg.hmac)) {
      res.status(400).json({ error: "HMAC verification failed" });
      return;
    }

    next();
  };
}
