import * as crypto from "node:crypto";

export function generateMeshKey(): string {
  return crypto.randomBytes(32).toString("base64");
}
