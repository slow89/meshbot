export interface PeerConfig {
  url: string;
  description?: string;
}

export interface TlsConfig {
  cert: string;
  key: string;
  ca?: string;
  rejectUnauthorized?: boolean;
}

export interface SecurityConfig {
  replayWindowSeconds: number;
  maxMessageSizeBytes: number;
}

export interface MeshConfig {
  mesh: string;
  peers: Record<string, PeerConfig>;
  tls?: TlsConfig;
  security: SecurityConfig;
}

export interface SignedEnvelope {
  alg: "Ed25519";
  kid: string;
  payload: string;
  sig: string;
}

export interface ManifestPayload {
  v: 1;
  mesh: string;
  version: number;
  issuedAt: string;
  security: SecurityConfig;
  transport: {
    meshKey: string;
  };
  agents: Record<string, PeerConfig>;
  revocations: {
    inviteJti: string[];
    agents: string[];
  };
}

export interface BootstrapHead {
  mesh: string;
  version: number;
  manifestHash: string;
  issuedAt: string;
}

export interface InviteTokenPayload {
  v: 1;
  mesh: string;
  agent: string;
  nodePubKey: string;
  jti: string;
  iat: number;
  nbf: number;
  exp: number;
  minManifestVersion?: number;
  seedHints?: string[];
}

export const DEFAULT_SECURITY: SecurityConfig = {
  replayWindowSeconds: 60,
  maxMessageSizeBytes: 1_048_576,
};

export const DEFAULT_PORT = 9820;
export const CONFIG_DIR_NAME = ".mesh";
export const ADMIN_CONFIG_DIR_NAME = ".mesh-admin";
