import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MessageQueue, type IncomingMessage } from "../src/queue/message-queue.js";

describe("MessageQueue", () => {
  it("enqueues and drains messages", () => {
    const queue = new MessageQueue();
    const msg: IncomingMessage = {
      id: "1",
      from: "alice",
      message: "hello",
      timestamp: Date.now(),
      type: "message",
    };

    queue.enqueue(msg);
    expect(queue.length).toBe(1);

    const drained = queue.drain();
    expect(drained.length).toBe(1);
    expect(drained[0]!.from).toBe("alice");
    expect(queue.length).toBe(0);
  });

  it("peek does not remove messages", () => {
    const queue = new MessageQueue();
    queue.enqueue({
      id: "1",
      from: "alice",
      message: "hello",
      timestamp: Date.now(),
      type: "message",
    });

    const peeked = queue.peek();
    expect(peeked.length).toBe(1);
    expect(queue.length).toBe(1); // Still there
  });

  it("maintains FIFO order", () => {
    const queue = new MessageQueue();
    queue.enqueue({ id: "1", from: "a", message: "first", timestamp: 1, type: "message" });
    queue.enqueue({ id: "2", from: "b", message: "second", timestamp: 2, type: "message" });
    queue.enqueue({ id: "3", from: "c", message: "third", timestamp: 3, type: "message" });

    const drained = queue.drain();
    expect(drained.map((m) => m.message)).toEqual(["first", "second", "third"]);
  });

  describe("ask/response flow", () => {
    it("resolves pending ask", async () => {
      const queue = new MessageQueue();
      const askPromise = queue.registerAsk("msg-1", 5000);

      // Simulate response arriving
      const resolved = queue.resolveAsk("msg-1", "the answer is 4");
      expect(resolved).toBe(true);

      const response = await askPromise;
      expect(response).toBe("the answer is 4");
    });

    it("times out pending ask", async () => {
      const queue = new MessageQueue();
      const askPromise = queue.registerAsk("msg-1", 100); // 100ms timeout

      await expect(askPromise).rejects.toThrow("timed out");
    });

    it("returns false for unknown reply", () => {
      const queue = new MessageQueue();
      expect(queue.resolveAsk("unknown", "response")).toBe(false);
    });

    it("tracks pending asks", async () => {
      const queue = new MessageQueue();
      const askPromise = queue.registerAsk("msg-1", 5000);
      expect(queue.hasPendingAsk("msg-1")).toBe(true);
      expect(queue.hasPendingAsk("msg-2")).toBe(false);
      queue.destroy(); // Cleanup
      // Catch the expected rejection from destroy
      await expect(askPromise).rejects.toThrow("Queue destroyed");
    });
  });

  describe("disk persistence", () => {
    const testDir = path.join(os.tmpdir(), `mesh-queue-test-${Date.now()}`);

    afterEach(() => {
      if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true });
      }
    });

    it("persists messages to disk", () => {
      const queue1 = new MessageQueue(testDir);
      queue1.enqueue({
        id: "1",
        from: "alice",
        message: "persistent",
        timestamp: Date.now(),
        type: "message",
      });

      // Load a new queue from the same dir
      const queue2 = new MessageQueue(testDir);
      expect(queue2.length).toBe(1);
      const drained = queue2.drain();
      expect(drained[0]!.message).toBe("persistent");
    });

    it("clears disk after drain", () => {
      const queue = new MessageQueue(testDir);
      queue.enqueue({
        id: "1",
        from: "alice",
        message: "temp",
        timestamp: Date.now(),
        type: "message",
      });
      queue.drain();

      const queue2 = new MessageQueue(testDir);
      expect(queue2.length).toBe(0);
    });
  });
});
