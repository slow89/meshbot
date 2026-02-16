import * as fs from "node:fs";
import * as path from "node:path";

export interface MeshMessage {
  id: string;
  from: string;
  to: string;
  type: "message" | "ask" | "response";
  payload: string;
  replyTo?: string;
  timestamp: number;
  nonce: string;
  hmac: string;
}

export type IncomingMessage = {
  id: string;
  from: string;
  message: string;
  timestamp: number;
  type: "message" | "ask";
  replyTo?: string;
};

/**
 * In-memory message queue with optional disk persistence.
 * Stores incoming messages until the Claude session picks them up.
 */
export class MessageQueue {
  private queue: IncomingMessage[] = [];
  private persistPath: string | null;
  private pendingAsks = new Map<
    string,
    {
      resolve: (response: string) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(persistDir?: string) {
    if (persistDir) {
      fs.mkdirSync(persistDir, { recursive: true });
      this.persistPath = path.join(persistDir, "queue.json");
      this.loadFromDisk();
    } else {
      this.persistPath = null;
    }
  }

  enqueue(msg: IncomingMessage): void {
    this.queue.push(msg);
    this.saveToDisk();
  }

  /**
   * Returns and removes all queued messages.
   */
  drain(): IncomingMessage[] {
    const messages = [...this.queue];
    this.queue = [];
    this.saveToDisk();
    return messages;
  }

  /**
   * Returns queued messages without removing them.
   */
  peek(): IncomingMessage[] {
    return [...this.queue];
  }

  get length(): number {
    return this.queue.length;
  }

  /**
   * Register a pending ask that will be resolved when a response arrives.
   */
  registerAsk(
    messageId: string,
    timeoutMs: number
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAsks.delete(messageId);
        reject(new Error(`Ask timed out after ${String(timeoutMs)}ms`));
      }, timeoutMs);

      this.pendingAsks.set(messageId, { resolve, reject, timer });
    });
  }

  /**
   * Resolve a pending ask with a response.
   * Returns true if the ask was found and resolved.
   */
  resolveAsk(replyTo: string, response: string): boolean {
    const pending = this.pendingAsks.get(replyTo);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pendingAsks.delete(replyTo);
    pending.resolve(response);
    return true;
  }

  hasPendingAsk(messageId: string): boolean {
    return this.pendingAsks.has(messageId);
  }

  destroy(): void {
    for (const [, pending] of this.pendingAsks) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Queue destroyed"));
    }
    this.pendingAsks.clear();
  }

  private loadFromDisk(): void {
    if (!this.persistPath || !fs.existsSync(this.persistPath)) return;
    try {
      const raw = fs.readFileSync(this.persistPath, "utf-8");
      this.queue = JSON.parse(raw) as IncomingMessage[];
    } catch {
      this.queue = [];
    }
  }

  private saveToDisk(): void {
    if (!this.persistPath) return;
    try {
      fs.writeFileSync(this.persistPath, JSON.stringify(this.queue));
    } catch {
      // Best effort persistence
    }
  }
}
