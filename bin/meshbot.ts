#!/usr/bin/env node

import { Command } from "commander";
import { execFileSync, spawn } from "node:child_process";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import { generateMeshKey } from "../src/security/keys.js";
import {
  loadConfig,
  saveConfig,
  loadMeshKey,
  saveMeshKey,
  meshExists,
  createDefaultConfig,
  addPeer,
  removePeer,
} from "../src/config/loader.js";
import { checkPeerHealth, sendMeshMessage } from "../src/client/mesh-client.js";

const program = new Command();

program
  .name("meshbot")
  .description("Cross-server Claude Code agent communication")
  .version("0.1.0");

// ─── meshbot init <mesh-name> ───
program
  .command("init <meshName>")
  .description("Create a new mesh and generate shared key")
  .action((meshName: string) => {
    if (meshExists(meshName)) {
      console.error(`Mesh "${meshName}" already exists.`);
      process.exit(1);
    }

    const key = generateMeshKey();
    saveMeshKey(meshName, key);
    const config = createDefaultConfig(meshName);
    saveConfig(config);

    console.log(`Mesh "${meshName}" created.`);
    console.log(`Config: ~/.mesh/${meshName}/config.json`);
    console.log(`Key:    ~/.mesh/${meshName}/mesh.key`);
    console.log(
      `\nStart an agent: meshbot start --as <name> --mesh ${meshName}`
    );
    console.log(
      `Agents auto-register when they start. For remote servers, use: meshbot add-peer <name> <url>`
    );
  });

// ─── meshbot add-peer <name> <url> ───
program
  .command("add-peer <name> <url>")
  .description("Add a peer agent to the mesh config")
  .option("-m, --mesh <meshName>", "Mesh name", "default")
  .option("-d, --description <desc>", "Agent description")
  .action((name: string, url: string, opts: { mesh: string; description?: string }) => {
    const config = loadConfig(opts.mesh);
    const updated = addPeer(config, name, url, opts.description);
    saveConfig(updated);
    console.log(`Added peer "${name}" (${url}) to mesh "${opts.mesh}".`);
  });

// ─── meshbot remove-peer <name> ───
program
  .command("remove-peer <name>")
  .description("Remove a peer agent from the mesh config")
  .option("-m, --mesh <meshName>", "Mesh name", "default")
  .action((name: string, opts: { mesh: string }) => {
    const config = loadConfig(opts.mesh);
    if (!config.peers[name]) {
      console.error(`Peer "${name}" not found in mesh "${opts.mesh}".`);
      process.exit(1);
    }
    const updated = removePeer(config, name);
    saveConfig(updated);
    console.log(`Removed peer "${name}" from mesh "${opts.mesh}".`);
  });

// ─── meshbot status ───
program
  .command("status")
  .description("Show status of all peers in the mesh")
  .option("-m, --mesh <meshName>", "Mesh name", "default")
  .action(async (opts: { mesh: string }) => {
    const config = loadConfig(opts.mesh);
    console.log(`Mesh: ${config.mesh}`);
    console.log(`Peers:`);

    const peers = Object.entries(config.peers);
    if (peers.length === 0) {
      console.log("  (none configured)");
      return;
    }

    const results = await Promise.all(
      peers.map(async ([name, peer]) => {
        const health = await checkPeerHealth(peer.url);
        return { name, peer, health };
      })
    );

    for (const { name, peer, health } of results) {
      const status = health.online ? "online" : "offline";
      const desc = peer.description ? ` - ${peer.description}` : "";
      console.log(`  ${name.padEnd(20)} ${peer.url.padEnd(35)} ${status}${desc}`);
    }
  });

