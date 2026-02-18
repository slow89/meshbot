import * as crypto from "node:crypto";
import type { InviteTokenPayload } from "../config/types.js";
import { canonicalizeJson } from "../security/signing.js";

export interface InviteTokenVerification {
  ok: boolean;
  payload?: InviteTokenPayload;
  error?: string;
}

function encodeBase64Url(input: Buffer): string {
  return input.toString("base64url");
}

function decodeBase64Url(input: string): Buffer {
  return Buffer.from(input, "base64url");
}

function isInviteTokenPayload(value: unknown): value is InviteTokenPayload {
  if (typeof value !== "object" || value === null) return false;
  const data = value as Record<string, unknown>;
  return (
    data["v"] === 1 &&
    typeof data["mesh"] === "string" &&
    typeof data["agent"] === "string" &&
    typeof data["nodePubKey"] === "string" &&
    typeof data["jti"] === "string" &&
    typeof data["iat"] === "number" &&
    typeof data["nbf"] === "number" &&
    typeof data["exp"] === "number" &&
    (data["minManifestVersion"] === undefined || typeof data["minManifestVersion"] === "number") &&
    (data["seedHints"] === undefined || Array.isArray(data["seedHints"]))
  );
}

export function createInviteToken(
  payload: InviteTokenPayload,
  rootPrivateKeyPem: string
): string {
  const payloadJson = canonicalizeJson(payload);
  const payloadBytes = Buffer.from(payloadJson, "utf-8");
  const signature = crypto.sign(null, payloadBytes, rootPrivateKeyPem);
  return `${encodeBase64Url(payloadBytes)}.${encodeBase64Url(signature)}`;
}

export function verifyInviteToken(
  token: string,
  rootPublicKeyPem: string
): InviteTokenVerification {
  const [payloadPart, sigPart, ...rest] = token.split(".");
  if (!payloadPart || !sigPart || rest.length > 0) {
    return { ok: false, error: "Malformed token" };
  }

  let payloadBytes: Buffer;
  let signature: Buffer;
  try {
    payloadBytes = decodeBase64Url(payloadPart);
    signature = decodeBase64Url(sigPart);
  } catch {
    return { ok: false, error: "Malformed token encoding" };
  }

  let validSignature: boolean;
  try {
    validSignature = crypto.verify(null, payloadBytes, rootPublicKeyPem, signature);
  } catch {
    return { ok: false, error: "Invalid root public key format" };
  }
  if (!validSignature) {
    return { ok: false, error: "Invalid token signature" };
  }

  let payloadUnknown: unknown;
  try {
    payloadUnknown = JSON.parse(payloadBytes.toString("utf-8")) as unknown;
  } catch {
    return { ok: false, error: "Malformed token payload JSON" };
  }

  if (!isInviteTokenPayload(payloadUnknown)) {
    return { ok: false, error: "Invalid token payload" };
  }

  return { ok: true, payload: payloadUnknown };
}

export function parseDurationToMs(duration: string): number {
  const match = duration.trim().match(/^(\d+)([smhd])$/);
  if (!match) {
    throw new Error(
      `Invalid duration "${duration}". Use formats like 30s, 15m, 2h, 1d.`
    );
  }

  const valueRaw = match[1];
  const unit = match[2];
  if (!valueRaw || !unit) {
    throw new Error(`Invalid duration "${duration}"`);
  }
  const value = Number.parseInt(valueRaw, 10);
  switch (unit) {
    case "s":
      return value * 1000;
    case "m":
      return value * 60 * 1000;
    case "h":
      return value * 60 * 60 * 1000;
    case "d":
      return value * 24 * 60 * 60 * 1000;
    default:
      throw new Error("Unsupported duration unit: " + unit);
  }
}
