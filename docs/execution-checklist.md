# Execution Checklist — Build the MVP

**Status:** First execution pass complete — see [`build-status.md`](./build-status.md)
for per-step state (the whole stack builds + runs under docker compose; only the
live Daytona/ChatGPT paths await Phase-0 spikes). · **Date:** 2026-06-26 ·
Pairs with [`mvp-engineering-plan.md`](./mvp-engineering-plan.md) and
[`code-contract.md`](./code-contract.md).

Each step is a discrete, agent-actionable unit with a **Done-when** acceptance
check. Steps are grouped by the four workstreams from the contract (A server,
B web, C infra, D shared). The **dependency markers** let work proceed in
parallel — anything not blocked can start immediately.

Legend: `[ ]` todo · `→ depends on` · everything builds against
[`packages/shared/src/contract.ts`](../packages/shared/src/contract.ts).

---

## Phase 0 — Spikes (de-risk before committing; plan §9)

- [ ] **S1 — opencode in a sandbox.** Manually create a Daytona sandbox from a
  base image, run `opencode serve` on :4096, reach it over a preview URL with
  `OPENCODE_SERVER_PASSWORD`, and `curl` the SSE `/event` stream.
  **Done-when:** one prompt round-trips and SSE events print to a terminal.
- [ ] **S2 — ChatGPT device-code login.** Run the headless device flow inside the
  sandbox; capture verification URL + user code; approve in a browser; confirm
  `auth.json` is written and a model call succeeds.
  **Done-when:** an opencode prompt answers using the ChatGPT account. Record
  token lifetime. If blocked, fall back to `OPENAI_API_KEY` and note it.

> Do not start Phase 2+ until S1 and S2 are understood; they can change the API.

---

## Phase 1 — Foundations (unblocks everyone)

### Stream D — shared
- [ ] **D1.** Scaffold `packages/shared` (TS, ESM) exporting `contract.ts` as
  `@app/shared`. Add build + typecheck. **Done-when:** `apps/web` and
  `apps/server` can `import { ROUTES } from "@app/shared"`.
- [ ] **D2.** Generate a typed opencode client from its OpenAPI spec into
  `packages/shared` (or server-local). **Done-when:** client compiles.

### Stream C — infra  → none
- [ ] **C1.** Add monorepo tooling (pnpm workspaces) with `apps/*`,
  `packages/*`. **Done-when:** `pnpm -r build` runs.
- [ ] **C2.** Author `infra/snapshot/` Daytona declarative image: node, python3
  + pip, `opencode`, PDF tooling (`poppler-utils`, `pypdf`/`pdfplumber`,
  `pandoc`). Build it, **record the digest**, set `DAYTONA_SNAPSHOT_DIGEST` in
  `.env`. **Done-when:** a sandbox from the digest has all tools on PATH.
- [ ] **C3.** Add `AGENTS.md` baked into the snapshot instructing opencode to
  record new deps into `dependencyFiles` (reproducibility; contract §6).
- [ ] **C4.** Wire `docker-compose.yml` + `db/schema.sql` (done) and add minimal
  `apps/server/Dockerfile` + `apps/web/Dockerfile`. **Done-when:**
  `docker compose up` brings Postgres healthy and both app containers build.

### Stream A — server  → D1, C4
- [ ] **A1.** Scaffold `apps/server` (Fastify/Express + `ws`). Health route
  `GET /api/health`. Load env per `.env.example`. **Done-when:** `/api/health`
  returns 200 in compose.
- [ ] **A2.** DB access layer (Prisma/Drizzle) bound to `db/schema.sql`.
  **Done-when:** server reads the seeded demo user.
- [ ] **A3.** `Storage` FS adapter implementing the contract interface.
  **Done-when:** put/get/head/delete + `signedDownloadUrl` round-trip on disk.

### Stream B — web  → D1
- [ ] **B1.** Scaffold `apps/web` (Vite + React + TS). Typed API client and WS
  client generated from `ROUTES` / `ClientToServer`/`ServerToClient`.
  **Done-when:** app boots, calls `/api/health`, shows status.

---

## Phase 2 — Workspaces & sandbox lifecycle

### Stream A  → A1, A2, C2
- [ ] **A4.** Daytona lifecycle service: create sandbox from
  `DAYTONA_SNAPSHOT_DIGEST`, start `opencode serve`, poll health, persist
  `workspaces` row + state machine (`creating→starting→ready`). Implement
  `POST/GET/DELETE /api/workspaces`. **Done-when:** create returns a `ready`
  `Workspace`; delete tears the sandbox down.

### Stream B  → B1, A4
- [ ] **B2.** Workspace list + "New workspace" + detail view with live state.
  **Done-when:** user creates and sees a workspace go `ready`.