// ─── meshbot send <to> <message> ───
program
  .command("send <to> <message>")
  .description("Send a manual message to an agent (for testing)")
  .option("-m, --mesh <meshName>", "Mesh name", "default")
  .option("-f, --from <name>", "Sender name", "cli")
  .action(
    async (
      to: string,
      message: string,
      opts: { mesh: string; from: string }
    ) => {
      const config = loadConfig(opts.mesh);
      const meshKey = loadMeshKey(opts.mesh);
      const peer = config.peers[to];

      if (!peer) {
        console.error(
          `Unknown agent "${to}". Known peers: ${Object.keys(config.peers).join(", ")}`
        );
        process.exit(1);
      }

      try {
        const result = await sendMeshMessage({
          from: opts.from,
          to,
          peerUrl: peer.url,
          payload: message,
          meshKey,
          type: "message",
        });
        console.log(`Message sent to "${to}" (${result.messageId})`);
      } catch (err) {
        console.error(`Failed to send: ${String(err)}`);
        process.exit(1);
      }
    }
  );

// ─── meshbot export-key ───
program
  .command("export-key")
  .description("Print the mesh key to stdout")
  .option("-m, --mesh <meshName>", "Mesh name", "default")
  .action((opts: { mesh: string }) => {
    const key = loadMeshKey(opts.mesh);
    console.log(key);
  });

// ─── meshbot serve ───
// MCP stdio server — called by claude as a subprocess
program
  .command("serve")
  .description("Start the mesh MCP server (used by Claude Code as a subprocess)")
  .requiredOption("--as <name>", "Agent name for this instance")
  .option("-m, --mesh <meshName>", "Mesh name", "default")
  .option("-p, --port <port>", "HTTP listener port (0 = auto-assign)", "0")
  .option("--host <host>", "HTTP listener host", "0.0.0.0")
  .option("--no-register", "Skip auto-registration (for ephemeral subprocesses)")
  .action(
    async (opts: {
      as: string;
      mesh: string;
      port: string;
      host: string;
      register: boolean;
    }) => {
      // Auto-detect: use HTTPS only if TLS is configured in the mesh config
      const meshConfig = loadConfig(opts.mesh);
      const useTls = Boolean(meshConfig.tls);

      const { startMcpServer } = await import("../src/mcp/server.js");
      await startMcpServer({
        agentName: opts.as,
        meshName: opts.mesh,
        port: parseInt(opts.port, 10),
        host: opts.host,
        dev: !useTls,
        noRegister: !opts.register,
      });
    }
  );

// ─── helpers for building MCP config and claude args ───

function resolveServeCommand(serveArgs: string[]): { command: string; args: string[] } {
  const meshbotBin = process.argv[1];
  if (meshbotBin && meshbotBin.endsWith(".js")) {
    return { command: "node", args: [meshbotBin, ...serveArgs] };
  }
  return { command: "meshbot", args: serveArgs };
}

function buildMcpConfig(serveCmd: { command: string; args: string[] }): string {
  return JSON.stringify({
    mcpServers: {
      mesh: {
        command: serveCmd.command,
        args: serveCmd.args,
      },
    },
  });
}

function buildSystemPrompt(agentName: string, peerList: string): string {
  return [
    `You are agent "${agentName}" in a mesh network.`,
    `You can communicate with other agents using the mesh MCP tools: list_agents, send_message, ask_agent, reply, get_agent_status, broadcast, check_messages.`,
    `Your mesh peers: ${peerList}.`,
    `When you see pending messages in a tool response, process them immediately. Always call check_messages when prompted to handle incoming messages.`,
  ].join(" ");
}

function getPeerList(config: ReturnType<typeof loadConfig>, agentName: string): string {
  return Object.entries(config.peers)
    .filter(([n]) => n !== agentName)
    .map(([name, p]) => `${name} (${p.description ?? "no description"})`)
    .join(", ") || "none yet — start other agents and they'll auto-register";
}

// ─── helper: collect Claude Code passthrough flags ───

function collectClaudePassthroughArgs(opts: {
  dangerouslySkipPermissions?: boolean;
  model?: string;
  permissionMode?: string;
  maxTurns?: string;
  verbose?: boolean;
  allowedTools?: string[];
}): string[] {
  const args: string[] = [];
  if (opts.dangerouslySkipPermissions) args.push("--dangerously-skip-permissions");
  if (opts.model) args.push("--model", opts.model);
  if (opts.permissionMode) args.push("--permission-mode", opts.permissionMode);
  if (opts.maxTurns) args.push("--max-turns", opts.maxTurns);
  if (opts.verbose) args.push("--verbose");
  if (opts.allowedTools && opts.allowedTools.length > 0) args.push("--allowedTools", ...opts.allowedTools);
  return args;
}

