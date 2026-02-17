import * as crypto from "node:crypto";
import type { MeshMessage } from "../queue/message-queue.js";
import { signMessage, generateNonce } from "../security/signing.js";
import type { BootstrapHead, SignedEnvelope } from "../config/types.js";

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

export interface BootstrapJoinResponse {
  ok: boolean;
  mesh: string;
  agent: string;
  now: number;
  manifest: SignedEnvelope;
  sync: {
    headUrl: string;
    manifestUrlTemplate: string;
    intervalSeconds: number;
  };
}

function normalizeUrl(peerUrl: string): string {
  return peerUrl.replace(/\/$/, "");
}

export async function joinMeshBootstrap(
  peerUrl: string,
  token: string,
  nodePubKey: string
): Promise<BootstrapJoinResponse> {
  const url = `${normalizeUrl(peerUrl)}/mesh/bootstrap/join`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, nodePubKey }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Bootstrap join failed: ${String(response.status)} ${errorBody}`);
  }

  return (await response.json()) as BootstrapJoinResponse;
}

export async function fetchBootstrapHead(
  peerUrl: string,
  meshKey: string
): Promise<BootstrapHead> {
  const url = `${normalizeUrl(peerUrl)}/mesh/bootstrap/head`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${meshKey}`,
    },
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Bootstrap head fetch failed: ${String(response.status)} ${errorBody}`);
  }

  return (await response.json()) as BootstrapHead;
}

export async function fetchBootstrapManifest(
  peerUrl: string,
  meshKey: string,
  version: number | "latest"
): Promise<SignedEnvelope> {
  const url = `${normalizeUrl(peerUrl)}/mesh/bootstrap/manifest/${String(version)}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${meshKey}`,
    },
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Manifest fetch failed: ${String(response.status)} ${errorBody}`);
  }

  return (await response.json()) as SignedEnvelope;
}