---

## Phase 3 — Knowledgebase

### Stream A  → A3, A4
- [ ] **A5.** `POST /api/workspaces/:id/files` (multipart): store canonical copy
  via `Storage`, write `file_manifest`, push into `/workspace/knowledge` via
  Daytona fs API. `GET .../files` lists. **Done-when:** uploaded file appears in
  the sandbox and in the manifest with sha256.

### Stream B  → B2, A5
- [ ] **B3.** Drag-and-drop file manager (upload, list, sizes). **Done-when:**
  non-technical user can upload and see files.

---

## Phase 4 — Connect ChatGPT

### Stream A  → A4, S2
- [ ] **A6.** `POST .../chatgpt/connect`: run headless device flow in sandbox,
  parse verification URL + user code, return them; `GET .../chatgpt/status`
  polls; on success read `auth.json`, encrypt with `AUTH_ENCRYPTION_KEY`, store
  `encrypted_auth_blob`. Implement `POST .../chatgpt/api-key` fallback.
  **Done-when:** status flips to connected and a chat works.

### Stream B  → B2, A6
- [ ] **B4.** "Connect ChatGPT" UI: show URL + code, poll status, success state;
  API-key fallback form. **Done-when:** user completes connect in their browser.

---

## Phase 5 — Streamed chat

### Stream A  → A4, A6, D2
- [ ] **A7.** SSE→WS relay: one SSE connection to opencode `/event` per
  workspace, normalize to `ServerToClient`, fan out over `/ws`. Implement
  `POST .../chat/sessions` and `POST .../chat/messages` (202; output via WS).
  **Done-when:** a message streams token-by-token to a WS client.

### Stream B  → B1, A7
- [ ] **B5.** Chat view: send message, render `message.delta` by `messageId`,
  finalize on `message.completed`, show `tool.update` activity, reconnect on
  drop. **Done-when:** user chats and watches the agent work live.

---

## Phase 6 — Automations & artifacts

### Stream A  → A5, A7
- [ ] **A8.** Capture: when the agent writes under `/workspace/automations/<name>/`,
  build a bundle (source + `manifest.json` per `AutomationManifest`), store
  archive + `automations` row. `GET .../automations` lists. **Done-when:** a
  generated script becomes a listed, versioned bundle.
- [ ] **A9.** Run: `POST .../automations/:id/run` execs `setup` then `entrypoint`
  in the sandbox with inputs; write `automation_runs`; collect
  `/workspace/artifacts/<run-id>` into `Storage`; write `artifacts` rows.
  `GET /api/runs/:runId` + `/artifacts`; `GET /api/artifacts/:id/download`
  streams bytes. **Done-when:** run produces a downloadable artifact.

### Stream B  → B2, A8, A9
- [ ] **B6.** Automations list + Run button (input form from `manifest.inputs`).
- [ ] **B7.** Artifacts list per run with working Download. **Done-when:** user
  runs an automation and downloads its output.

---

## Phase 7 — Reproducibility (the hard requirement; plan §7)

### Stream A  → A8, A9
- [ ] **A10.** `POST .../automations/:id/reproduce`: create a **fresh** sandbox
  from the bundle's `snapshotDigest` → restore `auth.json` → hydrate knowledge
  from object storage → unpack bundle → run `setup` → exec `entrypoint` →
  collect artifacts. **Done-when:** the same bundle reproduces equivalent
  artifacts on a brand-new sandbox.

### Stream B  → B6, A10
- [ ] **B8.** "Reproduce" action + run history. **Done-when:** user reproduces a
  past automation from the UI and downloads fresh artifacts.

---

## Phase 8 — Polish (plan §10 M5)

- [ ] **P1.** Error/empty/loading states for non-technical users across all views.
- [ ] **P2.** WS + SSE reconnect/backoff; surface sandbox/agent errors clearly.
- [ ] **P3.** Secrets pass: confirm `auth.json` + API keys are encrypted at rest
  and never serialized to the browser. **Done-when:** grep confirms no secret in
  any API/WS payload.
- [ ] **P4.** End-to-end demo script: create → upload → connect → chat → capture
  → run → download → reproduce.

---

## Parallelization summary

- **Day 1:** D1, C1–C4, A1–A3, B1 (foundations) + Phase 0 spikes in parallel.
- **Day 2:** A4/B2 (workspaces), A5/B3 (files), A6/B4 (connect).
- **Day 3:** A7/B5 (chat), A8–A9/B6–B7 (automations & artifacts).
- **Day 4:** A10/B8 (reproducibility), Phase 8 polish + demo.

Frontend (B) is never blocked on more than one server step at a time because it
codes against `ROUTES` and the WS types from the start (mock the server until
the matching A-step lands).
