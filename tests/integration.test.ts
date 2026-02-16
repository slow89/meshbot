import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startHttpServer, type HttpServer } from "../src/server/http-server.js";
import { MessageQueue } from "../src/queue/message-queue.js";
import { generateMeshKey } from "../src/security/keys.js";
import { sendMeshMessage, checkPeerHealth } from "../src/client/mesh-client.js";
import type { MeshConfig } from "../src/config/types.js";

describe("integration: two agents communicate", () => {
  let aliceServer: HttpServer;
  let bobServer: HttpServer;
  let aliceQueue: MessageQueue;
  let bobQueue: MessageQueue;
  const meshKey = generateMeshKey();
  let config: MeshConfig;

  beforeAll(async () => {
    aliceQueue = new MessageQueue();
    bobQueue = new MessageQueue();

    // Start Alice on a random port
    aliceServer = await startHttpServer({
      agentName: "alice",
      port: 0,
      host: "127.0.0.1",
      meshKey,
      queue: aliceQueue,
      replayWindowSeconds: 60,
      maxMessageSizeBytes: 1_048_576,
      dev: true,
    });

    // Start Bob on a random port
    bobServer = await startHttpServer({
      agentName: "bob",
      port: 0,
      host: "127.0.0.1",
      meshKey,
      queue: bobQueue,
      replayWindowSeconds: 60,
      maxMessageSizeBytes: 1_048_576,
      dev: true,
    });

    // Config with both peers
    config = {
      mesh: "test-mesh",
      peers: {
        alice: {
          url: `http://127.0.0.1:${aliceServer.port}`,
          description: "Test agent Alice",
        },
        bob: {
          url: `http://127.0.0.1:${bobServer.port}`,
          description: "Test agent Bob",
        },
      },
      security: {
        replayWindowSeconds: 60,
        maxMessageSizeBytes: 1_048_576,
      },
    };
  });

  afterAll(async () => {
    aliceQueue.destroy();
    bobQueue.destroy();
    await aliceServer.close();
    await bobServer.close();
  });

  it("alice can send a message to bob", async () => {
    const result = await sendMeshMessage({
      from: "alice",
      to: "bob",
      peerUrl: config.peers["bob"]!.url,
      payload: "Hello Bob!",
      meshKey,
      type: "message",
    });

    expect(result.success).toBe(true);

    // Bob should have the message
    const messages = bobQueue.drain();
    expect(messages.length).toBe(1);
    expect(messages[0]!.from).toBe("alice");
    expect(messages[0]!.message).toBe("Hello Bob!");
  });

  it("bob can send a message to alice", async () => {
    const result = await sendMeshMessage({
      from: "bob",
      to: "alice",
      peerUrl: config.peers["alice"]!.url,
      payload: "Hey Alice!",
      meshKey,
      type: "message",
    });

    expect(result.success).toBe(true);

    const messages = aliceQueue.drain();
    expect(messages.length).toBe(1);
    expect(messages[0]!.from).toBe("bob");
    expect(messages[0]!.message).toBe("Hey Alice!");
  });

  it("both agents show as online via health check", async () => {
    const aliceHealth = await checkPeerHealth(config.peers["alice"]!.url);
    const bobHealth = await checkPeerHealth(config.peers["bob"]!.url);

    expect(aliceHealth.online).toBe(true);
    expect(aliceHealth.agent).toBe("alice");
    expect(bobHealth.online).toBe(true);
    expect(bobHealth.agent).toBe("bob");
  });

  it("ask/response flow works end-to-end", async () => {
    // Alice sends an ask to Bob
    const askResult = await sendMeshMessage({
      from: "alice",
      to: "bob",
      peerUrl: config.peers["bob"]!.url,
      payload: "What is 2+2?",
      meshKey,
      type: "ask",
    });

    expect(askResult.success).toBe(true);

    // Register Alice's wait for the response
    const responsePromise = aliceQueue.registerAsk(askResult.messageId, 5000);

    // Bob processes the ask and sends a response back to alice
    const bobMessages = bobQueue.drain();
    expect(bobMessages.length).toBe(1);
    expect(bobMessages[0]!.type).toBe("ask");

    // Bob responds via Alice's /response endpoint
    await sendMeshMessage({
      from: "bob",
      to: "alice",
      peerUrl: config.peers["alice"]!.url,
      payload: "4",
      meshKey,
      type: "response",
      replyTo: askResult.messageId,
    });

    // Alice should get the response
    const response = await responsePromise;
    expect(response).toBe("4");
  });

  it("rejects messages with wrong mesh key", async () => {
    await expect(
      sendMeshMessage({
        from: "alice",
        to: "bob",
        peerUrl: config.peers["bob"]!.url,
        payload: "sneaky",
        meshKey: generateMeshKey(), // Wrong key
        type: "message",
      })
    ).rejects.toThrow("401");
  });

  it("multiple messages arrive in order", async () => {
    for (let i = 0; i < 5; i++) {
      await sendMeshMessage({
        from: "alice",
        to: "bob",
        peerUrl: config.peers["bob"]!.url,
        payload: `Message ${i}`,
        meshKey,
        type: "message",
      });
    }

    const messages = bobQueue.drain();
    expect(messages.length).toBe(5);
    expect(messages.map((m) => m.message)).toEqual([
      "Message 0",
      "Message 1",
      "Message 2",
      "Message 3",
      "Message 4",
    ]);
  });

});
