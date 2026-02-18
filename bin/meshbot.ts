#!/usr/bin/env node

import { Command } from "commander";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { createInterface, type Interface as ReadlineInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { generateEnrollmentKeyPair, generateMeshKey } from "../src/security/keys.js";
import {
  loadConfig,
  saveConfig,
  loadMeshKey,
  saveMeshKey,
  meshExists,
  createDefaultConfig,
  addPeer,
  removePeer,
  loadRootPrivateKey,
  loadRootPublicKey,
  saveRootPublicKey,
  saveNodePrivateKey,
  saveNodePublicKey,
  loadNodePublicKey,
  getNodePublicKeyPath,
  saveManifest,
  loadManifest,
  getRootPublicKeyPath,
} from "../src/config/loader.js";
import {
  checkPeerHealth,
  sendMeshMessage,
  joinMeshBootstrap,
  fetchBootstrapHead,
  fetchBootstrapManifest,
  normalizePeerUrl,
} from "../src/client/mesh-client.js";
import {
  manifestToConfig,
  setupBootstrapArtifacts,
  updateSignedManifest,
} from "../src/bootstrap/setup.js";
import {
  createInviteToken,
  parseDurationToMs,
  verifyInviteToken,
} from "../src/bootstrap/invite.js";
import type { InviteTokenPayload, ManifestPayload } from "../src/config/types.js";
import {
  parseEnvelopePayload,
  verifyEnvelopeEd25519,
} from "../src/security/signing.js";

const program = new Command();

program
  .name("meshbot")
  .description("Cross-server Claude Code agent communication")
  .version("0.1.0");

interface DaemonPidRecord {
  pid: number;
  mesh: string;
  agent: string;
  startedAt: number;
  port: string;
  host: string;
}

function getDaemonPidPath(meshName: string, agentName: string): string {
  return path.join(os.homedir(), ".mesh", meshName, "daemons", `${agentName}.pid`);
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readDaemonPidRecord(meshName: string, agentName: string): DaemonPidRecord | undefined {
  const pidPath = getDaemonPidPath(meshName, agentName);
  if (!fs.existsSync(pidPath)) return undefined;

  try {
    const raw = fs.readFileSync(pidPath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<DaemonPidRecord>;
    if (
      typeof parsed.pid !== "number" ||
      typeof parsed.mesh !== "string" ||
      typeof parsed.agent !== "string"
    ) {
      return undefined;
    }
    return {
      pid: parsed.pid,
      mesh: parsed.mesh,
      agent: parsed.agent,
      startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : 0,
      port: typeof parsed.port === "string" ? parsed.port : "0",
      host: typeof parsed.host === "string" ? parsed.host : "0.0.0.0",
    };
  } catch {
    return undefined;
  }
}

function writeDaemonPidRecord(record: DaemonPidRecord): void {
  const pidPath = getDaemonPidPath(record.mesh, record.agent);
  fs.mkdirSync(path.dirname(pidPath), { recursive: true });
  fs.writeFileSync(pidPath, JSON.stringify(record, null, 2) + "\n");
}

function removeDaemonPidFile(meshName: string, agentName: string): void {
  const pidPath = getDaemonPidPath(meshName, agentName);
  if (!fs.existsSync(pidPath)) return;
  try {
    fs.unlinkSync(pidPath);
  } catch {
    // best effort cleanup
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) {
      return true;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  return !isProcessRunning(pid);
}

function maybeUpdateManifestAfterConfigChange(meshName: string): void {
  try {
    const config = loadConfig(meshName);
    const meshKey = loadMeshKey(meshName);
    const result = updateSignedManifest(config, meshKey);
    console.log(`Updated signed manifest: ${result.path} (v${String(result.version)})`);
  } catch {
    // Bootstrap artifacts are optional; legacy meshes may not have signing keys yet.
  }
}

function expandHomePath(inputPath: string): string {
  if (inputPath === "~") return os.homedir();
  if (inputPath.startsWith("~/")) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  return inputPath;
}

function unwrapQuotedValue(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function sanitizeInviteToken(value: string): string {
  return unwrapQuotedValue(value).replace(/\s+/g, "");
}

function ensureBootstrapArtifacts(meshName: string): { createdRootKeys: boolean; createdManifest: boolean } {
  const config = loadConfig(meshName);
  const meshKey = loadMeshKey(meshName);

  let createdRootKeys = false;
  try {
    loadRootPrivateKey(meshName);
    loadRootPublicKey(meshName);
  } catch {
    setupBootstrapArtifacts(config, meshKey);
    createdRootKeys = true;
  }

  let createdManifest = false;
  try {
    loadManifest(meshName);
  } catch {
    updateSignedManifest(config, meshKey);
    createdManifest = true;
  }

  return { createdRootKeys, createdManifest };
}

function detectDefaultSeedAddress(port: string): string {
  const interfaces = os.networkInterfaces();
  for (const addresses of Object.values(interfaces)) {
    if (!addresses) continue;
    for (const addr of addresses) {
      if (addr.family === "IPv4" && !addr.internal) {
        return `${addr.address}:${port}`;
      }
    }
  }
  return `127.0.0.1:${port}`;
}

function parsePortFromUrlOrHost(value: string): string | undefined {
  try {
    const normalized = normalizePeerUrl(value);
    const parsed = new URL(normalized);
    if (parsed.port) return parsed.port;
  } catch {
    // ignore parse failures and fall back to defaults
  }
  return undefined;
}

function createPromptInterface(): ReadlineInterface {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("This command requires an interactive terminal.");
  }
  return createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

async function promptText(
  rl: ReadlineInterface,
  label: string,
  defaultValue?: string
): Promise<string> {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  const answer = (await rl.question(`${label}${suffix}: `)).trim();
  if (answer.length === 0 && defaultValue !== undefined) return defaultValue;
  return answer;
}

async function promptRequiredText(
  rl: ReadlineInterface,
  label: string,
  defaultValue?: string
): Promise<string> {
  while (true) {
    const value = await promptText(rl, label, defaultValue);
    if (value.trim().length > 0) return value.trim();
    console.log("Value cannot be empty.");
  }
}

async function promptYesNo(
  rl: ReadlineInterface,
  label: string,
  defaultYes: boolean
): Promise<boolean> {
  const hint = defaultYes ? "Y/n" : "y/N";
  const answer = (await rl.question(`${label} [${hint}]: `)).trim().toLowerCase();
  if (answer.length === 0) return defaultYes;
  return answer === "y" || answer === "yes";
}

function resolveSelfCommand(runArgs: string[]): { command: string; args: string[] } {
  const entrypoint = process.argv[1];
  if (!entrypoint) {
    return { command: "meshbot", args: runArgs };
  }
  if (entrypoint.endsWith(".js")) {
    return { command: "node", args: [entrypoint, ...runArgs] };
  }
  if (entrypoint.endsWith(".ts")) {
    return { command: "pnpm", args: ["tsx", entrypoint, ...runArgs] };
  }
  return { command: "meshbot", args: runArgs };
}

function startDetachedMeshbot(args: string[]): void {
  const cmd = resolveSelfCommand(args);
  const child = spawn(cmd.command, cmd.args, {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
}

function shellQuote(value: string): string {
  if (value.length === 0) return "''";
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function tryCopyToClipboard(text: string): { ok: boolean; method?: string } {
  const attempts: Array<{ command: string; args?: string[] }> = [];
  if (process.platform === "darwin") {
    attempts.push({ command: "pbcopy" });
  } else if (process.platform === "win32") {
    attempts.push({ command: "clip" });
  } else {
    attempts.push(
      { command: "wl-copy" },
      { command: "xclip", args: ["-selection", "clipboard"] },
      { command: "xsel", args: ["--clipboard", "--input"] }
    );
  }

  for (const attempt of attempts) {
    const result = spawnSync(attempt.command, attempt.args ?? [], {
      input: text,
      encoding: "utf-8",
    });
    if (!result.error && result.status === 0) {
      return { ok: true, method: attempt.command };
    }
  }

  return { ok: false };
}

interface JoinOptions {
  as: string;
  seed?: string;
  invite: string;
  rootPub: string;
  mesh: string;
}

async function performJoin(opts: JoinOptions): Promise<void> {
  const nodePubKey = loadNodePublicKey(opts.mesh);
  const rootPubPath = expandHomePath(opts.rootPub);
  const rootPublicKeyPem = fs.readFileSync(rootPubPath, "utf-8").trim();
  if (!rootPublicKeyPem.includes("BEGIN PUBLIC KEY")) {
    throw new Error(
      `--root-pub must point to the mesh root public key PEM (root.pub), not node.pub`
    );
  }

  const inviteToken = sanitizeInviteToken(opts.invite);
  const inviteVerification = verifyInviteToken(inviteToken, rootPublicKeyPem);
  if (!inviteVerification.ok || !inviteVerification.payload) {
    throw new Error(`Invalid invite token: ${inviteVerification.error ?? "verification failed"}`);
  }
  if (inviteVerification.payload.mesh !== opts.mesh) {
    throw new Error(
      `Invite mesh mismatch: expected "${opts.mesh}" got "${inviteVerification.payload.mesh}"`
    );
  }

  const seedCandidates = opts.seed
    ? [normalizePeerUrl(opts.seed)]
    : (inviteVerification.payload.seedHints ?? []).map((seed) => normalizePeerUrl(seed));
  if (seedCandidates.length === 0) {
    throw new Error(
      "No seed URL provided. Pass --seed or create an invite with seed hints."
    );
  }

  let joinResponse: Awaited<ReturnType<typeof joinMeshBootstrap>> | undefined;
  let selectedSeed: string | undefined;
  const joinErrors: string[] = [];
  for (const candidate of [...new Set(seedCandidates)]) {
    try {
      joinResponse = await joinMeshBootstrap(
        candidate,
        inviteToken,
        nodePubKey
      );
      selectedSeed = candidate;
      break;
    } catch (err) {
      joinErrors.push(`${candidate}: ${String(err)}`);
    }
  }

  if (!joinResponse || !selectedSeed) {
    throw new Error(`Failed to join using all seed candidates. ${joinErrors.join(" | ")}`);
  }
  if (!opts.seed) {
    console.log(`Using seed from invite token: ${selectedSeed}`);
  }
  const manifestEnvelope = joinResponse.manifest;

  const verified = verifyEnvelopeEd25519(manifestEnvelope, rootPublicKeyPem);
  if (!verified) {
    throw new Error("Manifest signature verification failed");
  }

  const manifestPayload = parseEnvelopePayload(manifestEnvelope) as ManifestPayload;
  if (manifestPayload.mesh !== opts.mesh) {
    throw new Error(
      `Manifest mesh mismatch: expected "${opts.mesh}" got "${manifestPayload.mesh}"`
    );
  }
  if (!manifestPayload.agents[opts.as]) {
    console.error(
      `Warning: agent "${opts.as}" is not listed in manifest peers yet.`
    );
  }

  saveRootPublicKey(opts.mesh, rootPublicKeyPem);
  saveManifest(opts.mesh, manifestEnvelope);
  saveMeshKey(opts.mesh, manifestPayload.transport.meshKey);
  saveConfig(manifestToConfig(manifestPayload));

  console.log(`Joined mesh "${opts.mesh}" from seed ${selectedSeed}.`);
  console.log(`Manifest version: ${String(manifestPayload.version)}`);
  console.log(`Saved config: ~/.mesh/${opts.mesh}/config.json`);
  console.log(`Saved key:    ~/.mesh/${opts.mesh}/mesh.key`);
  console.log(`\nNext: meshbot start --as ${opts.as} --mesh ${opts.mesh}`);
}

// ─── meshbot init <mesh-name> ───
program
  .command("init <meshName>")
  .description("Create a new mesh and generate shared key")
  .option("--legacy", "Create only config + mesh.key (disable bootstrap artifacts)")
  .option("--no-bootstrap", "Disable bootstrap artifacts (alias for --legacy)")
  .action((meshName: string, opts: { legacy: boolean; bootstrap: boolean }) => {
    if (meshExists(meshName)) {
      console.error(`Mesh "${meshName}" already exists.`);
      process.exit(1);
    }

    const key = generateMeshKey();
    saveMeshKey(meshName, key);
    const config = createDefaultConfig(meshName);
    saveConfig(config);
    const bootstrapEnabled = !opts.legacy && opts.bootstrap;

    console.log(`Mesh "${meshName}" created.`);
    console.log(`Config: ~/.mesh/${meshName}/config.json`);
    console.log(`Key:    ~/.mesh/${meshName}/mesh.key`);
    if (bootstrapEnabled) {
      const bootstrap = setupBootstrapArtifacts(config, key);
      console.log(`Root public key:  ${bootstrap.rootPublicKeyPath}`);
      console.log(`Root private key: ${bootstrap.rootPrivateKeyPath}`);
      console.log(`Manifest:         ${bootstrap.manifestPath} (v${String(bootstrap.manifestVersion)})`);
      console.log(`Key ID:           ${bootstrap.kid}`);
      console.log(
        "\nBootstrap artifacts generated. Use signed manifests/invites to enroll remote hosts without copying config files."
      );
    } else {
      console.log("\nBootstrap setup skipped (legacy mode).");
    }
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
  .description("Add a peer agent to the mesh config (url can be ip:port or full URL)")
  .option("-m, --mesh <meshName>", "Mesh name", "default")
  .option("-d, --description <desc>", "Agent description")
  .action((name: string, url: string, opts: { mesh: string; description?: string }) => {
    try {
      const normalizedUrl = normalizePeerUrl(url);
      const config = loadConfig(opts.mesh);
      const updated = addPeer(config, name, normalizedUrl, opts.description);
      saveConfig(updated);
      maybeUpdateManifestAfterConfigChange(opts.mesh);
      console.log(`Added peer "${name}" (${normalizedUrl}) to mesh "${opts.mesh}".`);
    } catch (err) {
      console.error(`Failed to add peer: ${String(err)}`);
      process.exit(1);
    }
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
    maybeUpdateManifestAfterConfigChange(opts.mesh);
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

program
  .command("export-root-pub")
  .description("Print the mesh root public key (PEM) to stdout")
  .option("-m, --mesh <meshName>", "Mesh name", "default")
  .action((opts: { mesh: string }) => {
    const key = loadRootPublicKey(opts.mesh);
    console.log(key);
  });

program
  .command("stop")
  .description("Stop a running daemon for a specific agent")
  .requiredOption("--as <name>", "Agent name for this daemon")
  .option("-m, --mesh <meshName>", "Mesh name", "default")
  .option("--signal <signal>", "Signal to send first (SIGTERM, SIGINT, SIGKILL)", "SIGTERM")
  .option("--timeout <seconds>", "Wait before SIGKILL fallback", "8")
  .action(
    async (opts: { as: string; mesh: string; signal: string; timeout: string }) => {
      const validSignals: NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGKILL"];
      const signal = opts.signal.toUpperCase() as NodeJS.Signals;
      if (!validSignals.includes(signal)) {
        console.error(
          `Invalid signal "${opts.signal}". Use one of: ${validSignals.join(", ")}`
        );
        process.exit(1);
      }

      const timeoutSeconds = Number.parseInt(opts.timeout, 10);
      if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0) {
        console.error(`Invalid timeout "${opts.timeout}". Use a non-negative integer.`);
        process.exit(1);
      }

      const pidRecord = readDaemonPidRecord(opts.mesh, opts.as);
      if (!pidRecord) {
        console.error(`No daemon PID file found for "${opts.as}" in mesh "${opts.mesh}".`);
        process.exit(1);
      }

      const pid = pidRecord.pid;
      if (!isProcessRunning(pid)) {
        removeDaemonPidFile(opts.mesh, opts.as);
        console.log(
          `Daemon "${opts.as}" is not running (stale PID file removed).`
        );
        return;
      }

      try {
        process.kill(pid, signal);
      } catch (err) {
        console.error(`Failed to signal daemon: ${String(err)}`);
        process.exit(1);
      }

      if (signal !== "SIGKILL") {
        const exited = await waitForProcessExit(pid, timeoutSeconds * 1000);
        if (!exited && isProcessRunning(pid)) {
          console.log(
            `Daemon "${opts.as}" did not exit after ${String(timeoutSeconds)}s, sending SIGKILL...`
          );
          try {
            process.kill(pid, "SIGKILL");
          } catch (killErr) {
            if (isProcessRunning(pid)) {
              console.error(`Failed to SIGKILL daemon: ${String(killErr)}`);
              process.exit(1);
            }
          }
          const killed = await waitForProcessExit(pid, 2000);
          if (!killed) {
            console.error(`Daemon "${opts.as}" is still running (pid ${String(pid)}).`);
            process.exit(1);
          }
        }
      }

      removeDaemonPidFile(opts.mesh, opts.as);
      console.log(`Stopped daemon "${opts.as}" in mesh "${opts.mesh}".`);
    }
  );

// ─── meshbot join-prepare ───
program
  .command("join-prepare")
  .description("Generate per-host enrollment keys for bootstrap join")
  .option("-m, --mesh <meshName>", "Mesh name", "default")
  .action((opts: { mesh: string }) => {
    const keyPair = generateEnrollmentKeyPair();
    saveNodePublicKey(opts.mesh, keyPair.publicKey);
    saveNodePrivateKey(opts.mesh, keyPair.privateKey);

    console.log(`Generated node enrollment keys for mesh "${opts.mesh}".`);
    console.log(`Public key:  ~/.mesh/${opts.mesh}/node.pub`);
    console.log(`Private key: ~/.mesh/${opts.mesh}/node.key`);
    console.log(`Note: this does not create root.pub. Get root.pub from the mesh init/admin host.`);
    console.log("\nGive this value to an admin for invite creation:");
    console.log(keyPair.publicKey);
  });

const inviteCommand = program
  .command("invite")
  .description("Invite token utilities");

inviteCommand
  .command("create")
  .description("Create a signed join invite token")
  .requiredOption("--agent <name>", "Agent name this invite is for")
  .requiredOption("--node-pubkey <base64>", "Node public key from `meshbot join-prepare`")
  .option("-m, --mesh <meshName>", "Mesh name", "default")
  .option("--seed <urls...>", "Optional seed URL hints embedded in the invite token")
  .option("--ttl <duration>", "Invite validity (e.g. 15m, 2h)", "15m")
  .action((opts: { agent: string; nodePubkey: string; mesh: string; ttl: string; seed?: string[] }) => {
    const rootPrivateKey = loadRootPrivateKey(opts.mesh);
    const ttlMs = parseDurationToMs(opts.ttl);
    const now = Date.now();
    const config = loadConfig(opts.mesh);
    const seedHints = (opts.seed && opts.seed.length > 0)
      ? opts.seed.map((seed) => normalizePeerUrl(seed))
      : Object.values(config.peers).map((peer) => normalizePeerUrl(peer.url)).slice(0, 5);

    let minManifestVersion: number | undefined;
    try {
      const manifest = loadManifest(opts.mesh);
      const payload = parseEnvelopePayload(manifest) as ManifestPayload;
      minManifestVersion = payload.version;
    } catch {
      minManifestVersion = undefined;
    }

    const invitePayload: InviteTokenPayload = {
      v: 1,
      mesh: opts.mesh,
      agent: opts.agent,
      nodePubKey: opts.nodePubkey,
      jti: crypto.randomUUID(),
      iat: now,
      nbf: now,
      exp: now + ttlMs,
    };
    if (seedHints.length > 0) {
      invitePayload.seedHints = seedHints;
    }
    if (minManifestVersion !== undefined) {
      invitePayload.minManifestVersion = minManifestVersion;
    }

    const token = createInviteToken(invitePayload, rootPrivateKey);

    console.log(token);
  });

// ─── meshbot join ───
program
  .command("join")
  .description("Join a mesh by fetching a signed manifest from a seed peer")
  .requiredOption("--as <name>", "Agent name for this host")
  .option("--seed <url>", "Bootstrap seed peer URL or ip:port (optional if invite includes seed hints)")
  .requiredOption("--invite <token>", "Invite token from `meshbot invite create`")
  .requiredOption("--root-pub <path>", "Path to root public key PEM")
  .option("-m, --mesh <meshName>", "Mesh name", "default")
  .action(
    async (opts: {
      as: string;
      seed?: string;
      invite: string;
      rootPub: string;
      mesh: string;
    }) => {
      try {
        await performJoin(opts);
      } catch (err) {
        console.error(`Join failed: ${String(err)}`);
        process.exit(1);
      }
    }
  );

async function runWizardAdmin(): Promise<void> {
  let rl: ReadlineInterface | undefined;
  try {
    rl = createPromptInterface();
    const meshName = await promptRequiredText(rl, "Mesh name", "default");
    const seedAgent = await promptRequiredText(rl, "Seed agent name", "seed");
    const defaultPort = "9820";
    const defaultSeedAddress = detectDefaultSeedAddress(defaultPort);
    const seedAddress = await promptRequiredText(
      rl,
      "Seed address other hosts should use (ip:port or URL)",
      defaultSeedAddress
    );
    const detectedPort = parsePortFromUrlOrHost(seedAddress) ?? defaultPort;
    const seedPort = await promptRequiredText(rl, "Seed daemon port", detectedPort);
    const seedHost = await promptRequiredText(rl, "Seed daemon listen host", "0.0.0.0");
    const startDaemonNow = await promptYesNo(rl, "Start seed daemon now", true);
    rl.close();
    rl = undefined;

    const seedUrl = new URL(normalizePeerUrl(seedAddress));
    if (!seedUrl.port) {
      seedUrl.port = seedPort;
    }
    const normalizedSeedUrl = seedUrl.toString().replace(/\/$/, "");

    if (!meshExists(meshName)) {
      const key = generateMeshKey();
      saveMeshKey(meshName, key);
      const config = createDefaultConfig(meshName);
      saveConfig(config);
      const bootstrap = setupBootstrapArtifacts(config, key);
      console.log(`Created mesh "${meshName}" with bootstrap artifacts.`);
      console.log(`Root public key:  ${bootstrap.rootPublicKeyPath}`);
      console.log(`Root private key: ${bootstrap.rootPrivateKeyPath}`);
    } else {
      const bootstrap = ensureBootstrapArtifacts(meshName);
      if (bootstrap.createdRootKeys) {
        console.log(`Generated bootstrap root keys for existing mesh "${meshName}".`);
      } else if (bootstrap.createdManifest) {
        console.log(`Generated signed manifest for existing mesh "${meshName}".`);
      }
    }

    const config = loadConfig(meshName);
    const description = config.peers[seedAgent]?.description ?? "Bootstrap seed";
    const updated = addPeer(config, seedAgent, normalizedSeedUrl, description);
    saveConfig(updated);
    maybeUpdateManifestAfterConfigChange(meshName);

    console.log(`Configured seed peer "${seedAgent}" at ${normalizedSeedUrl}.`);
    if (startDaemonNow) {
      const existing = readDaemonPidRecord(meshName, seedAgent);
      if (existing && isProcessRunning(existing.pid)) {
        console.log(
          `Daemon "${seedAgent}" is already running in mesh "${meshName}" (pid ${String(existing.pid)}).`
        );
      } else {
        if (existing) {
          removeDaemonPidFile(meshName, seedAgent);
        }
        startDetachedMeshbot([
          "start",
          "--as",
          seedAgent,
          "--mesh",
          meshName,
          "--port",
          seedPort,
          "--host",
          seedHost,
          "--daemon",
        ]);
        console.log(`Started "${seedAgent}" daemon in background.`);
      }
    } else {
      console.log(
        `Start it when ready: meshbot start --as ${seedAgent} --mesh ${meshName} --port ${seedPort} --host ${seedHost} --daemon`
      );
    }

    console.log("\nNext on a new host:");
    console.log("  meshbot wizard join");
    console.log("Then run on this admin host when prompted:");
    console.log(
      `  meshbot invite create --mesh ${meshName} --agent <new-agent> --node-pubkey <node-pub> --ttl 15m`
    );
    console.log(`  meshbot export-root-pub --mesh ${meshName}`);
  } catch (err) {
    if (rl) rl.close();
    console.error(`wizard-admin failed: ${String(err)}`);
    process.exit(1);
  }
}

async function runWizardJoin(): Promise<void> {
  let rl: ReadlineInterface | undefined;
  try {
    rl = createPromptInterface();
    const meshName = await promptRequiredText(rl, "Mesh name", "default");
    const defaultAgent = os.hostname().split(".")[0] || "agent";
    const agentName = await promptRequiredText(rl, "Agent name for this host", defaultAgent);

    const nodePubPath = getNodePublicKeyPath(meshName);
    const hasNodeKey = fs.existsSync(nodePubPath);
    let nodePubKey: string;
    if (hasNodeKey) {
      const reuse = await promptYesNo(rl, "Reuse existing node enrollment key", true);
      if (reuse) {
        nodePubKey = loadNodePublicKey(meshName);
      } else {
        const keyPair = generateEnrollmentKeyPair();
        saveNodePublicKey(meshName, keyPair.publicKey);
        saveNodePrivateKey(meshName, keyPair.privateKey);
        nodePubKey = keyPair.publicKey;
      }
    } else {
      const keyPair = generateEnrollmentKeyPair();
      saveNodePublicKey(meshName, keyPair.publicKey);
      saveNodePrivateKey(meshName, keyPair.privateKey);
      nodePubKey = keyPair.publicKey;
    }

    console.log(`\nNode public key (${nodePubPath}):`);
    console.log(nodePubKey);
    const inviteCreateCommand = [
      "meshbot invite create",
      `--mesh ${shellQuote(meshName)}`,
      `--agent ${shellQuote(agentName)}`,
      `--node-pubkey ${shellQuote(nodePubKey)}`,
      "--ttl 15m",
    ].join(" ");
    const exportRootPubCommand = `meshbot export-root-pub --mesh ${shellQuote(meshName)}`;
    const adminCommandSnippet = `${inviteCreateCommand}\n${exportRootPubCommand}`;

    console.log("\nRun these on the admin host:");
    console.log(`  ${inviteCreateCommand}`);
    console.log(`  ${exportRootPubCommand}`);
    const clipboard = tryCopyToClipboard(adminCommandSnippet);
    if (clipboard.ok) {
      console.log(`(Copied both admin commands to clipboard via ${clipboard.method}.)`);
    } else {
      console.log("(Clipboard copy unavailable in this environment.)");
    }

    const continueToJoin = await promptYesNo(rl, "Do you already have invite token + root.pub", false);
    if (!continueToJoin) {
      console.log("\nRun this command again after you receive the invite token and root public key.");
      rl.close();
      return;
    }

    const inviteToken = await promptRequiredText(rl, "Paste invite token");
    const rootPubPathInput = await promptRequiredText(
      rl,
      "Path to root public key PEM (root.pub)",
      `~/.mesh/${meshName}/root.pub`
    );
    const seedOverrideRaw = await promptText(
      rl,
      "Optional seed override (ip:port or URL; press Enter to skip)"
    );
    rl.close();
    rl = undefined;

    const rootPubPath = expandHomePath(rootPubPathInput);
    if (!fs.existsSync(rootPubPath)) {
      throw new Error(`Root public key file not found: ${rootPubPath}`);
    }

    await performJoin({
      as: agentName,
      mesh: meshName,
      invite: inviteToken,
      rootPub: rootPubPath,
      seed: seedOverrideRaw.trim().length > 0 ? seedOverrideRaw : undefined,
    });
  } catch (err) {
    if (rl) rl.close();
    console.error(`wizard-join failed: ${String(err)}`);
    process.exit(1);
  }
}

const wizardCommand = program
  .command("wizard")
  .description("Interactive setup wizards for multi-host bootstrap");

wizardCommand
  .command("admin")
  .description("Interactive setup for an admin/seed host")
  .action(runWizardAdmin);

wizardCommand
  .command("join")
  .description("Interactive setup for a new host joining a mesh")
  .action(runWizardJoin);

program
  .command("wizard-admin")
  .description("Interactive setup for an admin/seed host (alias for `wizard admin`)")
  .action(runWizardAdmin);

program
  .command("wizard-join")
  .description("Interactive setup for a new host joining a mesh (alias for `wizard join`)")
  .action(runWizardJoin);

// ─── meshbot sync ───
program
  .command("sync")
  .description("Sync signed manifest from a seed peer")
  .requiredOption("--seed <url>", "Seed peer URL or ip:port")
  .option("-m, --mesh <meshName>", "Mesh name", "default")
  .action(async (opts: { seed: string; mesh: string }) => {
    try {
      const meshKey = loadMeshKey(opts.mesh);
      const rootPublicKey = fs.readFileSync(getRootPublicKeyPath(opts.mesh), "utf-8").trim();

      const remoteHead = await fetchBootstrapHead(opts.seed, meshKey);

      let localVersion = 0;
      try {
        const localManifest = loadManifest(opts.mesh);
        const localPayload = parseEnvelopePayload(localManifest) as ManifestPayload;
        localVersion = localPayload.version;
      } catch {
        localVersion = 0;
      }

      if (remoteHead.version <= localVersion) {
        console.log(
          `Manifest already up to date (local v${String(localVersion)}, remote v${String(remoteHead.version)}).`
        );
        return;
      }

      const remoteManifest = await fetchBootstrapManifest(
        opts.seed,
        meshKey,
        remoteHead.version
      );

      const verified = verifyEnvelopeEd25519(remoteManifest, rootPublicKey);
      if (!verified) {
        throw new Error("Remote manifest signature verification failed");
      }

      const payload = parseEnvelopePayload(remoteManifest) as ManifestPayload;
      if (payload.mesh !== opts.mesh) {
        throw new Error(
          `Manifest mesh mismatch: expected "${opts.mesh}" got "${payload.mesh}"`
        );
      }

      saveManifest(opts.mesh, remoteManifest);
      saveMeshKey(opts.mesh, payload.transport.meshKey);
      saveConfig(manifestToConfig(payload));

      console.log(`Synced manifest to version ${String(payload.version)}.`);
    } catch (err) {
      console.error(`Sync failed: ${String(err)}`);
      process.exit(1);
    }
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
        const existingDaemon = readDaemonPidRecord(opts.mesh, opts.as);
        if (existingDaemon) {
          if (isProcessRunning(existingDaemon.pid)) {
            console.error(
              `Daemon "${opts.as}" is already running in mesh "${opts.mesh}" (pid ${String(existingDaemon.pid)}).`
            );
            console.error(`Stop it first with: meshbot stop --as ${opts.as} --mesh ${opts.mesh}`);
            process.exit(1);
          }
          removeDaemonPidFile(opts.mesh, opts.as);
        }

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

        writeDaemonPidRecord({
          pid: process.pid,
          mesh: opts.mesh,
          agent: opts.as,
          startedAt: Date.now(),
          port: opts.port,
          host: opts.host,
        });
        let pidFileRemoved = false;
        const cleanupPidFile = () => {
          if (pidFileRemoved) return;
          removeDaemonPidFile(opts.mesh, opts.as);
          pidFileRemoved = true;
        };
        process.on("exit", cleanupPidFile);

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
          cleanupPidFile();
          process.exit(0);
        };
        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);

        // Keep process alive
        await new Promise(() => { });
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
