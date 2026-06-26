# MVP Engineering Plan — Agentic Workflows in Daytona Sandboxes

**Status:** Draft for review
**Date:** 2026-06-26
**Audience:** Engineering / founders review

---

## 1. Product in one paragraph

We let **non-technical users** run **agentic work** on their own files inside a
secure, disposable cloud computer (a **Daytona sandbox**). A user uploads a
knowledgebase, signs the agent into their **ChatGPT** account, and then chats
with a Codex CLI agent that can read those files, write and run
**automation scripts**, and produce **artifacts** (reports, exports, parsed
data). Configuration, scripts, and artifacts live in our own database/storage
**outside** the sandbox, so a workflow can be **reproduced from scratch** on a
fresh sandbox at any time, and the user can **download** their outputs.

For the MVP, the **frontend + control-plane server run in one local container**;
the database and object storage are local too. The architecture is designed so
that the DB and server can later be lifted into a hosted cloud backend without
reworking the sandbox/agent layer.

---

## 2. Core design decisions (and the "figure out how to" items)

| Open question from the brief | MVP decision |
|---|---|
| Smooth ChatGPT login inside the sandbox via OAuth | Use Codex's device-code flow. The control plane triggers `codex login --device-auth` in the sandbox, captures the verification URL + user code, and renders them in the React UI. The user approves in *their own* browser. Tokens persist in `auth.json`, which we back up (encrypted) to the DB for reproducibility. |
| Chat between the agent and React | Run **`codex exec`** inside the sandbox for each web chat turn. The control plane launches Codex through the Daytona process API and relays normalized output to the browser over WebSocket. The browser never talks to the sandbox directly. |
| Necessary sandbox packages (PDF parsing, etc.) | Bake them into a **pinned Daytona snapshot** (custom OCI image): node, python, Codex CLI, and parsing tooling (`poppler-utils`, `pdfplumber`/`pypdf`, `pandoc`, `tesseract` later). The snapshot digest is the unit of reproducibility. |
| DB outside Daytona for config + automation scripts | **Postgres** (local for MVP, hosted later) holds users, workspaces, file manifests, automation bundles, artifact index, and encrypted auth blobs. |
| Artifacts stored on the server | Sandbox writes outputs to a known `artifacts/` dir; control plane collects them into **object storage** (local filesystem / MinIO for MVP, S3 later) and indexes them in Postgres. React downloads via the control plane. |
| Automations reproducible from scratch on a new sandbox | An **automation is a versioned bundle**: entrypoint + source files + a dependency manifest + the base snapshot digest + required inputs. Reproduce = create sandbox from the same snapshot → hydrate knowledgebase + bundle → restore deps → run. (Details in §7.) |

---

## 3. Architecture overview

```
                         Browser (non-technical user)
                                   │  HTTPS + WebSocket
                                   ▼
        ┌───────────────────────────────────────────────────┐
        │              CONTROL PLANE (local container)        │
        │                                                     │
        │   React frontend  ──serves──►  browser              │
        │                                                     │
        │   API server (Node/TS)                              │
        │     • Auth & workspace mgmt                          │
        │     • Daytona lifecycle (SDK)                        │
        │     • Codex CLI runner (process → WS)                │
        │     • File/artifact ingest + serve                  │
        │     • Automation bundle store                        │
        │                                                     │
        │   Postgres   ◄── config, scripts, manifests, tokens │
        │   Object store (FS/MinIO) ◄── files + artifacts     │
        └───────────────────────────────────────────────────┘
                                   │  Daytona SDK (create/exec/fs)
                                   │
                                   ▼
        ┌───────────────────────────────────────────────────┐
        │   DAYTONA SANDBOX  (per workspace, from snapshot)   │
        │                                                     │
        │   codex exec                                        │
        │     • model = user's ChatGPT (Codex OAuth)          │
        │   /workspace/knowledge   ← uploaded files           │
        │   /workspace/automations ← generated scripts        │
        │   /workspace/artifacts   ← outputs                  │
        │   System pkgs: pdf tooling, python, node            │
        └───────────────────────────────────────────────────┘
```

**Why the control plane is the only Codex caller:** non-technical users should
never see sandbox processes, tokens, or raw command output. Centralizing the
execution also lets us record transcripts and later fan out to multiple
sandboxes.

---

## 4. Component responsibilities & tech choices

