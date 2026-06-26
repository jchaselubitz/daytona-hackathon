/**
 * Control-plane server entrypoint (A1).
 *
 * Fastify HTTP API (routes.ts) + WebSocket relay (ws.ts) in one process. Reads
 * config from env (.env.example). Serves the contract under /api and /ws.
 */
import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import type { WebSocket } from "ws";
import { WS_PATH } from "@app/shared";
import { loadEnv } from "./env.js";
import { HttpError } from "./errors.js";
import { registerRoutes } from "./routes.js";
import { WsHub } from "./ws.js";
import { opencodeClientForWorkspace } from "./services/workspaces.js";
import { closePool } from "./db.js";

async function main(): Promise<void> {
  const env = loadEnv();
  const app = Fastify({ logger: { level: env.nodeEnv === "production" ? "info" : "debug" } });

  await app.register(cors, { origin: env.webOrigin, credentials: true });
  await app.register(multipart, { limits: { fileSize: 100 * 1024 * 1024 } }); // 100MB/file
  await app.register(websocket);

  // Uniform ApiError envelope for every non-2xx.
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) {
      reply.code(err.statusCode).send(err.toEnvelope());
      return;
    }
    app.log.error(err);
    const e = err as { statusCode?: number; message?: string };
    const status = e.statusCode ?? 500;
    reply.code(status).send({
      error: { code: status === 500 ? "internal" : "error", message: e.message ?? "error" },
    });
  });

  app.setNotFoundHandler((_req, reply) => {
    reply.code(404).send({ error: { code: "not_found", message: "route not found" } });
  });

  // WebSocket relay: one hub, one SSE connection per workspace.
  const hub = new WsHub(opencodeClientForWorkspace);
  await app.register(async (scoped) => {
    scoped.get(WS_PATH, { websocket: true }, (socket: WebSocket, req) => {
      const workspaceId = (req.query as { workspaceId?: string }).workspaceId;
      if (!workspaceId) {
        socket.send(JSON.stringify({ type: "error", message: "workspaceId query param required" }));
        socket.close();
        return;
      }
      hub.addClient(workspaceId, socket);
    });
  });

  await registerRoutes(app);

  const shutdown = async () => {
    hub.shutdown();
    await app.close();
    await closePool();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  await app.listen({ port: env.serverPort, host: "0.0.0.0" });
  app.log.info(`server listening on :${env.serverPort}`);
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
