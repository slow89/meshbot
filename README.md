# meshbot

[![CI](https://github.com/slow89/meshbot/actions/workflows/ci.yml/badge.svg)](https://github.com/slow89/meshbot/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org/)

MCP server that adds cross-server networking to [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — lets named agent instances on different servers communicate securely over HTTPS.

## What It Does

Claude Code instances on different servers have no built-in way to talk to each other. `meshbot` is an MCP server that gives Claude Code peer-to-peer messaging tools. Each agent gets an HTTP endpoint for receiving messages and MCP tools for sending them. You get the **full Claude Code TUI** — meshbot just adds networking on top.

```
                         HTTPS + HMAC
  ┌──────────────┐  ◄──────────────────►  ┌──────────────┐
  │  prod-ops    │                         │  dev         │
  │  (server A)  │                         │  (server B)  │
  │              │                         │              │
  │  Claude Code │                         │  Claude Code │
  │  + mesh MCP  │                         │  + mesh MCP  │
  │  + HTTP :9820│                         │  + HTTP :9821│
  └──────────────┘                         └──────────────┘
```

## Quick Start

### Install

```bash
curl -fsSL https://raw.githubusercontent.com/slow89/meshbot/main/install.sh | bash
```

Or manually:

```bash
git clone https://github.com/slow89/meshbot.git
cd meshbot
pnpm install && pnpm run build
pnpm link --global
```

### Local Demo (Two Agents on One Machine)

Open **two** terminal windows:

```bash
# ── Terminal 1: Init the mesh, then start the dev agent ──
meshbot init default
meshbot start --as dev
# Launches the full Claude Code TUI with mesh tools
```

```bash
# ── Terminal 2: Start the prod-ops agent ──
meshbot start --as prod-ops
```

That's it. Ports are auto-assigned, and **agents auto-register themselves** when they start. No need to manually add peers or pick ports. Each agent sees the others via `list_agents`:

```
# Inside the prod-ops Claude Code session:
> I found a null pointer in auth.ts. Let me tell dev about it.
> [calls send_message({to: "dev", message: "NullPointerError in auth.ts:42..."})]
```

> **Note**: Agents always reload the peer list from disk, so it doesn't matter which agent starts first. You can optionally pass `--port <port>` to use a fixed port.

### Daemon Mode (Autonomous Agents)

Run an agent that auto-processes incoming messages without any user interaction:

```bash
meshbot start --as prod-ops --daemon
```

In daemon mode, the agent:
- Listens for incoming messages on its HTTP port
- Polls the message queue every 3 seconds (configurable with `--poll-interval`)
- Automatically spawns a headless `claude -p` session to process each batch of messages
- Claude can respond using `send_message`, triggering actions on other agents

This is ideal for always-on agents like monitoring bots, CI/CD agents, or any agent that should react to messages autonomously.

```bash
# Terminal 1: interactive dev agent
meshbot start --as dev

# Terminal 2: autonomous prod-ops agent that processes messages on its own
meshbot start --as prod-ops --daemon

# Now from the dev TUI, send a message:
> ask prod-ops to check the server status
# prod-ops will automatically process it and reply
```

### Multi-Server Setup

For agents on different servers, use `add-peer` to register remote agents with their external URLs, then copy the mesh config + key:

```bash
# On any machine: create the mesh and pre-register remote agents
meshbot init my-mesh
meshbot add-peer prod-ops https://prod.internal:9820 -m my-mesh -d "Production monitoring"
meshbot add-peer dev      https://dev.internal:9821  -m my-mesh -d "Development agent"

# Copy the mesh config + key to each server
scp -r ~/.mesh/my-mesh/ user@prod.internal:~/.mesh/my-mesh/
scp -r ~/.mesh/my-mesh/ user@dev.internal:~/.mesh/my-mesh/
```

```bash
# On production server
meshbot start --as prod-ops --port 9820 --mesh my-mesh

# On dev server
meshbot start --as dev --port 9821 --mesh my-mesh
```

> **Note**: On multi-server setups, `add-peer` with explicit URLs is needed because auto-registration uses `localhost`. Use fixed `--port` values so peers know where to find each other.

### Enabling HTTPS (TLS)

By default, meshbot uses HTTP. To enable HTTPS, add a `tls` section to your mesh config (`~/.mesh/<name>/config.json`):

```json
{
  "mesh": "my-mesh",
  "tls": {
    "cert": "/path/to/server.crt",
    "key": "/path/to/server.key",
    "ca": "/path/to/ca.crt",
    "rejectUnauthorized": true
  },
  "peers": { ... },
  "security": { ... }
}
```

Once TLS is configured, meshbot automatically uses HTTPS. No flags needed.

## Architecture

```
meshbot start --as prod-ops
  │
  └──► claude --mcp-config '...' --append-system-prompt '...'
         │
         ├── Full Claude Code TUI
         │   (interactive, streaming, tool use, /commands — everything)
         │
         └── MCP: mesh server (meshbot serve)
               │
               ├── stdio transport (MCP protocol ↔ Claude Code)
               │
               ├── HTTP server (auto-assigned port)
               │     POST /mesh/msg       (fire-and-forget)
               │     POST /mesh/ask       (request/reply)
               │     POST /mesh/response
               │     GET  /mesh/health
               │
               └── Message queue + disk persistence
```

`meshbot start` spawns the real `claude` binary with the mesh MCP server injected. You get the full Claude Code experience — the TUI, streaming, tool use, `/commands`, conversation history, everything. Meshbot is invisible except for the extra mesh tools.

## CLI Reference

### Start an Agent

```bash
# One command: starts Claude Code with mesh tools
meshbot start --as <name> [options] [-- extra-claude-flags]

# Examples
meshbot start --as dev
meshbot start --as prod-ops -- --model sonnet
meshbot start --as bot --port 8080 -- --permission-mode bypassPermissions
```

| Flag | Description | Default |
|------|-------------|---------|
| `--as <name>` | Agent name (required) | — |
| `-m, --mesh <name>` | Mesh name | `default` |
| `-p, --port <port>` | HTTP listener port | `0` (auto) |
| `--host <host>` | HTTP listener host | `0.0.0.0` |
| `--daemon` | Run as autonomous daemon (no TUI) | `false` |
| `--poll-interval <s>` | Daemon poll interval in seconds | `3` |

Any flags after `--` are passed directly to `claude`. HTTP/HTTPS is auto-detected from mesh TLS config.

### MCP Server (Advanced)

The `serve` command runs the MCP server directly. You don't usually need this — `start` handles it. But you can use it for manual MCP registration:

```bash
# Register with Claude Code manually
claude mcp add mesh -- meshbot serve --as dev

# Then just run claude normally — mesh tools are available
claude
```

### Mesh Management

```bash
meshbot init <mesh-name>                          # Create mesh + generate key
meshbot add-peer <name> <url> [-d "description"]  # Add peer
meshbot remove-peer <name>                        # Remove peer
meshbot status                                    # Show all peers (online/offline)
meshbot send <to> <message>                       # Manual message (debugging)
meshbot export-key                                # Print mesh key
```

## MCP Tools

These tools are automatically available to Claude inside a mesh agent session:

| Tool | Description | Parameters |
|------|-------------|------------|
| `list_agents` | List all peers with online/offline status | — |
| `send_message` | Fire-and-forget message to a peer | `to`, `message` |
| `ask_agent` | Send message and wait for response | `to`, `message`, `timeoutSeconds?` (default: 120) |
| `get_agent_status` | Check if a specific peer is online | `name` |
| `broadcast` | Send message to all peers | `message`, `exclude?` |
| `check_messages` | Retrieve queued incoming messages | — |

## Security

### Pre-Shared Key

```bash
meshbot init my-mesh
# Creates ~/.mesh/my-mesh/mesh.key (256-bit random, base64)
# Share this key with all servers in the mesh
```

All agents in a mesh share the same key. To add a server, copy the `~/.mesh/<name>/` directory.

### Wire Security

Every message includes:

- **Bearer token** — mesh key in the Authorization header
- **HMAC-SHA256** — signature over the message body using the mesh key
- **Nonce** — UUID, reject duplicates (replay protection)
- **Timestamp** — reject messages older than 60 seconds

All traffic should use HTTPS in production. Configure TLS in the mesh config to enable it automatically.

| Threat | Mitigation |
|--------|------------|
| Unauthorized agent | Must have mesh key |
| Eavesdropping | TLS (HTTPS) |
| Tampering | HMAC-SHA256 on body |
| Replay attacks | Nonce + 60s timestamp window |

## Configuration

Config lives in `~/.mesh/<mesh-name>/`:

```
~/.mesh/my-mesh/
├── config.json    # Peer list, TLS, security settings
└── mesh.key       # Shared secret (mode 600)
```

### config.json

```json
{
  "mesh": "my-mesh",
  "peers": {
    "prod-ops": {
      "url": "https://prod.internal:9820",
      "description": "Production monitoring"
    },
    "dev": {
      "url": "https://dev.internal:9821",
      "description": "Development agent"
    }
  },
  "tls": {
    "cert": "/path/to/cert.pem",
    "key": "/path/to/key.pem"
  },
  "security": {
    "replayWindowSeconds": 60,
    "maxMessageSizeBytes": 1048576
  }
}
```

## Multiple Agents Per Server

Each agent gets its own port. Run as many as you want on one machine:

```bash
# Terminal 1
meshbot start --as prod-ops

# Terminal 2
meshbot start --as log-analyzer

# Terminal 3
meshbot start --as dev
```

Add all three to the peer config:

```bash
meshbot add-peer prod-ops     https://myserver:9820 -d "Production monitoring"
meshbot add-peer log-analyzer https://myserver:9821 -d "Log analysis"
meshbot add-peer dev          https://myserver:9822 -d "Development"
```

## Wire Format

Messages between agents use this structure:

```typescript
interface MeshMessage {
  id: string;           // UUID v4
  from: string;         // Sender agent name
  to: string;           // Recipient agent name
  type: "message" | "ask" | "response";
  payload: string;      // Message content
  replyTo?: string;     // For responses: original message ID
  timestamp: number;    // Unix milliseconds
  nonce: string;        // UUID for replay protection
  hmac: string;         // HMAC-SHA256(key, id|type|payload|timestamp|nonce)
}
```

## Development

```bash
git clone https://github.com/slow89/meshbot.git
cd meshbot
pnpm install
pnpm run build       # Compile TypeScript
pnpm run lint        # ESLint (strict)
pnpm run typecheck   # tsc --noEmit
pnpm test            # Vitest (46 tests)
pnpm run dev         # Run with tsx (no build step)
```

### Project Structure

```
bin/meshbot.ts         CLI entry point (Commander)
src/
  mcp/
    server.ts          MCP server (stdio transport + HTTP listener + 6 tools)
  server/
    http-server.ts     Express server setup
    auth.ts            Auth middleware (key + HMAC + nonce + timestamp)
    routes.ts          POST /msg, /ask, /response, GET /health
  client/
    mesh-client.ts     HTTP client for sending to peers
  queue/
    message-queue.ts   In-memory queue + JSON file persistence
  config/
    loader.ts          Config CRUD
    types.ts           TypeScript interfaces
  security/
    keys.ts            Key generation
    signing.ts         HMAC + nonce + timestamp validation
tests/                 Unit + integration tests
```

## Requirements

- **Node.js** >= 18
- **Claude Code** installed and authenticated ([docs](https://docs.anthropic.com/en/docs/claude-code))

## License

[MIT](LICENSE)
