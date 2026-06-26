/**
 * CODE CONTRACT — single source of truth shared by `apps/web` and `apps/server`.
 *
 * This file defines the seams that let the frontend, control-plane server, and
 * infra workstreams be built in parallel. Treat everything exported here as a
 * stable interface: changes require updating BOTH consumers and the contract doc
 * at `docs/code-contract.md`.
 *
 * Nothing in this file performs I/O. It is types + constants only.
 *
 * Versioned so consumers can assert compatibility.
 */
export const CONTRACT_VERSION = "1.0.0" as const;

// ============================================================================
// Sandbox filesystem + network layout (the agent/infra contract)
// ============================================================================

/** Canonical paths inside every Daytona sandbox. The server and the snapshot
 *  image MUST agree on these. */
export const SANDBOX_PATHS = {
  root: "/workspace",
  knowledge: "/workspace/knowledge", // uploaded knowledgebase files
  automations: "/workspace/automations", // generated/captured scripts
  artifacts: "/workspace/artifacts", // run outputs, per run id
  auth: "/root/.local/share/opencode/auth.json", // opencode/codex tokens
} as const;

/** opencode serve listens here inside the sandbox; the server reaches it via a
 *  Daytona preview URL guarded by OPENCODE_SERVER_PASSWORD. */
export const OPENCODE_PORT = 4096 as const;

// ============================================================================
// Domain entities (mirror the Postgres schema in db/schema.sql)
// ============================================================================

export type WorkspaceState =
  | "creating" // sandbox being provisioned
  | "starting" // opencode serve booting
  | "ready" // usable
  | "stopped" // sandbox stopped/archived
  | "error";

export interface Workspace {
  id: string; // uuid
  userId: string;
  name: string;
  daytonaSandboxId: string | null;
  snapshotDigest: string; // pinned base image digest — reproducibility anchor
  state: WorkspaceState;
  chatgptConnected: boolean; // derived: encrypted_auth_blob present & valid
  createdAt: string; // ISO 8601
}

export type AuthMode = "chatgpt-oauth" | "openai-api-key";

export interface FileManifestEntry {
  id: string;
  workspaceId: string;
  relPath: string; // path under SANDBOX_PATHS.knowledge
  sha256: string;
  size: number; // bytes
  mime: string;
  storageKey: string; // key in object storage (canonical copy)
  createdAt: string;
}

/** The reproducible unit. Source + how to install + how to run + what env. */
export interface AutomationManifest {
  schema: "automation.manifest/v1";
  name: string;
  version: string; // semver-ish, bumped per capture
  runtime: "python" | "node";
  entrypoint: string; // rel path under the bundle, e.g. "main.py"
  /** Dependency files relative to the bundle root, e.g. ["requirements.txt"]. */
  dependencyFiles: string[];
  /** Idempotent setup commands run before the entrypoint (install from lockfiles). */
  setup: string[];
  /** Declared inputs the run requires. */
  inputs: AutomationInput[];
  /** Base snapshot digest this bundle was authored against. */
  snapshotDigest: string;
}

export interface AutomationInput {
  key: string;
  type: "string" | "number" | "boolean" | "file";
  required: boolean;
  description?: string;
}

export interface Automation {
  id: string;
  workspaceId: string;
  name: string;
  version: string;
  entrypoint: string;
  manifest: AutomationManifest;
  storageKey: string; // bundle archive in object storage
  createdAt: string;
}

export type RunStatus = "queued" | "running" | "succeeded" | "failed";

export interface AutomationRun {
  id: string;
  automationId: string;
  workspaceId: string;
  status: RunStatus;
  inputs: Record<string, string | number | boolean>;
  startedAt: string | null;
  finishedAt: string | null;
  logsKey: string | null; // object storage key for combined logs
}

export interface Artifact {
  id: string;
  runId: string;
  relPath: string; // path under SANDBOX_PATHS.artifacts/<runId>
  sha256: string;
  size: number;
  contentType: string;
  storageKey: string;
  createdAt: string;
}

// ============================================================================
// REST API contract — all under API_BASE. JSON unless noted.
// MVP auth: single demo user; `X-User-Id` header optional, server defaults it.
// ============================================================================

export const API_BASE = "/api" as const;

/** Uniform error envelope returned for any non-2xx. */
export interface ApiError {
  error: { code: string; message: string; details?: unknown };
}

// ---- Workspaces ----
export interface CreateWorkspaceRequest {
  name: string;
}
export type CreateWorkspaceResponse = Workspace;
export type ListWorkspacesResponse = Workspace[];
export type GetWorkspaceResponse = Workspace;