// ─── meshbot start (the main user-facing command) ───
program
  .command("start", { isDefault: true })
  .description("Launch Claude Code with mesh networking tools")
  .requiredOption("--as <name>", "Agent name for this instance")
  .option("-m, --mesh <meshName>", "Mesh name", "default")
  .option("-p, --port <port>", "HTTP listener port (0 = auto-assign)", "0")
  .option("--host <host>", "HTTP listener host", "0.0.0.0")
  .option("--daemon", "Run as autonomous daemon — auto-processes incoming messages without user interaction", false)
  .option("--poll-interval <seconds>", "Daemon poll interval in seconds", "3")
  // Claude Code passthrough flags
  .option("--dangerously-skip-permissions", "Pass --dangerously-skip-permissions to Claude Code")
  .option("--model <model>", "Pass --model to Claude Code")
  .option("--permission-mode <mode>", "Pass --permission-mode to Claude Code")
  .option("--max-turns <n>", "Pass --max-turns to Claude Code")
  .option("--verbose", "Pass --verbose to Claude Code")
  .option("--allowedTools <tools...>", "Pass --allowedTools to Claude Code")
  .action(
    async (opts: {
      as: string;
      mesh: string;
      port: string;
      host: string;
      daemon: boolean;
      pollInterval: string;
      dangerouslySkipPermissions?: boolean;
      model?: string;
      permissionMode?: string;
      maxTurns?: string;
      verbose?: boolean;
      allowedTools?: string[];
    }) => {
      const config = loadConfig(opts.mesh);
      const peerList = getPeerList(config, opts.as);
      const serveArgs = ["serve", "--as", opts.as, "-m", opts.mesh, "-p", opts.port, "--host", opts.host];
      const serveCmd = resolveServeCommand(serveArgs);
      const systemPrompt = buildSystemPrompt(opts.as, peerList);

      if (opts.daemon) {
        // ── Daemon mode: start HTTP listener, auto-process incoming messages with headless claude ──
        const fs = await import("node:fs");

        // Build MCP config for the ephemeral `claude -p` subprocesses.
        // Use --no-register so they don't overwrite the primary agent's URL in config.
        const ephemeralServeArgs = [...serveArgs, "--no-register"];
        const ephemeralServeCmd = resolveServeCommand(ephemeralServeArgs);
        const mcpConfig = buildMcpConfig(ephemeralServeCmd);

        console.log(`Starting "${opts.as}" in daemon mode...`);

        // Start the primary serve subprocess (MCP server + HTTP listener).
        // This one DOES auto-register (no --no-register flag).
        let shuttingDown = false;

        function spawnServe() {
          const proc = spawn(serveCmd.command, serveCmd.args, {
            stdio: ["pipe", "pipe", "inherit"], // stdin/stdout piped (MCP), stderr to terminal
            env: process.env,
          });

          // Drain stdout to prevent pipe buffer exhaustion.
          // The MCP server writes notifications to stdout whenever HTTP messages arrive,
          // but in daemon mode nobody reads MCP output. If the pipe buffer fills (~64KB),
          // the serve process's event loop blocks — taking the HTTP server down with it.
          proc.stdout.resume();

          // Restart the serve process if it exits unexpectedly
          proc.on("exit", (code) => {
            if (shuttingDown) return;
            console.error(`[meshbot] Primary serve process exited (code ${String(code)}), restarting...`);
            serveProc = spawnServe();
          });

          return proc;
        }

        let serveProc = spawnServe();

        // Wait for the server to start and auto-register
        await new Promise<void>((resolve) => setTimeout(resolve, 2000));

        const freshConfig = loadConfig(opts.mesh);
        const self = freshConfig.peers[opts.as];
        console.log(`Agent "${opts.as}" listening at ${self?.url ?? "unknown"}`);
        console.log(`Daemon polling every ${opts.pollInterval}s for incoming messages...`);
        console.log(`Press Ctrl+C to stop.\n`);

        const queueFile = path.join(
          os.homedir(), ".mesh", opts.mesh, "queues", opts.as, "queue.json"
        );

        let processing = false;

        const pollAndProcess = () => {
          if (processing) return;

          // Read queue file
          let raw = "";
          try {
            raw = fs.readFileSync(queueFile, "utf-8");
          } catch {
            return;
          }

          let messages: { id: string; from: string; message: string; type: string }[] = [];
          try {
            messages = JSON.parse(raw) as typeof messages;
          } catch {
            return;
          }

          if (messages.length === 0) return;

          // Clear the queue file immediately to prevent re-processing
          try {
            fs.writeFileSync(queueFile, "[]");
          } catch {
            // best effort
          }

          processing = true;

          const msgSummary = messages.map((m) =>
            `[${m.type}] From ${m.from} (id: ${m.id}): ${m.message}`
          ).join("\n");

          const prompt = `You have received ${String(messages.length)} new message(s) from other agents:\n\n${msgSummary}\n\nProcess each message. For messages with type [ask], you MUST respond using the reply tool (passing the message id and the sender's name). For other messages, use send_message. If informational, acknowledge via send_message.`;

          console.log(`📨 Processing ${String(messages.length)} message(s)...`);

          // Spawn headless claude to process.
          // This spawns its own MCP serve subprocess (auto-assigns a port),
          // giving Claude access to send_message, list_agents, etc.
          try {
            execFileSync("claude", [
              "-p", prompt,
              "--mcp-config", mcpConfig,
              "--append-system-prompt", systemPrompt,
              ...collectClaudePassthroughArgs(opts),
            ], {
              stdio: "inherit",
              env: process.env,
              timeout: 120_000,
            });
            console.log(`✅ Done processing messages.\n`);
          } catch (err) {
            console.error(`Error processing messages: ${String(err)}\n`);
          }

          processing = false;
        };

        // Poll loop
        const intervalMs = parseInt(opts.pollInterval, 10) * 1000;
        const interval = setInterval(pollAndProcess, intervalMs);

        // Graceful shutdown
        const shutdown = () => {
          shuttingDown = true;
          console.log("\nShutting down daemon...");
          clearInterval(interval);
          serveProc.kill();
          process.exit(0);
        };
        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);

        // Keep process alive
        await new Promise(() => {});
      } else {
        // ── Interactive mode: launch the full Claude Code TUI ──
        // The serve subprocess launched via MCP config will auto-register normally.
        const mcpConfig = buildMcpConfig(serveCmd);

        // Resolve the hook script path for inbox notifications
        const thisFile = fileURLToPath(import.meta.url);
        const hookScript = path.resolve(path.dirname(thisFile), "..", "src", "hooks", "check-inbox.sh");
        const settingsJson = JSON.stringify({
          hooks: {
            UserPromptSubmit: [
              {
                hooks: [
                  { type: "command", command: hookScript, timeout: 5 },
                ],
              },
            ],
          },
        });
        const queueFile = path.join(
          os.homedir(), ".mesh", opts.mesh, "queues", opts.as, "queue.json"
        );

        const claudeArgs = [
          "--mcp-config", mcpConfig,
          "--append-system-prompt", systemPrompt,
          "--settings", settingsJson,
          ...collectClaudePassthroughArgs(opts),
        ];

        // Collect any extra args after `--` and pass to claude
        const rawArgs = process.argv;
        const dashDashIndex = rawArgs.indexOf("--");
        if (dashDashIndex !== -1) {
          claudeArgs.push(...rawArgs.slice(dashDashIndex + 1));
        }

        try {
          execFileSync("claude", claudeArgs, {
            stdio: "inherit",
            env: { ...process.env, MESHBOT_QUEUE_FILE: queueFile },
          });
        } catch (err: unknown) {
          const exitCode = (err as { status?: number }).status ?? 1;
          process.exit(exitCode);
        }
      }
    }
  );

program.parse();
