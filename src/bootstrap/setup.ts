import type { MeshConfig, ManifestPayload } from "../config/types.js";
import {
  loadManifest,
  loadRootPrivateKey,
  saveManifest,
  saveRootPrivateKey,
  saveRootPublicKey,
  getManifestPath,
  getRootPrivateKeyPath,
  getRootPublicKeyPath,
} from "../config/loader.js";
import { generateSigningKeyPair } from "../security/keys.js";
import { parseEnvelopePayload, signEnvelopeEd25519 } from "../security/signing.js";

export interface BootstrapInitResult {
  manifestVersion: number;
  manifestPath: string;
  rootPublicKeyPath: string;
  rootPrivateKeyPath: string;
  kid: string;
}

function buildManifestPayload(
  config: MeshConfig,
  meshKey: string,
  version: number
): ManifestPayload {
  return {
    v: 1,
    mesh: config.mesh,
    version,
    issuedAt: new Date().toISOString(),
    security: { ...config.security },
    transport: { meshKey },
    agents: { ...config.peers },
    revocations: {
      inviteJti: [],
      agents: [],
    },
  };
}

function buildKeyId(): string {
  const date = new Date().toISOString().slice(0, 10);
  return `root-${date}`;
}

export function setupBootstrapArtifacts(
  config: MeshConfig,
  meshKey: string
): BootstrapInitResult {
  const { publicKeyPem, privateKeyPem } = generateSigningKeyPair();
  saveRootPublicKey(config.mesh, publicKeyPem);
  saveRootPrivateKey(config.mesh, privateKeyPem);

  const payload = buildManifestPayload(config, meshKey, 1);
  const kid = buildKeyId();
  const envelope = signEnvelopeEd25519(payload, privateKeyPem, kid);
  saveManifest(config.mesh, envelope);

  return {
    manifestVersion: payload.version,
    manifestPath: getManifestPath(config.mesh),
    rootPublicKeyPath: getRootPublicKeyPath(config.mesh),
    rootPrivateKeyPath: getRootPrivateKeyPath(config.mesh),
    kid,
  };
}

function getNextManifestVersion(meshName: string): number {
  try {
    const existingManifest = loadManifest(meshName);
    const payload = parseEnvelopePayload(existingManifest) as ManifestPayload;
    return payload.version + 1;
  } catch {
    return 1;
  }
}

function getManifestKeyId(meshName: string): string {
  try {
    const existingManifest = loadManifest(meshName);
    return existingManifest.kid;
  } catch {
    return buildKeyId();
  }
}

export function updateSignedManifest(
  config: MeshConfig,
  meshKey: string
): { version: number; path: string; kid: string } {
  const rootPrivateKeyPem = loadRootPrivateKey(config.mesh);
  const version = getNextManifestVersion(config.mesh);
  const kid = getManifestKeyId(config.mesh);
  const payload = buildManifestPayload(config, meshKey, version);
  const envelope = signEnvelopeEd25519(payload, rootPrivateKeyPem, kid);
  saveManifest(config.mesh, envelope);
  return { version: payload.version, path: getManifestPath(config.mesh), kid };
}

export function manifestToConfig(payload: ManifestPayload): MeshConfig {
  return {
    mesh: payload.mesh,
    peers: { ...payload.agents },
    security: { ...payload.security },
  };
}
