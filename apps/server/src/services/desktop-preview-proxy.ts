/**
 * Proxies noVNC preview traffic through the control plane so the web app can
 * embed the remote desktop in an iframe without hitting Daytona's preview
 * warning interstitial (that page breaks inside cross-origin iframes).
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import WebSocketClient from "ws";
import type { Sandbox } from "@daytona/sdk";
import { DESKTOP_NOVNC_PORT } from "@app/shared";
import { loadEnv } from "../env.js";
import { notFound } from "../errors.js";
import { getSandbox } from "../daytona.js";
import { getWorkspaceRow } from "./workspaces.js";

const PREVIEW_TTL_SEC = 3600;
const SKIP_WARNING_HEADER = "X-Daytona-Skip-Preview-Warning";
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);
const STRIP_FOR_EMBED = new Set([
  "content-security-policy",
  "content-security-policy-report-only",
  "x-frame-options",
]);

/** iframe src — same-origin with the API so Daytona warning cookies are not involved. */
export function desktopPreviewEmbedUrl(workspaceId: string): string {
  const env = loadEnv();
  const wsPath = `/api/workspaces/${workspaceId}/desktop/preview/websockify`;
  const params = new URLSearchParams({
    autoconnect: "true",
    resize: "scale",
    path: wsPath,
  });
  return `${env.serverPublicUrl}/api/workspaces/${workspaceId}/desktop/preview/?${params}`;
}

function rewritePreviewBody({
  body,
  contentType,
  workspaceId,
}: {
  body: Buffer;
  contentType: string | null | undefined;
  workspaceId: string;
}): Buffer {
  const ct = contentType?.toLowerCase() ?? "";
  if (!ct.includes("text/html") && !ct.includes("javascript") && !ct.includes("json")) {
    return body;
  }
  const wsPath = `/api/workspaces/${workspaceId}/desktop/preview/websockify`;
  const text = body
    .toString("utf8")
    .replaceAll('"/websockify"', `"${wsPath}"`)
    .replaceAll("'/websockify'", `'${wsPath}'`)
    .replaceAll('path=websockify', `path=${wsPath}`)
    .replaceAll('path=/websockify', `path=${wsPath}`);
  return Buffer.from(text);
}

async function sandboxFor(workspaceId: string): Promise<Sandbox> {
  const ws = await getWorkspaceRow(workspaceId);
  if (!ws.daytona_sandbox_id) throw notFound(`workspace ${workspaceId} has no sandbox yet`);
  return getSandbox(ws.daytona_sandbox_id);
}

async function signedPreviewBase(sandbox: Sandbox): Promise<URL> {
  const preview = await sandbox.getSignedPreviewUrl(DESKTOP_NOVNC_PORT, PREVIEW_TTL_SEC);
  const target = new URL(preview.url);
  if ("token" in preview && preview.token) {
    target.searchParams.set("token", String(preview.token));
  }
  return target;
}

function mergePreviewTarget({
  base,
  subPath,
  query,
}: {
  base: URL;
  subPath: string;
  query: URLSearchParams;
}): URL {
  const target = new URL(base.toString());
  const normalized = subPath.replace(/^\/+/, "");
  target.pathname = normalized ? `/${normalized}` : target.pathname || "/";
  for (const [key, value] of query.entries()) {
    if (key === "token") continue;
    target.searchParams.set(key, value);
  }
  return target;
}

function previewSubPath(req: FastifyRequest): string {
  const wildcard = (req.params as Record<string, string>)["*"] ?? "";
  return wildcard.replace(/^\/+/, "");
}

function previewQuery(req: FastifyRequest): URLSearchParams {
  const idx = req.url.indexOf("?");
  return new URLSearchParams(idx === -1 ? "" : req.url.slice(idx + 1));
}

async function previewTargetUrl(req: FastifyRequest, workspaceId: string): Promise<URL> {
  const sandbox = await sandboxFor(workspaceId);
  const base = await signedPreviewBase(sandbox);
  return mergePreviewTarget({
    base,
    subPath: previewSubPath(req),
    query: previewQuery(req),
  });
}

/** HTTP(S) proxy for noVNC static assets and the initial HTML shell. */
export async function proxyDesktopPreviewHttp(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const workspaceId = (req.params as Record<string, string>).id!;
  const target = await previewTargetUrl(req, workspaceId);

  const headers: Record<string, string> = {
    [SKIP_WARNING_HEADER]: "true",
  };
  if (req.headers.accept) headers.accept = String(req.headers.accept);
  if (req.headers["accept-language"]) {
    headers["accept-language"] = String(req.headers["accept-language"]);
  }

  const upstream = await fetch(target, { headers, redirect: "manual" });

  reply.code(upstream.status);
  upstream.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower) || STRIP_FOR_EMBED.has(lower)) return;
    reply.header(key, value);
  });

  const body = rewritePreviewBody({
    body: Buffer.from(await upstream.arrayBuffer()),
    contentType: upstream.headers.get("content-type"),
    workspaceId,
  });
  reply.send(body);
}

/** WebSocket proxy for noVNC's websockify connection. */
export async function proxyDesktopPreviewWs(
  workspaceId: string,
  client: WebSocket,
  req: FastifyRequest,
): Promise<void> {
  const sandbox = await sandboxFor(workspaceId);
  const base = await signedPreviewBase(sandbox);
  const target = new URL(base.toString());
  target.pathname = "/websockify";

  const wsUrl = target.toString().replace(/^http/i, "ws");

  const upstream = new WebSocketClient(wsUrl, {
    headers: { [SKIP_WARNING_HEADER]: "true" },
  });

  const closeQuietly = (socket: WebSocket) => {
    try {
      socket.close();
    } catch {
      /* already closed */
    }
  };

  upstream.on("open", () => {
    client.on("message", (data, isBinary) => {
      if (upstream.readyState === WebSocketClient.OPEN) {
        upstream.send(data, { binary: isBinary });
      }
    });
    upstream.on("message", (data, isBinary) => {
      if (client.readyState === WebSocketClient.OPEN) {
        client.send(data, { binary: isBinary });
      }
    });
  });

  upstream.on("error", (err) => {
    console.error(`[desktop-preview] websockify upstream error for ${workspaceId}:`, err);
    closeQuietly(client);
  });

  client.on("close", () => closeQuietly(upstream));
  upstream.on("close", () => closeQuietly(client));
  client.on("error", () => closeQuietly(upstream));
}
