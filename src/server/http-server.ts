import express from "express";
import * as http from "node:http";
import * as https from "node:https";
import * as fs from "node:fs";
import { createAuthMiddleware } from "./auth.js";
import { createRoutes } from "./routes.js";
import type { MessageQueue } from "../queue/message-queue.js";
import type { TlsConfig } from "../config/types.js";

export interface HttpServerOptions {
  agentName: string;
  meshName?: string;
  port: number;
  host: string;
  meshKey: string;
  queue: MessageQueue;
  replayWindowSeconds: number;
  maxMessageSizeBytes: number;
  tls?: TlsConfig;
  dev?: boolean;
  onAskReceived?: (
    fromAgent: string,
    messageId: string,
    payload: string
  ) => void;
  onMessageReceived?: (
    fromAgent: string,
    messageId: string,
    payload: string
  ) => void;
}

export interface HttpServer {
  server: http.Server | https.Server;
  port: number;
  close: () => Promise<void>;
}

export async function startHttpServer(
  options: HttpServerOptions
): Promise<HttpServer> {
  const app = express();

  app.use(express.json({ limit: `${String(options.maxMessageSizeBytes)}b` }));

  // Auth middleware for mesh routes (not health)
  const authMiddleware = createAuthMiddleware(
    options.meshKey,
    options.replayWindowSeconds,
    options.maxMessageSizeBytes
  );

  // Health is unauthenticated (just returns agent name + status)
  const routes = createRoutes(
    options.agentName,
    options.queue,
    options.meshName ? { meshName: options.meshName } : undefined,
    options.onAskReceived,
    options.onMessageReceived
  );

  // Apply auth to mesh routes except health
  app.use(
    "/mesh",
    (req, res, next) => {
      if (req.path === "/health" && req.method === "GET") {
        next();
        return;
      }
      if (req.path === "/bootstrap/join" && req.method === "POST") {
        next();
        return;
      }
      authMiddleware(req, res, next);
    },
    routes
  );

  let server: http.Server | https.Server;

  if (options.tls && !options.dev) {
    server = https.createServer(
      {
        cert: fs.readFileSync(options.tls.cert),
        key: fs.readFileSync(options.tls.key),
        ca: options.tls.ca ? fs.readFileSync(options.tls.ca) : undefined,
        rejectUnauthorized: options.tls.rejectUnauthorized ?? true,
      },
      app
    );
  } else {
    server = http.createServer(app);
  }

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(options.port, options.host, () => {
      const addr = server.address();
      const actualPort =
        typeof addr === "object" && addr ? addr.port : options.port;
      resolve({
        server,
        port: actualPort,
        close: () =>
          new Promise<void>((closeResolve) => {
            server.close(() => { closeResolve(); });
          }),
      });
    });
  });
}
