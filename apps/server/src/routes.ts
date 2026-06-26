/**
 * REST routes (Streams A↔B). Registered straight from the contract's `ROUTES`
 * table via `parseRoute` so the server can't drift from the client. Every path
 * here matches a `ROUTES` entry; handlers map 1:1 to the request/response types.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  parseRoute,
  type CreateWorkspaceRequest,
  type SetApiKeyRequest,
  type StartDesktopRequest,
  type OpenDesktopUrlRequest,
  type SendChatMessageRequest,
  type RunAutomationRequest,
} from "@app/shared";
import { badRequest } from "./errors.js";
import {
  createWorkspace,
  deleteWorkspace,
  getWorkspace,
  listWorkspaces,
} from "./services/workspaces.js";
import { listFiles, uploadFiles, type IncomingFile } from "./services/files.js";
import { apiKeyStatus, setApiKey } from "./services/secrets.js";
import { getDesktop, startDesktop, stopDesktop, openDesktopUrl } from "./services/desktop.js";
import {
  proxyDesktopPreviewHttp,
  proxyDesktopPreviewWs,
} from "./services/desktop-preview-proxy.js";
import { createChatSession, sendChatMessage } from "./services/chat.js";
import {
  getArtifactRow,
  getRun,
  listAutomations,
  listRunArtifacts,
  reproduceAutomation,
  runAutomation,
} from "./services/automations.js";
import { getStorage } from "./storage/index.js";
import type { WsHub } from "./ws.js";

type Params = Record<string, string>;

export async function registerRoutes(app: FastifyInstance, hub: WsHub): Promise<void> {
  // Health (not in ROUTES; always available).
  app.get("/api/health", async () => ({ ok: true, ts: new Date().toISOString() }));

  const route = (key: Parameters<typeof parseRoute>[0]) => parseRoute(key);

  // ---- Workspaces ----
  app.post(route("createWorkspace").path, async (req) => {
    const body = req.body as CreateWorkspaceRequest;
    if (!body?.name?.trim()) throw badRequest("name is required");
    return createWorkspace(body.name.trim());
  });
  app.get(route("listWorkspaces").path, async () => listWorkspaces());
  app.get(route("getWorkspace").path, async (req) =>
    getWorkspace((req.params as Params).id!),
  );
  app.delete(route("deleteWorkspace").path, async (req, reply) => {
    await deleteWorkspace((req.params as Params).id!);
    reply.code(204);
    return null;
  });

  // ---- Files / knowledgebase ----
  app.post(route("uploadFiles").path, async (req) => {
    const files = await collectMultipart(req);
    if (files.length === 0) throw badRequest("no files in upload (field 'files')");
    const uploaded = await uploadFiles((req.params as Params).id!, files);
    return { uploaded };
  });
  app.get(route("listFiles").path, async (req) => listFiles((req.params as Params).id!));

  // ---- Secrets: OpenAI API key (the only auth path) ----
  app.post(route("setApiKey").path, async (req, reply) => {
    const body = req.body as SetApiKeyRequest;
    await setApiKey((req.params as Params).id!, body?.openaiApiKey ?? "");
    reply.code(204);
    return null;
  });
  app.get(route("apiKeyStatus").path, async (req) =>
    apiKeyStatus((req.params as Params).id!),
  );

  // ---- Remote desktop (browser-embedded noVNC view of the sandbox) ----
  app.get(route("getDesktop").path, async (req) => getDesktop((req.params as Params).id!));
  app.post(route("startDesktop").path, async (req) => {
    const body = req.body as StartDesktopRequest | undefined;
    return startDesktop((req.params as Params).id!, body?.url);
  });
  app.post(route("stopDesktop").path, async (req) => stopDesktop((req.params as Params).id!));
  app.post(route("openDesktopUrl").path, async (req) => {
    const body = req.body as OpenDesktopUrlRequest | undefined;
    if (!body?.url) throw badRequest("missing 'url' in request body");
    return openDesktopUrl((req.params as Params).id!, body.url);
  });

  // Proxied noVNC embed (skips Daytona preview warning for iframe usage).
  const previewPath = "/api/workspaces/:id/desktop/preview";
  app.route({
    method: "GET",
    url: previewPath,
    handler: async (req, reply) => proxyDesktopPreviewHttp(req, reply),
  });
  app.route({
    method: "GET",
    url: `${previewPath}/*`,
    handler: async (req, reply) => proxyDesktopPreviewHttp(req, reply),
    wsHandler: (socket, req) => {
      const workspaceId = (req.params as Params).id!;
      void proxyDesktopPreviewWs(workspaceId, socket, req);
    },
  });

  // ---- Chat (async; output streams over the WebSocket) ----
  app.post(route("createChatSession").path, async (req) => {
    const sessionId = await createChatSession((req.params as Params).id!);
    return { sessionId };
  });
  app.post(route("sendChatMessage").path, async (req, reply) => {
    const body = req.body as SendChatMessageRequest;
    if (!body?.sessionId || !body?.text) throw badRequest("sessionId and text are required");
    await sendChatMessage((req.params as Params).id!, body.sessionId, body.text, hub);
    reply.code(202);
    return { accepted: true };
  });

  // ---- Automations & runs ----
  app.get(route("listAutomations").path, async (req) =>
    listAutomations((req.params as Params).id!),
  );
  app.post(route("runAutomation").path, async (req) => {
    const p = req.params as Params;
    const body = (req.body ?? {}) as RunAutomationRequest;
    return runAutomation(p.id!, p.automationId!, body.inputs ?? {});
  });
  app.post(route("reproduceAutomation").path, async (req) => {
    const p = req.params as Params;
    const body = (req.body ?? {}) as RunAutomationRequest;
    return reproduceAutomation(p.id!, p.automationId!, body.inputs ?? {});
  });
  app.get(route("getRun").path, async (req) => getRun((req.params as Params).runId!));
  app.get(route("listRunArtifacts").path, async (req) =>
    listRunArtifacts((req.params as Params).runId!),
  );

  // ---- Artifact download (byte stream) ----
  app.get(route("downloadArtifact").path, async (req, reply) => {
    const artifact = await getArtifactRow((req.params as Params).artifactId!);
    const stream = await getStorage().get(artifact.storage_key);
    const filename = artifact.rel_path.split("/").pop() ?? "artifact";
    reply.header("content-type", artifact.content_type);
    reply.header("content-disposition", `attachment; filename="${filename}"`);
    return reply.send(stream);
  });

  // ---- Internal storage proxy (backs FsStorage.signedDownloadUrl) ----
  app.get("/api/storage/*", async (req, reply) => {
    const key = decodeURIComponent((req.params as Record<string, string>)["*"] ?? "");
    if (!key) throw badRequest("missing storage key");
    const head = await getStorage().head(key);
    if (!head) throw badRequest("unknown storage key");
    const stream = await getStorage().get(key);
    if (head.contentType) reply.header("content-type", head.contentType);
    return reply.send(stream);
  });
}

/** Pull files out of a multipart/form-data request into memory buffers. */
async function collectMultipart(req: FastifyRequest): Promise<IncomingFile[]> {
  const out: IncomingFile[] = [];
  const parts = (req as FastifyRequest & { parts: () => AsyncIterableIterator<MultipartPart> }).parts();
  for await (const part of parts) {
    if (part.type === "file") {
      const buffer = await streamToBuffer(part.file);
      out.push({
        filename: part.filename,
        buffer,
        mime: part.mimetype || "application/octet-stream",
      });
    }
  }
  return out;
}

interface MultipartPart {
  type: "file" | "field";
  filename: string;
  mimetype: string;
  file: NodeJS.ReadableStream;
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

// Avoid unused-import lint for FastifyReply in some configs.
export type { FastifyReply };
