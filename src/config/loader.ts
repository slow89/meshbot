import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  type MeshConfig,
  type PeerConfig,
  DEFAULT_SECURITY,
  CONFIG_DIR_NAME,
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

export { getMeshDir, getConfigPath, getKeyPath };
