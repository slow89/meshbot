import { describe, it, expect } from "vitest";
import { generateSigningKeyPair } from "../src/security/keys.js";
import {
  createInviteToken,
  parseDurationToMs,
  verifyInviteToken,
} from "../src/bootstrap/invite.js";

describe("invite tokens", () => {
  it("creates and verifies invite tokens", () => {
    const { privateKeyPem, publicKeyPem } = generateSigningKeyPair();
    const now = Date.now();
    const token = createInviteToken(
      {
        v: 1,
        mesh: "test-mesh",
        agent: "qa-bot",
        nodePubKey: "node-public-key",
        jti: "invite-1",
        iat: now,
        nbf: now,
        exp: now + 60_000,
      },
      privateKeyPem
    );

    const verified = verifyInviteToken(token, publicKeyPem);
    expect(verified.ok).toBe(true);
    expect(verified.payload?.mesh).toBe("test-mesh");
    expect(verified.payload?.agent).toBe("qa-bot");
  });

  it("rejects invalid token signatures", () => {
    const signer = generateSigningKeyPair();
    const other = generateSigningKeyPair();
    const token = createInviteToken(
      {
        v: 1,
        mesh: "test-mesh",
        agent: "qa-bot",
        nodePubKey: "node-public-key",
        jti: "invite-2",
        iat: Date.now(),
        nbf: Date.now(),
        exp: Date.now() + 60_000,
      },
      signer.privateKeyPem
    );

    const verified = verifyInviteToken(token, other.publicKeyPem);
    expect(verified.ok).toBe(false);
  });

  it("round-trips optional seed hints and min manifest version", () => {
    const { privateKeyPem, publicKeyPem } = generateSigningKeyPair();
    const token = createInviteToken(
      {
        v: 1,
        mesh: "test-mesh",
        agent: "qa-bot",
        nodePubKey: "node-public-key",
        jti: "invite-3",
        iat: Date.now(),
        nbf: Date.now(),
        exp: Date.now() + 60_000,
        minManifestVersion: 4,
        seedHints: ["https://seed-1.example.com:9820", "https://seed-2.example.com:9820"],
      },
      privateKeyPem
    );

    const verified = verifyInviteToken(token, publicKeyPem);
    expect(verified.ok).toBe(true);
    expect(verified.payload?.minManifestVersion).toBe(4);
    expect(verified.payload?.seedHints).toEqual([
      "https://seed-1.example.com:9820",
      "https://seed-2.example.com:9820",
    ]);
  });
});

describe("duration parser", () => {
  it("parses supported units", () => {
    expect(parseDurationToMs("30s")).toBe(30_000);
    expect(parseDurationToMs("15m")).toBe(900_000);
    expect(parseDurationToMs("2h")).toBe(7_200_000);
    expect(parseDurationToMs("1d")).toBe(86_400_000);
  });

  it("throws for invalid values", () => {
    expect(() => parseDurationToMs("15")).toThrow("Invalid duration");
    expect(() => parseDurationToMs("abc")).toThrow("Invalid duration");
  });
});
