# Peer Bootstrap Spec (No Central Config Service)

This spec removes manual `scp ~/.mesh/<mesh>/` copying by letting new nodes bootstrap from any running peer.

Distribution is peer-to-peer, trust is rooted in an offline signing key.

## Goals

1. No centralized config service.
2. No manual copying of `config.json` to every host.
3. Keep current message transport/auth (`mesh.key` + HMAC) for v1 rollout.
4. Add cryptographic integrity for distributed config (`mesh-manifest` signed by root key).
5. Make `meshbot init` the default one-command setup for bootstrap artifacts.
6. Keep backward compatibility with current `meshbot init/add-peer/start` flow.

## Non-Goals (v1)

1. Replacing shared mesh transport key with per-agent transport keys.
2. Full consensus protocol between peers.
3. Auto-issuing TLS certificates.

## Trust Model

1. Create offline root Ed25519 keypair once per mesh.
2. Root private key signs manifest snapshots.
3. Root private key signs join invite tokens.
4. Any peer may serve signed data, but nodes only accept signatures valid under the pinned root public key.

## File Layout

`~/.mesh/<mesh>/` additions:

1. `root.pub` - pinned root public key (required on all nodes)
2. `manifest.json` - latest signed manifest envelope
3. `bootstrap-state.json` - local state (last version/hash, seen invite jti cache, sync cursors)

Existing files remain:

1. `config.json`
2. `mesh.key`

## Data Schemas

### Signed Envelope

```json
{
  "alg": "Ed25519",
  "kid": "root-2026-01",
  "payload": "base64url(canonical-json)",
  "sig": "base64url(signature-by-root-private-key)"
}
```

Canonical JSON means stable key ordering and UTF-8 bytes.

### Manifest Payload

```json
{
  "v": 1,
  "mesh": "my-mesh",
  "version": 7,
  "issuedAt": "2026-02-16T18:30:00Z",
  "security": {
    "replayWindowSeconds": 60,
    "maxMessageSizeBytes": 1048576
  },
  "transport": {
    "meshKey": "base64-32-byte-key"
  },
  "agents": {
    "prod-ops": {
      "url": "https://prod.internal:9820",
      "description": "Production monitoring"
    },
    "dev": {
      "url": "https://dev.internal:9821",
      "description": "Development agent"
    }
  },
  "revocations": {
    "inviteJti": [],
    "agents": []
  }
}
```

### Invite Token Payload

```json
{
  "v": 1,
  "mesh": "my-mesh",
  "agent": "qa-bot",
  "nodePubKey": "base64-ed25519-public-key",
  "jti": "uuid-v4",
  "iat": 1771266600000,
  "nbf": 1771266600000,
  "exp": 1771267500000,
  "seedHints": ["https://prod.internal:9820"],
  "minManifestVersion": 7
}
```

Token wire format:

1. `base64url(payload-json) + "." + base64url(ed25519-signature)`

## HTTP API

All new endpoints are under `/mesh/bootstrap`.

### `POST /mesh/bootstrap/join`

Purpose: one-time onboarding for a node without mesh key/config.

Auth: none; invite token is the credential.

Request:

```json
{
  "token": "<payload.sig>",
  "nodePubKey": "base64-ed25519-public-key",
  "announceUrl": "https://qa.internal:9822"
}
```

Validation:

1. Token signature verifies using `root.pub`.
2. `mesh` matches local mesh.
3. `nbf/exp` valid with <= 60s clock skew.
4. `token.nodePubKey === request.nodePubKey`.
5. `token.agent` not revoked.
6. `jti` not already used/revoked (optional strict one-time mode).
7. Local manifest version >= `minManifestVersion`.

Success response `200`:

```json
{
  "ok": true,
  "mesh": "my-mesh",
  "agent": "qa-bot",
  "now": 1771266655000,
  "manifest": {
    "alg": "Ed25519",
    "kid": "root-2026-01",
    "payload": "...",
    "sig": "..."
  },
  "sync": {
    "headUrl": "/mesh/bootstrap/head",
    "manifestUrlTemplate": "/mesh/bootstrap/manifest/{version}",
    "intervalSeconds": 30
  }
}
```

Error codes:

1. `400` malformed payload
2. `401` invalid signature
3. `403` expired/not-yet-valid/revoked token
4. `409` token replay (`jti` already used)
5. `412` peer manifest too old for token requirement

### `GET /mesh/bootstrap/head`

Purpose: lightweight sync check for already-joined nodes.

Auth: existing mesh auth (Bearer `mesh.key` + existing middleware).

Response:

```json
{
  "mesh": "my-mesh",
  "version": 8,
  "manifestHash": "sha256:ab12...",
  "issuedAt": "2026-02-16T18:45:00Z"
}
```

### `GET /mesh/bootstrap/manifest/:version`

Purpose: fetch full signed manifest.

Auth: existing mesh auth.

Response:

1. Signed envelope JSON.

## CLI Spec

### Default UX

`meshbot init <mesh>` should automatically perform bootstrap setup with no extra admin commands:

1. Generate root keypair for the mesh.
2. Save `root.pub` in mesh dir and `root.key` in a local secure admin path.
3. Create/sign initial manifest (`version = 1`) from current config.
4. Save/publishable `manifest.json` locally.
5. Print next-step commands for joining remote hosts.

### Init Flags

1. `meshbot init <mesh>`: default bootstrap-enabled init.
2. `meshbot init <mesh> --legacy`: old behavior only (`config.json` + `mesh.key`, no root keys/manifest).
3. `meshbot init <mesh> --no-bootstrap`: alias for `--legacy`.

### Admin Commands

Advanced/manual commands (normally not needed for first-time setup):

1. `meshbot root-keygen --mesh <mesh> --out-private <path> --out-public <path>`
2. `meshbot manifest build --mesh <mesh> --version <n> --root-key <path> --out <path>`
3. `meshbot invite create --mesh <mesh> --agent <name> --node-pubkey <base64> --root-key <path> --ttl <duration>`
4. `meshbot manifest publish --mesh <mesh> --file <manifest.json>`

### Node Commands

1. `meshbot join prepare --mesh <mesh> --as <agent>`
2. `meshbot join --mesh <mesh> --as <agent> --seed <url> --invite <token> --root-pub <path>`
3. `meshbot sync --mesh <mesh> [--seed <url>]`

### Command Behavior

`meshbot join prepare`:

1. Creates node keypair at `~/.mesh/<mesh>/node.key` and `node.pub`.
2. Prints `node.pub` to be used for invite creation.

`meshbot join`:

1. Calls `POST /mesh/bootstrap/join`.
2. Verifies returned manifest signature with `--root-pub`.
3. Converts manifest to local `config.json`.
4. Writes `mesh.key` from `manifest.transport.meshKey`.
5. Writes `manifest.json` cache.
6. Starts normal agent workflow or prints next command.

`meshbot sync`:

1. Calls `/head`; if version unchanged, exits 0.
2. If newer, fetches `/manifest/:version`, verifies signature, atomically replaces local manifest/config.

## New Host Workflow

### A. Initialize mesh once (admin host)

1. Run:

```bash
meshbot init my-mesh
```

2. Output artifacts: `~/.mesh/my-mesh/root.pub`, root private key path (printed; stored outside shared mesh dir), and `~/.mesh/my-mesh/manifest.json` with `version = 1`.

### B. Prepare new host

1. Run:

```bash
meshbot join prepare --mesh my-mesh --as qa-bot
```

2. Copy printed `nodePubKey` value.

### C. Admin creates signed artifacts

1. Update local mesh config/peers to include `qa-bot`.
2. Build and sign next manifest:

```bash
meshbot manifest build --mesh my-mesh --version 8 --root-key ./root.key --out ./manifest-v8.json
```

3. Create short-lived invite bound to the new host key:

```bash
meshbot invite create --mesh my-mesh --agent qa-bot --node-pubkey <copied-pubkey> --root-key ./root.key --ttl 15m
```

### D. Publish to any running peer

1. On one existing peer:

```bash
meshbot manifest publish --mesh my-mesh --file ./manifest-v8.json
```

2. That peer now serves version 8 to other peers/nodes.

### E. Join from new host

1. Run:

```bash
meshbot join --mesh my-mesh --as qa-bot --seed https://prod.internal:9820 --invite <token> --root-pub ~/.mesh/my-mesh/root.pub
```

2. Start agent:

```bash
meshbot start --as qa-bot --mesh my-mesh --port 9822
```

### F. Ongoing updates

1. Existing nodes run `meshbot sync --mesh my-mesh` on an interval, or `start/serve` performs sync loop every 30 seconds.

## Backward Compatibility

1. If `manifest.json` is absent, current legacy flow continues unchanged.
2. `meshbot init` still creates `config.json` + `mesh.key`.
3. `add-peer/remove-peer` still work; `manifest build` snapshots current config into signed state.

## Implementation Plan by Module

1. `src/security/keys.ts`: add Ed25519 key generation/load helpers for root and node keys.
2. `src/security/signing.ts`: add detached signature helpers for manifest and invite payloads.
3. `src/config/types.ts`: add manifest and invite TypeScript types.
4. `src/config/loader.ts`: add load/save helpers for `manifest.json` and `bootstrap-state.json`.
5. `src/server/routes.ts`: add `/mesh/bootstrap/join`, `/head`, and `/manifest/:version` handlers.
6. `src/server/http-server.ts`: mount bootstrap routes and bypass mesh-key auth for `/bootstrap/join`.
7. `src/client/mesh-client.ts`: add join/head/manifest client calls.
8. `bin/meshbot.ts`: add `root-keygen`, `manifest`, `invite`, `join`, and `sync` commands.
9. `src/mcp/server.ts`: optionally run sync loop and reload peers from updated config.

## Security Notes

1. Keep root private key offline.
2. Invite TTL should be short (`<= 15m`).
3. Require HTTPS for bootstrap endpoints in production.
4. Track consumed `jti` values for replay prevention.
5. Prefer one root key per mesh and rotate via new `kid` when needed.
