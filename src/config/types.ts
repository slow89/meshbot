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

export const DEFAULT_SECURITY: SecurityConfig = {
  replayWindowSeconds: 60,
  maxMessageSizeBytes: 1_048_576,
};

export const DEFAULT_PORT = 9820;
export const CONFIG_DIR_NAME = ".mesh";
