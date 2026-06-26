# Code Contract — Agentic Workflows in Daytona

**Status:** v1.0.0 · **Date:** 2026-06-26 · Pairs with
[`mvp-engineering-plan.md`](./mvp-engineering-plan.md) and
[`execution-checklist.md`](./execution-checklist.md).

This is the **shared boundary** the workstreams build against so they can work in
parallel without blocking each other. The machine-readable source of truth is
[`packages/shared/src/contract.ts`](../packages/shared/src/contract.ts) and
[`db/schema.sql`](../db/schema.sql). **This doc explains and freezes those
seams.** Any change to a seam = PR that updates the type/SQL **and** both
consumers **and** this doc, plus a bump of `CONTRACT_VERSION`.

---

## 0. Workstreams (how the work divides)

| Stream | Owns | Builds against (does NOT change unilaterally) |
|---|---|---|
| **A. Server / control plane** (`apps/server`) | REST API, WS relay, Daytona lifecycle, opencode client, Storage adapter, DB access | `contract.ts` types, `ROUTES`, WS protocol, `db/schema.sql`, `SANDBOX_PATHS` |
| **B. Web / frontend** (`apps/web`) | React UI, API client, WS client, all views | `ROUTES`, request/response types, `ClientToServer`/`ServerToClient`, `ApiError` |
| **C. Infra / sandbox** (`infra/`, `db/`) | Daytona snapshot image, docker compose, Postgres init, MinIO | `SANDBOX_PATHS`, `OPENCODE_PORT`, env var names, `db/schema.sql` |
| **D. Shared** (`packages/shared`) | The contract itself + generated opencode OpenAPI client | n/a — this is the contract |

Rule of thumb: **import types, never redefine them.** Both `apps/web` and
`apps/server` import from `@app/shared`.

---

## 1. Sandbox layout contract (Stream A ↔ C)

From `SANDBOX_PATHS` and `OPENCODE_PORT` in `contract.ts`:

- `/workspace/knowledge` — uploaded knowledgebase files (hydrated by server).
- `/workspace/automations/<name>/` — generated/captured scripts (a bundle).
- `/workspace/artifacts/<run-id>/` — run outputs the server collects.
- `auth.json` — opencode/codex tokens; server backs it up encrypted.
- `opencode serve` listens on **:4096**, reached via a Daytona **preview URL**
  guarded by `OPENCODE_SERVER_PASSWORD`. The browser never connects directly.

The snapshot image (Stream C) MUST provide: node, python3 + pip, `opencode`, and
PDF tooling (`poppler-utils`, `pypdf`/`pdfplumber`, `pandoc`). The pinned
**snapshot digest** is the reproducibility anchor and is stored per workspace.

---

## 2. REST API contract (Stream A ↔ B)

All routes live in `ROUTES` (`contract.ts`) under `/api`. JSON in/out except
file upload (multipart) and artifact download (byte stream). Errors use the
`ApiError` envelope with a stable `code`. MVP auth: single demo user; the server
defaults `X-User-Id` to the seeded demo user.

| Purpose | Route | Request → Response |
|---|---|---|
| Create workspace | `POST /api/workspaces` | `CreateWorkspaceRequest` → `Workspace` |
| List workspaces | `GET /api/workspaces` | → `Workspace[]` |
| Get workspace | `GET /api/workspaces/:id` | → `Workspace` |
| Delete workspace | `DELETE /api/workspaces/:id` | → `204` |
| Upload files | `POST /api/workspaces/:id/files` | multipart `files` → `UploadFilesResponse` |
| List files | `GET /api/workspaces/:id/files` | → `FileManifestEntry[]` |
| Start ChatGPT connect | `POST /api/workspaces/:id/chatgpt/connect` | → `StartChatGptConnectResponse` |
| ChatGPT status | `GET /api/workspaces/:id/chatgpt/status` | → `ChatGptConnectStatusResponse` |
| API-key fallback | `POST /api/workspaces/:id/chatgpt/api-key` | `SetApiKeyRequest` → `204` |
| Create chat session | `POST /api/workspaces/:id/chat/sessions` | → `CreateChatSessionResponse` |
| Send chat message | `POST /api/workspaces/:id/chat/messages` | `SendChatMessageRequest` → `202 SendChatMessageResponse` |
| List automations | `GET /api/workspaces/:id/automations` | → `Automation[]` |
| Run automation | `POST /api/workspaces/:id/automations/:automationId/run` | `RunAutomationRequest` → `AutomationRun` |
| Reproduce on fresh sandbox | `POST /api/workspaces/:id/automations/:automationId/reproduce` | `ReproduceAutomationRequest` → `AutomationRun` |
| Get run | `GET /api/runs/:runId` | → `AutomationRun` |
| List run artifacts | `GET /api/runs/:runId/artifacts` | → `Artifact[]` |
| Download artifact | `GET /api/artifacts/:artifactId/download` | → byte stream (`Content-Disposition`) |

