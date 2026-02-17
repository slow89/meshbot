import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import {
  createDefaultConfig,
  saveConfig,
  saveMeshKey,
  loadManifest,
  loadRootPublicKey,
  getMeshDir,
  getAdminMeshDir,
} from "../src/config/loader.js";
import { generateMeshKey } from "../src/security/keys.js";
import { setupBootstrapArtifacts } from "../src/bootstrap/setup.js";
import {
  verifyEnvelopeEd25519,
  parseEnvelopePayload,
} from "../src/security/signing.js";
import type { ManifestPayload } from "../src/config/types.js";

describe("bootstrap setup", () => {
  const createdMeshes: string[] = [];

  afterEach(() => {
    for (const meshName of createdMeshes) {
      const meshDir = getMeshDir(meshName);
      const adminDir = getAdminMeshDir(meshName);
      if (fs.existsSync(meshDir)) {
        fs.rmSync(meshDir, { recursive: true });
      }
      if (fs.existsSync(adminDir)) {
        fs.rmSync(adminDir, { recursive: true });
      }
    }
    createdMeshes.length = 0;
  });

  it("creates root keys and a signed manifest", () => {
    const meshName = `bootstrap-mesh-${Date.now()}`;
    createdMeshes.push(meshName);

    const meshKey = generateMeshKey();
    saveMeshKey(meshName, meshKey);
    const config = createDefaultConfig(meshName);
    saveConfig(config);

    const artifacts = setupBootstrapArtifacts(config, meshKey);

    expect(fs.existsSync(artifacts.rootPublicKeyPath)).toBe(true);
    expect(fs.existsSync(artifacts.rootPrivateKeyPath)).toBe(true);
    expect(fs.existsSync(artifacts.manifestPath)).toBe(true);

    const stats = fs.statSync(artifacts.rootPrivateKeyPath);
    const mode = (stats.mode & 0o777).toString(8);
    expect(mode).toBe("600");

    const manifest = loadManifest(meshName);
    const rootPublicKey = loadRootPublicKey(meshName);
    expect(verifyEnvelopeEd25519(manifest, rootPublicKey)).toBe(true);

    const payload = parseEnvelopePayload(manifest) as ManifestPayload;
    expect(payload.v).toBe(1);
    expect(payload.mesh).toBe(meshName);
    expect(payload.version).toBe(1);
    expect(payload.transport.meshKey).toBe(meshKey);
  });
});
