import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  type MeshConfig,
  type SignedEnvelope,
  type PeerConfig,
  DEFAULT_SECURITY,
  CONFIG_DIR_NAME,
  ADMIN_CONFIG_DIR_NAME,
} from "./types.js";

function getMeshDir(meshName: string): string {
  return path.join(os.homedir(), CONFIG_DIR_NAME, meshName);
}

function getConfigPath(meshName: string): string {
  return path.join(getMeshDir(meshName), "config.json");
}

function getKeyPath(meshName: string): string {
  return path.join(getMeshDir(meshName), "mesh.key");
}

function getManifestPath(meshName: string): string {
  return path.join(getMeshDir(meshName), "manifest.json");
}

function getRootPublicKeyPath(meshName: string): string {
  return path.join(getMeshDir(meshName), "root.pub");
}

function getAdminMeshDir(meshName: string): string {
  return path.join(os.homedir(), ADMIN_CONFIG_DIR_NAME, meshName);
}

function getRootPrivateKeyPath(meshName: string): string {
  return path.join(getAdminMeshDir(meshName), "root.key");
}

function getNodePublicKeyPath(meshName: string): string {
  return path.join(getMeshDir(meshName), "node.pub");
}

function getNodePrivateKeyPath(meshName: string): string {
  return path.join(getMeshDir(meshName), "node.key");
}

export function loadConfig(meshName: string): MeshConfig {
  const configPath = getConfigPath(meshName);
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `Mesh "${meshName}" not found. Run "meshbot init ${meshName}" first.`
    );
  }
  const raw = fs.readFileSync(configPath, "utf-8");
  return JSON.parse(raw) as MeshConfig;
}

export function saveConfig(config: MeshConfig): void {
  const dir = getMeshDir(config.mesh);
  fs.mkdirSync(dir, { recursive: true });
  const configPath = getConfigPath(config.mesh);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
}

export function loadMeshKey(meshName: string): string {
  const keyPath = getKeyPath(meshName);
  if (!fs.existsSync(keyPath)) {
    throw new Error(
      `Mesh key not found for "${meshName}". Run "meshbot init ${meshName}" first.`
    );
  }
  return fs.readFileSync(keyPath, "utf-8").trim();
}

export function saveMeshKey(meshName: string, key: string): void {
  const dir = getMeshDir(meshName);
  fs.mkdirSync(dir, { recursive: true });
  const keyPath = getKeyPath(meshName);
  fs.writeFileSync(keyPath, key + "\n", { mode: 0o600 });
}

export function meshExists(meshName: string): boolean {
  return fs.existsSync(getConfigPath(meshName));
}

export function saveRootPublicKey(meshName: string, publicKeyPem: string): void {
  const dir = getMeshDir(meshName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(getRootPublicKeyPath(meshName), publicKeyPem.trim() + "\n", {
    mode: 0o644,
  });
}

export function loadRootPublicKey(meshName: string): string {
  const keyPath = getRootPublicKeyPath(meshName);
  if (!fs.existsSync(keyPath)) {
    throw new Error(
      `Root public key not found for "${meshName}". Run "meshbot init ${meshName}" first.`
    );
  }
  return fs.readFileSync(keyPath, "utf-8").trim();
}

export function saveRootPrivateKey(meshName: string, privateKeyPem: string): void {
  const dir = getAdminMeshDir(meshName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(getRootPrivateKeyPath(meshName), privateKeyPem.trim() + "\n", {
    mode: 0o600,
  });
}

export function loadRootPrivateKey(meshName: string): string {
  const keyPath = getRootPrivateKeyPath(meshName);
  if (!fs.existsSync(keyPath)) {
    throw new Error(
      `Root private key not found for "${meshName}". Initialize bootstrap or use "meshbot root-keygen".`
    );
  }
  return fs.readFileSync(keyPath, "utf-8").trim();
}

export function saveManifest(meshName: string, manifest: SignedEnvelope): void {
  const dir = getMeshDir(meshName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(getManifestPath(meshName), JSON.stringify(manifest, null, 2) + "\n");
}

export function loadManifest(meshName: string): SignedEnvelope {
  const manifestPath = getManifestPath(meshName);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      `Manifest not found for "${meshName}". Initialize bootstrap or publish a manifest first.`
    );
  }
  const raw = fs.readFileSync(manifestPath, "utf-8");
  return JSON.parse(raw) as SignedEnvelope;
}

export function saveNodePublicKey(meshName: string, nodePublicKey: string): void {
  const dir = getMeshDir(meshName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(getNodePublicKeyPath(meshName), nodePublicKey.trim() + "\n", {
    mode: 0o644,
  });
}

export function loadNodePublicKey(meshName: string): string {
  const keyPath = getNodePublicKeyPath(meshName);
  if (!fs.existsSync(keyPath)) {
    throw new Error(
      `Node public key not found for "${meshName}". Run "meshbot join-prepare --mesh ${meshName}".`
    );
  }
  return fs.readFileSync(keyPath, "utf-8").trim();
}

export function saveNodePrivateKey(meshName: string, nodePrivateKey: string): void {
  const dir = getMeshDir(meshName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(getNodePrivateKeyPath(meshName), nodePrivateKey.trim() + "\n", {
    mode: 0o600,
  });
}

export function createDefaultConfig(meshName: string): MeshConfig {
  return {
    mesh: meshName,
    peers: {},
    security: { ...DEFAULT_SECURITY },
  };
}

export function addPeer(
  config: MeshConfig,
  name: string,
  url: string,
  description?: string
): MeshConfig {
  const peer: PeerConfig = { url };
  if (description) peer.description = description;
  return {
    ...config,
    peers: { ...config.peers, [name]: peer },
  };
}

export function removePeer(config: MeshConfig, name: string): MeshConfig {
  const { [name]: _, ...rest } = config.peers;
  return { ...config, peers: rest };
}

export {
  getMeshDir,
  getConfigPath,
  getKeyPath,
  getManifestPath,
  getRootPublicKeyPath,
  getAdminMeshDir,
  getRootPrivateKeyPath,
  getNodePublicKeyPath,
  getNodePrivateKeyPath,
};