**Chat is async:** `POST .../chat/messages` returns `202` immediately; assistant
output arrives over the WebSocket (§3). This keeps streaming in one channel.

---

## 3. WebSocket contract (Stream A ↔ B)

Browser connects to `WS_PATH` (`/ws`) with `?workspaceId=<id>`. The server keeps
**one** SSE connection to opencode `/event` per workspace and normalizes events.

- Client → server: `ClientToServer` (`subscribe` / `unsubscribe` / `ping`).
- Server → client: `ServerToClient` — `connected`, `message.delta`,
  `message.completed`, `tool.update`, `session.status`, `error`, `pong`.

The frontend renders incremental text from `message.delta` keyed by `messageId`
and finalizes on `message.completed`. `tool.update` drives a "the agent is doing
X" indicator. Heartbeat: client sends `ping` ~25s; server replies `pong`.

---

## 4. Database contract (Stream A ↔ C)

`db/schema.sql` is authoritative. Tables: `users`, `workspaces`, `file_manifest`,
`automations`, `automation_runs`, `artifacts`. Column names/types there map 1:1
to the entities in `contract.ts` (snake_case in SQL ↔ camelCase in TS). The
server owns reads/writes; infra owns provisioning + the seeded demo user.

---

## 5. Storage contract (Stream A)

`Storage` interface in `contract.ts`. MVP ships a **filesystem adapter**
(`signedDownloadUrl` returns a server-proxied URL); a MinIO/S3 adapter drops in
later without touching callers. Object keys are server-chosen and opaque; only
`storage_key` columns reference them.

Suggested key conventions (server-internal, not part of the wire contract):
`files/<workspaceId>/<sha256>`, `bundles/<automationId>/<version>.tar.gz`,
`artifacts/<runId>/<relPath>`, `logs/<runId>.log`.

---

## 6. Automation bundle + reproducibility contract (Stream A)

A captured automation = an archive containing source + `manifest.json` matching
`AutomationManifest` (`automation.manifest/v1`). The manifest pins `runtime`,
`entrypoint`, `dependencyFiles`, idempotent `setup` (install from lockfiles),
declared `inputs`, and the `snapshotDigest` it was authored against.

**Reproduce** (`/reproduce`) = create sandbox from `snapshotDigest` → restore
`auth.json` → hydrate `/workspace/knowledge` from object storage → unpack bundle
to `/workspace/automations/<name>` → run `setup` → exec `entrypoint` → collect
`/workspace/artifacts/<run-id>`. See plan §7.

To keep deps captured, the sandbox's `AGENTS.md` instructs opencode to write new
dependencies into the declared `dependencyFiles` rather than installing ad hoc.

---

## 7. Environment contract (all streams)

Variable names are frozen in [`.env.example`](../.env.example). Add a variable
there in the same PR that introduces its use. Secrets (`DAYTONA_API_KEY`,
`OPENAI_API_KEY`, `AUTH_ENCRYPTION_KEY`, `OPENCODE_SERVER_PASSWORD`) never reach
the browser and are read only by `apps/server`.

---

## 8. Change protocol

1. Edit `packages/shared/src/contract.ts` and/or `db/schema.sql`.
2. Bump `CONTRACT_VERSION` (semver: breaking = major).
3. Update this doc's affected section.
4. Update both consumers in the same PR; CI typechecks `@app/shared` consumers.