- **Frontend:** React + TypeScript (Vite). Views: Workspace list, File/knowledgebase manager, Chat (streamed), Automations list, Artifacts/downloads, "Connect ChatGPT" flow.
- **API server:** Node + TypeScript (Fastify or Express). Chosen because Daytona ships a first-class TS SDK and the web/server contract is TypeScript. WebSocket via `ws`/socket.io for chat relay.
- **Database:** Postgres (via Prisma or Drizzle). Local Docker for MVP.
- **Object storage:** Local filesystem volume for MVP, abstracted behind a small `Storage` interface so S3/MinIO is a drop-in later.
- **Sandbox runtime:** Daytona, sandboxes created from a **pinned custom snapshot** built via the Daytona declarative image builder.
- **Agent:** Codex CLI (`codex exec`) inside the sandbox, authenticated to the user's ChatGPT via `codex login --device-auth`.

---

## 5. Key flows

### 5.1 Create a workspace
1. User clicks "New workspace."
2. API server calls Daytona SDK → create sandbox from pinned snapshot digest.
3. Server records `workspace { id, daytona_sandbox_id, snapshot_digest, state }`.
4. Server verifies Codex CLI is available in the sandbox.

### 5.2 Upload knowledgebase
1. User drops files in React → multipart upload to API server.
2. Server stores **canonical copies in object storage** and writes a `file_manifest` row per file (path, sha256, size, mime).
3. Server pushes files into the sandbox at `/workspace/knowledge/...` via Daytona fs API.
4. Canonical copy in object storage is what makes a fresh sandbox re-hydratable (reproducibility).

### 5.3 Connect ChatGPT (OAuth)
1. User clicks "Connect ChatGPT."
2. Server runs `codex login --device-auth` in the sandbox and parses the **verification URL + user code** from its output.
3. React shows "Go to `<url>`, enter code `XXXX-YYYY`, approve." User completes in their own browser/account.
4. Codex writes tokens to `auth.json` in the sandbox. Server reads it back, **encrypts** it, and stores it on the workspace (`encrypted_auth_blob`).
5. On a fresh sandbox we restore `auth.json` from this blob; we re-run the device flow only when tokens are expired/revoked.

> **Risk to validate early:** token lifetime/refresh behavior and ToS for using a personal ChatGPT subscription via OAuth in a server-side sandbox. See §9. Provide an **API-key fallback** path.

### 5.4 Chat
1. React opens a WebSocket to the API server for the workspace.
2. User message → server → Daytona process command running `codex exec` in `/workspace`.
3. Codex reads `knowledge/`, may write to `automations/` and `artifacts/`, and the server relays normalized completion/status events back over WebSocket.

### 5.5 Capture & run automations
1. When the agent writes scripts under `/workspace/automations/<name>/`, the server detects/commits them into an **automation bundle** (source + `manifest.json`) in Postgres + object storage.
2. "Run automation" → server executes the bundle's entrypoint in the sandbox (Daytona exec) with declared inputs.
3. Outputs land in `/workspace/artifacts/<run-id>/`.

### 5.6 Collect & download artifacts
1. After a run, server pulls `artifacts/<run-id>/` out of the sandbox into object storage and writes `artifact` rows (run id, path, size, sha256, content-type).
2. React lists artifacts per workspace/run; "Download" streams from the server (or a signed URL once we move to S3).

---

## 6. Data model (sketch)

```
users(id, email, created_at)
workspaces(id, user_id, daytona_sandbox_id, snapshot_digest,
           state, encrypted_auth_blob, created_at)
file_manifest(id, workspace_id, rel_path, sha256, size, mime, storage_key)
automations(id, workspace_id, name, version, entrypoint,
            manifest_json, storage_key, created_at)
automation_runs(id, automation_id, status, started_at, finished_at, logs_key)
artifacts(id, run_id, rel_path, sha256, size, content_type, storage_key)
```

`storage_key` points into object storage; everything else is queryable metadata.

---

## 7. Reproducibility model (the hard requirement)

An automation must re-run **from scratch on a brand-new sandbox**. We achieve
this by making every input to a run explicit and versioned:

1. **Environment** — pinned base **snapshot digest** (OS, runtimes, PDF tooling). Stored on the workspace/bundle. Never "latest."
2. **Code** — the automation's source files, stored in object storage + Postgres.
3. **Dependencies** — a `manifest.json` declaring runtime (`python`/`node`), dependency files (`requirements.txt` / `package.json`), and a deterministic `setup` step. We instruct Codex (via AGENTS.md) to **write any new dependency into these manifest files** rather than installing ad-hoc, so deps are captured, not lost.
4. **Inputs** — the knowledgebase files (canonical copies in object storage) plus any declared run parameters.
5. **Identity** — restored `auth.json` (or API key) so the agent/model is available.

**Reproduce procedure:**
```
create sandbox(snapshot_digest)
→ restore auth.json
→ hydrate /workspace/knowledge from object storage
→ write automation bundle to /workspace/automations/<name>
→ run manifest.setup (idempotent: pip/npm install from lockfiles)
→ exec manifest.entrypoint with inputs
→ collect /workspace/artifacts
```

