import * as crypto from "node:crypto";

export function generateMeshKey(): string {
  return crypto.randomBytes(32).toString("base64");
}

export interface SigningKeyPair {
  publicKeyPem: string;
  privateKeyPem: string;
}

export interface EnrollmentKeyPair {
  publicKey: string;
  privateKey: string;
}

function exportPem(
  key: crypto.KeyObject,
  type: "spki" | "pkcs8"
): string {
  const exported = key.export({ type, format: "pem" });
  return typeof exported === "string" ? exported : exported.toString("utf-8");
}

export function generateSigningKeyPair(): SigningKeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return {
    publicKeyPem: exportPem(publicKey, "spki"),
    privateKeyPem: exportPem(privateKey, "pkcs8"),
  };
}

export function generateEnrollmentKeyPair(): EnrollmentKeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicDer = publicKey.export({ type: "spki", format: "der" });
  const privateDer = privateKey.export({ type: "pkcs8", format: "der" });
  return {
    publicKey: publicDer.toString("base64"),
    privateKey: privateDer.toString("base64"),
  };
}
