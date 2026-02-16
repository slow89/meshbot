import * as crypto from "node:crypto";
import type { MeshMessage } from "../queue/message-queue.js";
import { signMessage, generateNonce } from "../security/signing.js";

export interface SendOptions {
  from: string;
  to: string;
  peerUrl: string;
  payload: string;
  meshKey: string;
  type: "message" | "ask" | "response";
  replyTo?: string;
}

function buildMessage(opts: SendOptions): MeshMessage {
  const id = crypto.randomUUID();
  const timestamp = Date.now();
  const nonce = generateNonce();
  const hmac = signMessage(opts.meshKey, {
    id,
    type: opts.type,
    payload: opts.payload,
    timestamp,
    nonce,
  });

  return {
    id,
    from: opts.from,
    to: opts.to,
    type: opts.type,
    payload: opts.payload,
    replyTo: opts.replyTo,
    timestamp,
    nonce,
    hmac,
  };
}

function endpointForType(
  type: "message" | "ask" | "response"
): string {
  switch (type) {
    case "message":
      return "/mesh/msg";
    case "ask":
      return "/mesh/ask";
    case "response":
      return "/mesh/response";
  }
}

export async function sendMeshMessage(
  opts: SendOptions
): Promise<{ success: boolean; messageId: string; data?: unknown }> {
  const msg = buildMessage(opts);
  const endpoint = endpointForType(opts.type);
  const url = `${opts.peerUrl.replace(/\/$/, "")}${endpoint}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.meshKey}`,
    },
    body: JSON.stringify(msg),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `Failed to send ${opts.type} to ${opts.to}: ${String(response.status)} ${errorBody}`
    );
  }

  const data: unknown = await response.json();
  return { success: true, messageId: msg.id, data };
}

export async function checkPeerHealth(
  peerUrl: string
): Promise<{
  online: boolean;
  agent?: string;
  timestamp?: number;
}> {
  try {
    const url = `${peerUrl.replace(/\/$/, "")}/mesh/health`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return { online: false };
    const data = (await response.json()) as {
      agent: string;
      status: string;
      timestamp: number;
    };
    return {
      online: data.status === "online",
      agent: data.agent,
      timestamp: data.timestamp,
    };
  } catch {
    return { online: false };
  }
}
