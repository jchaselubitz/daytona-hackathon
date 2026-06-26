/**
 * Typed API client (B1). Built entirely from the contract's `ROUTES` +
 * request/response types so it can't drift from the server. Every call resolves
 * its path with `buildPath`; bodies/returns use `@app/shared` types.
 */
import {
  buildPath,
  type Artifact,
  type Automation,
  type AutomationRun,
  type ApiError,
  type ChatGptConnectStatusResponse,
  type CreateChatSessionResponse,
  type CreateWorkspaceRequest,
  type FileManifestEntry,
  type RunAutomationRequest,
  type SendChatMessageRequest,
  type StartChatGptConnectResponse,
  type UploadFilesResponse,
  type Workspace,
} from "@app/shared";

// VITE_API_BASE ends in "/api"; ROUTES paths already include "/api", so we use
// the bare origin and let buildPath supply the path.
const ORIGIN = import.meta.env.VITE_API_BASE.replace(/\/api\/?$/, "");

export class ApiClientError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

async function call<T>(
  method: string,
  path: string,
  opts: { body?: unknown; form?: FormData } = {},
): Promise<T> {
  const init: RequestInit = { method, headers: {} };
  if (opts.form) {
    init.body = opts.form;
  } else if (opts.body !== undefined) {
    (init.headers as Record<string, string>)["content-type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }
  const res = await fetch(`${ORIGIN}${path}`, init);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const err = (data as ApiError | undefined)?.error;
    throw new ApiClientError(
      res.status,
      err?.code ?? "error",
      err?.message ?? res.statusText,
      err?.details,
    );
  }
  return data as T;
}

export const api = {
  // Health
  health: () => call<{ ok: boolean; ts: string }>("GET", "/api/health"),

  // Workspaces
  createWorkspace: (body: CreateWorkspaceRequest) =>
    call<Workspace>("POST", buildPath("createWorkspace"), { body }),
  listWorkspaces: () => call<Workspace[]>("GET", buildPath("listWorkspaces")),
  getWorkspace: (id: string) => call<Workspace>("GET", buildPath("getWorkspace", { id })),
  retryWorkspaceProvision: (id: string) =>
    call<Workspace>("POST", buildPath("retryWorkspaceProvision", { id })),
  deleteWorkspace: (id: string) => call<void>("DELETE", buildPath("deleteWorkspace", { id })),

  // Files
  uploadFiles: (id: string, files: File[]) => {
    const form = new FormData();
    for (const f of files) form.append("files", f, f.name);
    return call<UploadFilesResponse>("POST", buildPath("uploadFiles", { id }), { form });
  },
  listFiles: (id: string) => call<FileManifestEntry[]>("GET", buildPath("listFiles", { id })),

  // ChatGPT connect
  startChatGptConnect: (id: string) =>
    call<StartChatGptConnectResponse>("POST", buildPath("startChatGptConnect", { id })),
  chatGptConnectStatus: (id: string) =>
    call<ChatGptConnectStatusResponse>("GET", buildPath("chatGptConnectStatus", { id })),
  setApiKey: (id: string, openaiApiKey: string) =>
    call<void>("POST", buildPath("setApiKey", { id }), { body: { openaiApiKey } }),

  // Chat
  createChatSession: (id: string) =>
    call<CreateChatSessionResponse>("POST", buildPath("createChatSession", { id })),
  sendChatMessage: (id: string, body: SendChatMessageRequest) =>
    call<{ accepted: true }>("POST", buildPath("sendChatMessage", { id }), { body }),

  // Automations & runs
  listAutomations: (id: string) =>
    call<Automation[]>("GET", buildPath("listAutomations", { id })),
  runAutomation: (id: string, automationId: string, body: RunAutomationRequest) =>
    call<AutomationRun>("POST", buildPath("runAutomation", { id, automationId }), { body }),
  reproduceAutomation: (id: string, automationId: string, body: RunAutomationRequest) =>
    call<AutomationRun>("POST", buildPath("reproduceAutomation", { id, automationId }), { body }),
  getRun: (runId: string) => call<AutomationRun>("GET", buildPath("getRun", { runId })),
  listRunArtifacts: (runId: string) =>
    call<Artifact[]>("GET", buildPath("listRunArtifacts", { runId })),
  downloadArtifactUrl: (artifactId: string) =>
    `${ORIGIN}${buildPath("downloadArtifact", { artifactId })}`,
};