**Stretch (post-MVP):** after a successful run, snapshot the sandbox into a new
Daytona snapshot and pin *that* digest to the bundle — captures even
undeclared system state. MVP relies on the declared manifest + base snapshot,
which is good enough for script-level workflows.

---

## 8. MVP scope — in vs. out

**In (MVP):**
- One user, local container, local Postgres + filesystem storage.
- Create/destroy one sandbox per workspace from a pinned snapshot.
- Upload knowledgebase; hydrate into sandbox.
- Connect ChatGPT via headless device flow (with API-key fallback).
- Chat through Codex CLI with WebSocket-delivered status and final response.
- Capture a generated automation as a bundle; run it; collect + download artifacts.
- Reproduce a bundle on a fresh sandbox (manual trigger).

**Out / later:**
- Multi-tenant auth, billing, RBAC.
- Hosted cloud backend, S3, autoscaling sandboxes, sandbox pooling/warm pool.
- Auto-snapshotting after runs; scheduled/cron automations.
- OCR-heavy parsing, large-file streaming, virus scanning.
- Real-time collaboration / sharing.

---

## 9. Risks & things to validate first (spikes)

1. **ChatGPT OAuth viability (highest risk).** Confirm the headless device-code flow works inside a Daytona sandbox end-to-end, token lifetime/refresh, and acceptable-use for server-side sandbox usage of a personal subscription. **Mitigation:** ship an **OpenAI API-key** path in parallel so the product works regardless.
2. **Codex process execution.** Confirm `codex exec` works reliably through the Daytona process API, returns final output, and writes artifacts in `/workspace`.
3. **Snapshot build + cold-start time.** Measure sandbox create time from the custom snapshot; decide if a warm pool is needed even for the demo.
4. **Dependency capture discipline.** Validate that prompting Codex to record deps into manifest files is reliable enough for reproducibility, or whether we need the post-run snapshot fallback sooner.
5. **Secret handling.** `auth.json` and any API keys must be encrypted at rest and never sent to the browser.

> Recommend doing spikes #1 and #2 **before** committing to the full milestone plan, since both could change the architecture.

---

## 10. Milestones (hackathon-oriented)

- **M0 — Spikes (½–1 day):** Stand up Codex CLI in a Daytona sandbox; complete one ChatGPT device-code login; run one message through `codex exec`. De-risks #1 and #2.
- **M1 — Skeleton (1 day):** Local container with React + API server + Postgres + filesystem storage. Create/list/destroy a workspace (Daytona SDK). Health checks.
- **M2 — Chat (1 day):** Codex→WS relay; React chat UI showing agent output; "Connect ChatGPT" UI driving the device flow.
- **M3 — Files & automations (1 day):** Knowledgebase upload + hydrate; capture a generated automation bundle; run it; collect artifacts; download in React.
- **M4 — Reproducibility (½–1 day):** Reproduce a bundle on a fresh sandbox from stored snapshot + manifest + files. Demo the full loop.
- **M5 — Polish:** Error states, reconnects, empty/loading UX for non-technical users, secret encryption pass.

---

## 11. Open questions for the review

1. **Identity model:** single demo user for the hackathon, or real multi-user auth from day one?
2. **ChatGPT vs API key:** is using personal ChatGPT subscriptions a hard product requirement, or is an OpenAI API key acceptable for MVP (much simpler, no OAuth risk)?
3. **Sandbox lifecycle:** one long-lived sandbox per workspace, or ephemeral (create-on-demand, destroy-after-idle)? Affects cost and the reproducibility UX.
4. **Automation definition:** are automations authored *only* by the agent, or should users also pick from templates we ship?
5. **Artifact size/retention:** expected max artifact sizes and how long we keep them — drives storage and download design.
6. **Which parsing tools** beyond PDF do we bake into the snapshot for the demo (docx, xlsx, OCR)?

---

## 12. Suggested repo layout

```
/apps
  /web          React (Vite) frontend
  /server       Node/TS control plane (API, relay, Daytona + Codex runner)
/packages
  /shared       shared types and route contracts
/infra
  /snapshot     Daytona declarative image (Dockerfile/manifest + pinned deps)
  docker-compose.yml   web + server + postgres + (minio later)
/docs
  mvp-engineering-plan.md   ← this document
```

---

**Sources consulted for technical grounding:**
[OpenAI Codex CLI](https://github.com/openai/codex) ·
[Daytona Sandboxes](https://www.daytona.io/docs/en/sandboxes/) ·
[Daytona Snapshots](https://www.daytona.io/docs/en/snapshots/) ·
[Daytona TypeScript SDK](https://www.daytona.io/docs/en/typescript-sdk/daytona/)
