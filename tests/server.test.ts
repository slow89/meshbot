import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startHttpServer, type HttpServer } from "../src/server/http-server.js";
import { MessageQueue } from "../src/queue/message-queue.js";
import { generateMeshKey } from "../src/security/keys.js";
import { signMessage, generateNonce } from "../src/security/signing.js";
import type { MeshMessage } from "../src/queue/message-queue.js";

describe("HTTP server", () => {
  let server: HttpServer;
  let queue: MessageQueue;
  const meshKey = generateMeshKey();
  const agentName = "test-agent";
  let baseUrl: string;

  beforeAll(async () => {
    queue = new MessageQueue();
    server = await startHttpServer({
      agentName,
      port: 0, // Random available port
      host: "127.0.0.1",
      meshKey,
      queue,
      replayWindowSeconds: 60,
      maxMessageSizeBytes: 1_048_576,
      dev: true,
    });
    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    queue.destroy();
    await server.close();
  });

  function buildMessage(
    overrides: Partial<MeshMessage> = {}
  ): MeshMessage {
    const id = crypto.randomUUID();
    const timestamp = Date.now();
    const nonce = generateNonce();
    const type = overrides.type ?? "message";
    const payload = overrides.payload ?? "test message";

    const hmac = signMessage(meshKey, {
      id,
      type,
      payload,
      timestamp,
      nonce,
    });

    return {
      id,
      from: "sender",
      to: agentName,
      type,
      payload,
      timestamp,
      nonce,
      hmac,
      ...overrides,
    };
  }

  it("health endpoint works without auth", async () => {
    const res = await fetch(`${baseUrl}/mesh/health`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.agent).toBe(agentName);
    expect(data.status).toBe("online");
  });

  it("rejects requests without auth", async () => {
    const msg = buildMessage();
    const res = await fetch(`${baseUrl}/mesh/msg`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(msg),
    });
    expect(res.status).toBe(401);
  });

  it("rejects requests with wrong key", async () => {
    const msg = buildMessage();
    const res = await fetch(`${baseUrl}/mesh/msg`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer wrong-key`,
      },
      body: JSON.stringify(msg),
    });
    expect(res.status).toBe(401);
  });

  it("accepts valid messages", async () => {
    const msg = buildMessage();
    const res = await fetch(`${baseUrl}/mesh/msg`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${meshKey}`,
      },
      body: JSON.stringify(msg),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { delivered: boolean; messageId: string };
    expect(data.delivered).toBe(true);
    expect(data.messageId).toBe(msg.id);

    // Verify message was queued
    const queued = queue.drain();
    expect(queued.length).toBe(1);
    expect(queued[0]!.from).toBe("sender");
    expect(queued[0]!.message).toBe("test message");
  });

  it("rejects replayed messages (duplicate nonce)", async () => {
    const msg = buildMessage();

    // First send should succeed
    const res1 = await fetch(`${baseUrl}/mesh/msg`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${meshKey}`,
      },
      body: JSON.stringify(msg),
    });
    expect(res1.status).toBe(200);
    queue.drain(); // Clear queue

    // Replay should fail
    const res2 = await fetch(`${baseUrl}/mesh/msg`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${meshKey}`,
      },
      body: JSON.stringify(msg),
    });
    expect(res2.status).toBe(400);
    const data = (await res2.json()) as { error: string };
    expect(data.error).toContain("replay");
  });

  it("rejects messages with tampered HMAC", async () => {
    const msg = buildMessage();
    msg.hmac = "0".repeat(64); // Invalid HMAC

    const res = await fetch(`${baseUrl}/mesh/msg`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${meshKey}`,
      },
      body: JSON.stringify(msg),
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("HMAC");
  });

  it("rejects messages for wrong agent", async () => {
    const msg = buildMessage({ to: "wrong-agent" });
    const res = await fetch(`${baseUrl}/mesh/msg`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${meshKey}`,
      },
      body: JSON.stringify(msg),
    });
    expect(res.status).toBe(404);
  });

  it("handles ask and response flow", async () => {
    const askMsg = buildMessage({ type: "ask", payload: "what is 2+2?" });

    // Send ask
    const res = await fetch(`${baseUrl}/mesh/ask`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${meshKey}`,
      },
      body: JSON.stringify(askMsg),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { received: boolean };
    expect(data.received).toBe(true);

    // Verify it was queued as an ask
    const queued = queue.drain();
    expect(queued.length).toBe(1);
    expect(queued[0]!.type).toBe("ask");
  });
});
