import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { startHttpServer } from "../server/http-server.js";
import { MessageQueue } from "../queue/message-queue.js";
import { sendMeshMessage, checkPeerHealth } from "../client/mesh-client.js";
import { loadConfig, loadMeshKey, addPeer, saveConfig } from "../config/loader.js";
import * as os from "node:os";
import * as path from "node:path";

export interface ServeOptions {
  agentName: string;
  meshName: string;
  port: number;
  host: string;
  dev: boolean;
  noRegister?: boolean;
}

function log(msg: string): void {
  process.stderr.write(`[meshbot] ${msg}\n`);
}

export async function startMcpServer(opts: ServeOptions): Promise<void> {
  const config = loadConfig(opts.meshName);
  const meshKey = loadMeshKey(opts.meshName);
  const protocol = opts.dev ? "http" : "https";

  // Set up message queue with disk persistence
  const queueDir = path.join(
    os.homedir(),
    ".mesh",
    opts.meshName,
    "queues",
    opts.agentName
  );
  const queue = new MessageQueue(queueDir);

  // Create MCP server early so we can send notifications from HTTP callbacks
  const server = new McpServer(
    { name: "mesh", version: "0.1.0" },
    { capabilities: { tools: {}, logging: {} } }
  );

  // Start HTTP server for receiving messages from remote peers.
  // Port 0 means the OS picks a free port automatically.
  let httpServer;
  try {
    httpServer = await startHttpServer({
      agentName: opts.agentName,
      meshName: opts.meshName,
      port: opts.port,
      host: opts.host,
      meshKey,
      queue,
      replayWindowSeconds: config.security.replayWindowSeconds,
      maxMessageSizeBytes: config.security.maxMessageSizeBytes,
      tls: config.tls,
      dev: opts.dev,
      onMessageReceived: (fromAgent, _messageId, payload) => {
        const preview = payload.length > 200 ? payload.substring(0, 200) + "..." : payload;
        log(`📨 Message from ${fromAgent}: ${preview}`);
        if (server.isConnected()) {
          void server.sendLoggingMessage({
            level: "info",
            data: `New message from agent "${fromAgent}": ${preview}. Use check_messages to read it.`,
          });
        }
      },
      onAskReceived: (fromAgent, _messageId, payload) => {
        const preview = payload.length > 200 ? payload.substring(0, 200) + "..." : payload;
        log(`❓ Ask from ${fromAgent}: ${preview}`);
        if (server.isConnected()) {
          void server.sendLoggingMessage({
            level: "info",
            data: `New question from agent "${fromAgent}": ${preview}. Use check_messages to read and respond.`,
          });
        }
      },
    });
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code === "EADDRINUSE") {
      log(`ERROR: Port ${String(opts.port)} is already in use. Is another agent already running on this port?`);
      log(`Try a different port: meshbot start --as ${opts.agentName} --port ${String(opts.port + 1)}`);
    } else {
      log(`ERROR: Failed to start HTTP server: ${String(err)}`);
    }
    process.exit(1);
  }

  // Now we know the actual port (important when port was 0 / auto-assigned)
  const actualPort = httpServer.port;
  const hostForUrl = opts.host === "0.0.0.0" ? "localhost" : opts.host;
  const selfUrl = `${protocol}://${hostForUrl}:${String(actualPort)}`;

  // Auto-register this agent in the config so other agents can discover it.
  // Skip registration when --no-register is set (e.g. ephemeral daemon subprocesses)
  // to avoid overwriting the primary agent's registered URL.
  if (!opts.noRegister) {
    // Re-read config from disk to avoid overwriting peers that registered after
    // this process started (TOCTOU race between concurrent agent startups).
    const latestConfig = loadConfig(opts.meshName);
    const existingPeer = latestConfig.peers[opts.agentName];
    if (!existingPeer || existingPeer.url !== selfUrl) {
      const updated = addPeer(latestConfig, opts.agentName, selfUrl);
      saveConfig(updated);
      log(`Auto-registered "${opts.agentName}" at ${selfUrl}`);
    }
  } else {
    log(`Skipping auto-registration (--no-register)`);
  }

  log(
    `Agent "${opts.agentName}" listening on ${protocol}://${opts.host}:${String(actualPort)}`
  );
  log(`Mesh: ${opts.meshName}`);
  const freshPeers = loadConfig(opts.meshName);
  log(
    `Peers: ${Object.keys(freshPeers.peers).filter((n) => n !== opts.agentName).join(", ") || "none"}`
  );

  // Helper: reload config from disk to pick up newly registered peers
  function freshConfig() {
    return loadConfig(opts.meshName);
  }

  // Helper to get peer URL (always reads fresh config)
  function getPeerUrl(name: string): string {
    const latest = freshConfig();
    const peer = latest.peers[name];
    if (!peer) {
      throw new Error(
        `Unknown agent "${name}". Known peers: ${Object.keys(latest.peers).join(", ")}`
      );
    }
    return peer.url;
  }

  // Helper: drain pending messages and append to any tool response.
  // This ensures Claude sees incoming messages on every tool call,
  // not just when check_messages is explicitly called.
  type ToolContent = { type: "text"; text: string };
  function withPendingMessages(content: ToolContent[]): ToolContent[] {
    const pending = queue.drain();
    if (pending.length === 0) return content;
    const inboxText = JSON.stringify({
      _inbox: `You have ${String(pending.length)} new message(s). Read and process them:`,
      messages: pending,
    });
    return [...content, { type: "text", text: inboxText }];
  }

  // ── list_agents ──
  server.registerTool(
    "list_agents",
    { description: "List all known peer agents in the mesh and check their online status. Also delivers any pending incoming messages." },
    async () => {
      const latest = freshConfig();
      const results = await Promise.all(
        Object.entries(latest.peers)
          .filter(([name]) => name !== opts.agentName)
          .map(async ([name, peer]) => {
            const health = await checkPeerHealth(peer.url);
            return {
              name,
              url: peer.url,
              description: peer.description ?? "",
              status: health.online ? "online" : "offline",
            };
          })
      );

      return {
        content: withPendingMessages([{ type: "text", text: JSON.stringify(results, null, 2) }]),
      };
    }
  );

  // ── send_message ──
  server.registerTool(
    "send_message",
    {
      description: "Send a fire-and-forget message to another agent. Use for notifications or when you don't need a reply.",
      inputSchema: {
        to: z.string().describe("Name of the target agent"),
        message: z.string().describe("The message content to send"),
      },
    },
    async ({ to, message }) => {
      const peerUrl = getPeerUrl(to);
      try {
        const result = await sendMeshMessage({
          from: opts.agentName,
          to,
          peerUrl,
          payload: message,
          meshKey,
          type: "message",
        });

        return {
          content: withPendingMessages([
            {
              type: "text",
              text: JSON.stringify({
                delivered: result.success,
                messageId: result.messageId,
                to,
              }),
            },
          ]),
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                delivered: false,
                to,
                error: err instanceof Error ? err.message : String(err),
                peerUrl,
                hint: `Agent "${to}" appears to be offline or unreachable at ${peerUrl}. Make sure it is running with: meshbot start --as ${to}`,
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ── ask_agent ──
  server.registerTool(
    "ask_agent",
    {
      description: "Send a message and wait for a response. Use when you need information back from another agent.",
      inputSchema: {
        to: z.string().describe("Name of the target agent"),
        message: z.string().describe("The question or request to send"),
        timeoutSeconds: z
          .number()
          .optional()
          .default(120)
          .describe("How long to wait for a response (default: 120s)"),
      },
    },
    async ({ to, message, timeoutSeconds }) => {
      const peerUrl = getPeerUrl(to);
      let result;
      try {
        result = await sendMeshMessage({
          from: opts.agentName,
          to,
          peerUrl,
          payload: message,
          meshKey,
          type: "ask",
        });
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: err instanceof Error ? err.message : String(err),
                to,
                peerUrl,
                hint: `Agent "${to}" appears to be offline or unreachable at ${peerUrl}. Make sure it is running with: meshbot start --as ${to}`,
              }),
            },
          ],
          isError: true,
        };
      }

      try {
        const response = await queue.registerAsk(
          result.messageId,
          timeoutSeconds * 1000
        );
        return {
          content: withPendingMessages([
            {
              type: "text",
              text: JSON.stringify({
                response,
                fromAgent: to,
                messageId: result.messageId,
              }),
            },
          ]),
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error:
                  err instanceof Error ? err.message : "Unknown error",
                messageId: result.messageId,
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ── reply ──
  server.registerTool(
    "reply",
    {
      description:
        "Reply to an [ask] message from another agent. " +
        "Use this when you received a message with type [ask] and need to send the answer back. " +
        "The asking agent is blocked waiting for this response.",
      inputSchema: {
        to: z.string().describe("Name of the agent who asked the question"),
        messageId: z
          .string()
          .describe("The id of the original ask message you are replying to"),
        message: z.string().describe("Your response to the question"),
      },
    },
    async ({ to, messageId, message }) => {
      const peerUrl = getPeerUrl(to);
      try {
        await sendMeshMessage({
          from: opts.agentName,
          to,
          peerUrl,
          payload: message,
          meshKey,
          type: "response",
          replyTo: messageId,
        });

        return {
          content: withPendingMessages([
            {
              type: "text",
              text: JSON.stringify({
                replied: true,
                to,
                messageId,
              }),
            },
          ]),
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                replied: false,
                to,
                error: err instanceof Error ? err.message : String(err),
                peerUrl,
                hint: `Agent "${to}" appears to be offline or unreachable at ${peerUrl}. Make sure it is running with: meshbot start --as ${to}`,
              }),
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ── get_agent_status ──
  server.registerTool(
    "get_agent_status",
    {
      description: "Check if a specific agent is online and get its metadata",
      inputSchema: {
        name: z.string().describe("Name of the agent to check"),
      },
    },
    async ({ name }) => {
      const latest = freshConfig();
      const peer = latest.peers[name];
      if (!peer) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: `Unknown agent "${name}"`,
                known: Object.keys(latest.peers),
              }),
            },
          ],
          isError: true,
        };
      }

      const health = await checkPeerHealth(peer.url);
      return {
        content: withPendingMessages([
          {
            type: "text",
            text: JSON.stringify({
              name,
              online: health.online,
              description: peer.description ?? "",
              url: peer.url,
            }),
          },
        ]),
      };
    }
  );

  // ── broadcast ──
  server.registerTool(
    "broadcast",
    {
      description: "Send a message to all peer agents. Use for announcements.",
      inputSchema: {
        message: z.string().describe("The message to broadcast"),
        exclude: z
          .array(z.string())
          .optional()
          .describe("Agent names to exclude"),
      },
    },
    async ({ message, exclude }) => {
      const latest = freshConfig();
      const excludeSet = new Set(exclude ?? []);
      excludeSet.add(opts.agentName);

      const results = await Promise.all(
        Object.entries(latest.peers)
          .filter(([name]) => !excludeSet.has(name))
          .map(async ([name, peer]) => {
            try {
              await sendMeshMessage({
                from: opts.agentName,
                to: name,
                peerUrl: peer.url,
                payload: message,
                meshKey,
                type: "message",
              });
              return { name, delivered: true };
            } catch {
              return { name, delivered: false };
            }
          })
      );

      return {
        content: withPendingMessages([{ type: "text", text: JSON.stringify({ results }) }]),
      };
    }
  );

  // ── check_messages ──
  server.registerTool(
    "check_messages",
    { description: "Check for and retrieve any incoming messages from other agents. Returns all queued messages and clears the queue." },
    () => {
      const messages = queue.drain();
      return {
        content: [
          {
            type: "text",
            text:
              messages.length === 0
                ? JSON.stringify({ messages: [], note: "No new messages" })
                : JSON.stringify({ messages }),
          },
        ],
      };
    }
  );

  // Connect MCP server to stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  log("MCP server connected via stdio");

  // Handle graceful shutdown
  const shutdown = () => {
    log("Shutting down...");
    queue.destroy();
    void httpServer.close();
    void server.close();
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
