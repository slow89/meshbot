import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
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
import { generateMeshKey } from "../src/security/keys.js";

describe("config", () => {
  const testMesh = `test-mesh-${Date.now()}`;
  const meshDir = path.join(os.homedir(), ".mesh", testMesh);

  afterEach(() => {
    // Cleanup test files
    if (fs.existsSync(meshDir)) {
      fs.rmSync(meshDir, { recursive: true });
    }
  });

  it("creates and loads config", () => {
    const config = createDefaultConfig(testMesh);
    saveConfig(config);
    expect(meshExists(testMesh)).toBe(true);

    const loaded = loadConfig(testMesh);
    expect(loaded.mesh).toBe(testMesh);
    expect(loaded.peers).toEqual({});
  });

  it("throws on missing mesh", () => {
    expect(() => loadConfig("nonexistent-mesh")).toThrow("not found");
  });

  it("saves and loads mesh key", () => {
    const key = generateMeshKey();
    saveMeshKey(testMesh, key);

    const loaded = loadMeshKey(testMesh);
    expect(loaded).toBe(key);
  });

  it("key file has restricted permissions", () => {
    const key = generateMeshKey();
    saveMeshKey(testMesh, key);

    const keyPath = path.join(meshDir, "mesh.key");
    const stats = fs.statSync(keyPath);
    const mode = (stats.mode & 0o777).toString(8);
    expect(mode).toBe("600");
  });

  it("adds and removes peers", () => {
    let config = createDefaultConfig(testMesh);
    config = addPeer(config, "agent-a", "https://a.example.com:9820", "Agent A");
    config = addPeer(config, "agent-b", "https://b.example.com:9821");

    expect(Object.keys(config.peers)).toEqual(["agent-a", "agent-b"]);
    expect(config.peers["agent-a"]!.url).toBe("https://a.example.com:9820");
    expect(config.peers["agent-a"]!.description).toBe("Agent A");
    expect(config.peers["agent-b"]!.description).toBeUndefined();

    config = removePeer(config, "agent-a");
    expect(Object.keys(config.peers)).toEqual(["agent-b"]);
  });

  it("round-trips config with peers", () => {
    let config = createDefaultConfig(testMesh);
    config = addPeer(config, "prod-ops", "https://prod:9820", "Production");
    config = addPeer(config, "dev", "https://dev:9821", "Development");
    saveConfig(config);

    const loaded = loadConfig(testMesh);
    expect(loaded.peers["prod-ops"]!.url).toBe("https://prod:9820");
    expect(loaded.peers["dev"]!.description).toBe("Development");
  });
});
