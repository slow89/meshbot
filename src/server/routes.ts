import { Router, type Request, type Response } from "express";
import type { MessageQueue, MeshMessage } from "../queue/message-queue.js";

export function createRoutes(
  agentName: string,
  queue: MessageQueue,
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