// ---- Files / knowledgebase ----
// Upload is multipart/form-data: field `files` (one or more). Response below.
export interface UploadFilesResponse {
  uploaded: FileManifestEntry[];
}
export type ListFilesResponse = FileManifestEntry[];

// ---- Connect ChatGPT (device-code OAuth) ----
export interface StartChatGptConnectResponse {
  mode: AuthMode;
  // present when mode === "chatgpt-oauth":
  verificationUrl?: string; // user opens this in their own browser
  userCode?: string; // user enters this code
  expiresInSec?: number;
}
export interface ChatGptConnectStatusResponse {
  connected: boolean;
  pending: boolean;
}
// API-key fallback:
export interface SetApiKeyRequest {
  openaiApiKey: string;
}

// ---- Chat ----
export interface CreateChatSessionResponse {
  sessionId: string; // opencode session id, relayed to the WS
}
export interface SendChatMessageRequest {
  sessionId: string;
  text: string;
}
// Server responds 202; assistant output streams over the WebSocket below.
export interface SendChatMessageResponse {
  accepted: true;
}

// ---- Automations & runs ----
export type ListAutomationsResponse = Automation[];
export interface RunAutomationRequest {
  inputs?: Record<string, string | number | boolean>;
}
export type RunAutomationResponse = AutomationRun;
export type GetRunResponse = AutomationRun;
export type ListRunArtifactsResponse = Artifact[];
// Reproduce a bundle on a fresh sandbox (manual MVP trigger).
export interface ReproduceAutomationRequest {
  automationId: string;
}
export type ReproduceAutomationResponse = AutomationRun;

/** Canonical route table. Keep paths here so client + server can't drift. */
export const ROUTES = {
  createWorkspace: "POST /api/workspaces",
  listWorkspaces: "GET /api/workspaces",
  getWorkspace: "GET /api/workspaces/:id",
  deleteWorkspace: "DELETE /api/workspaces/:id",

  uploadFiles: "POST /api/workspaces/:id/files",
  listFiles: "GET /api/workspaces/:id/files",

  startChatGptConnect: "POST /api/workspaces/:id/chatgpt/connect",
  chatGptConnectStatus: "GET /api/workspaces/:id/chatgpt/status",
  setApiKey: "POST /api/workspaces/:id/chatgpt/api-key",

  createChatSession: "POST /api/workspaces/:id/chat/sessions",
  sendChatMessage: "POST /api/workspaces/:id/chat/messages",

  listAutomations: "GET /api/workspaces/:id/automations",
  runAutomation: "POST /api/workspaces/:id/automations/:automationId/run",
  reproduceAutomation: "POST /api/workspaces/:id/automations/:automationId/reproduce",

  getRun: "GET /api/runs/:runId",
  listRunArtifacts: "GET /api/runs/:runId/artifacts",
  downloadArtifact: "GET /api/artifacts/:artifactId/download", // streams bytes
} as const;

// ============================================================================
// WebSocket contract — chat relay (server <-> browser)
// ============================================================================
// Browser connects to: WS_PATH?workspaceId=<id>
// The server holds ONE SSE connection to opencode /event per workspace and
// relays normalized events below. The browser never talks to the sandbox.

export const WS_PATH = "/ws" as const;

/** Messages the browser sends to the server. */
export type ClientToServer =
  | { type: "subscribe"; sessionId: string }
  | { type: "unsubscribe"; sessionId: string }
  | { type: "ping" };

/** Messages the server sends to the browser. Normalized from opencode SSE. */
export type ServerToClient =
  | { type: "connected"; workspaceId: string }
  | {
      type: "message.delta";
      sessionId: string;
      messageId: string;
      role: "assistant" | "user";
      text: string; // incremental text chunk
    }
  | {
      type: "message.completed";
      sessionId: string;
      messageId: string;
    }
  | {
      type: "tool.update";
      sessionId: string;
      tool: string;
      status: "running" | "completed" | "error";
      summary?: string;
    }
  | { type: "session.status"; sessionId: string; status: "idle" | "working" }
  | { type: "error"; message: string }
  | { type: "pong" };

// ============================================================================
// Storage interface — implemented by FS adapter now, S3/MinIO later.
// Lives in apps/server but the shape is part of the contract so adapters swap.
// ============================================================================
export interface StoragePutOptions {
  contentType?: string;
}
export interface Storage {
  put(key: string, body: Buffer | NodeJS.ReadableStream, opts?: StoragePutOptions): Promise<void>;
  get(key: string): Promise<NodeJS.ReadableStream>;
  head(key: string): Promise<{ size: number; contentType?: string } | null>;
  delete(key: string): Promise<void>;
  /** A URL the browser can download from. FS adapter proxies via the API. */
  signedDownloadUrl(key: string, expiresInSec?: number): Promise<string>;
}
