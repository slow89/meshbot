import { Router, type Request, type Response } from "express";
import * as crypto from "node:crypto";
import type { MessageQueue, MeshMessage } from "../queue/message-queue.js";
import { loadManifest, loadRootPublicKey } from "../config/loader.js";
import type { ManifestPayload } from "../config/types.js";
import { parseEnvelopePayload } from "../security/signing.js";
import { verifyInviteToken } from "../bootstrap/invite.js";

interface BootstrapJoinRequest {
  token?: string;
  nodePubKey?: string;
}

interface BootstrapRouteOptions {
  meshName: string;
}

export function createRoutes(
  agentName: string,
  queue: MessageQueue,
  bootstrap?: BootstrapRouteOptions,
  onAskReceived?: (
    fromAgent: string,
    messageId: string,
    payload: string
  ) => void,
  onMessageReceived?: (
    fromAgent: string,
    messageId: string,
    payload: string
  ) => void
): Router {
  const router = Router();

  if (bootstrap) {
    router.post("/bootstrap/join", (req: Request, res: Response) => {
      const body = req.body as BootstrapJoinRequest;
      const token = body.token;
      const nodePubKey = body.nodePubKey;

      if (!token || !nodePubKey) {
        res.status(400).json({ error: "Missing token or nodePubKey" });
        return;
      }

      let rootPublicKey: string;
      try {
        rootPublicKey = loadRootPublicKey(bootstrap.meshName);
      } catch (err) {
        res.status(503).json({ error: String(err) });
        return;
      }

      const verified = verifyInviteToken(token, rootPublicKey);
      if (!verified.ok || !verified.payload) {
        res.status(401).json({ error: verified.error ?? "Invalid invite token" });
        return;
      }

      const payload = verified.payload;
      if (payload.mesh !== bootstrap.meshName) {
        res.status(403).json({ error: "Invite mesh mismatch" });
        return;
      }
      if (payload.nodePubKey !== nodePubKey) {
        res.status(403).json({ error: "Invite not valid for this node key" });
        return;
      }

      const now = Date.now();
      const skewMs = 60_000;
      if (now + skewMs < payload.nbf) {
        res.status(403).json({ error: "Invite not yet valid" });
        return;
      }
      if (now - skewMs > payload.exp) {
        res.status(403).json({ error: "Invite expired" });
        return;
      }

      try {
        const manifest = loadManifest(bootstrap.meshName);
        const manifestPayload = parseEnvelopePayload(manifest) as ManifestPayload;
        if (payload.minManifestVersion !== undefined && manifestPayload.version < payload.minManifestVersion) {
          res.status(412).json({ error: "Peer manifest version is too old" });
          return;
        }

        res.json({
          ok: true,
          mesh: bootstrap.meshName,
          agent: payload.agent,
          now,
          manifest,
          sync: {
            headUrl: "/mesh/bootstrap/head",
            manifestUrlTemplate: "/mesh/bootstrap/manifest/{version}",
            intervalSeconds: 30,
          },
        });
      } catch (err) {
        res.status(503).json({ error: String(err) });
      }
    });

    router.get("/bootstrap/head", (_req: Request, res: Response) => {
      try {
        const manifest = loadManifest(bootstrap.meshName);
        const payload = parseEnvelopePayload(manifest) as ManifestPayload;
        const manifestHash = crypto
          .createHash("sha256")
          .update(manifest.payload)
          .digest("hex");

        res.json({
          mesh: payload.mesh,
          version: payload.version,
          manifestHash: `sha256:${manifestHash}`,
          issuedAt: payload.issuedAt,
        });
      } catch (err) {
        res.status(503).json({ error: String(err) });
      }
    });

    router.get("/bootstrap/manifest/:version", (req: Request, res: Response) => {
      try {
        const requestedVersionParam = req.params["version"];
        const requestedVersionRaw = Array.isArray(requestedVersionParam)
          ? requestedVersionParam[0]
          : requestedVersionParam;
        if (!requestedVersionRaw) {
          res.status(400).json({ error: "Missing manifest version" });
          return;
        }

        const manifest = loadManifest(bootstrap.meshName);
        const payload = parseEnvelopePayload(manifest) as ManifestPayload;

        if (requestedVersionRaw !== "latest") {
          const requestedVersion = Number.parseInt(requestedVersionRaw, 10);
          if (!Number.isFinite(requestedVersion)) {
            res.status(400).json({ error: "Invalid manifest version" });
            return;
          }
          if (requestedVersion !== payload.version) {
            res.status(404).json({ error: `Manifest version ${requestedVersionRaw} not found` });
            return;
          }
        }

        res.json(manifest);
      } catch (err) {
        res.status(503).json({ error: String(err) });
      }
    });
  }

  // Fire-and-forget message
  router.post("/msg", (req: Request, res: Response) => {
    const msg = req.body as MeshMessage;
    if (msg.to !== agentName) {
      res.status(404).json({ error: `Agent "${msg.to}" not found here` });
      return;
    }

    queue.enqueue({
      id: msg.id,
      from: msg.from,
      message: msg.payload,
      timestamp: msg.timestamp,
      type: "message",
    });

    if (onMessageReceived) {
      onMessageReceived(msg.from, msg.id, msg.payload);
    }

    res.json({ delivered: true, messageId: msg.id });
  });

  // Request/reply (ask)
  router.post("/ask", (req: Request, res: Response) => {
    const msg = req.body as MeshMessage;
    if (msg.to !== agentName) {
      res.status(404).json({ error: `Agent "${msg.to}" not found here` });
      return;
    }

    // Queue the ask message
    queue.enqueue({
      id: msg.id,
      from: msg.from,
      message: msg.payload,
      timestamp: msg.timestamp,
      type: "ask",
    });

    if (onAskReceived) {
      onAskReceived(msg.from, msg.id, msg.payload);
    }

    // Immediately acknowledge receipt -- the response will come later
    // via a separate HTTP call from this agent back to the sender
    res.json({ received: true, messageId: msg.id });
  });

  // Receive a response to a previous ask
  router.post("/response", (req: Request, res: Response) => {
    const msg = req.body as MeshMessage;
    if (!msg.replyTo) {
      res.status(400).json({ error: "Missing replyTo field" });
      return;
    }

    const resolved = queue.resolveAsk(msg.replyTo, msg.payload);
    if (!resolved) {
      // No pending ask with this ID -- might have timed out
      res.json({ received: true, resolved: false });
      return;
    }

    res.json({ received: true, resolved: true });
  });

  // Health check
  router.get("/health", (_req: Request, res: Response) => {
    res.json({
      agent: agentName,
      status: "online",
      timestamp: Date.now(),
    });
  });

  return router;
}
