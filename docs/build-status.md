# Build Status — Execution Pass

**Date:** 2026-06-26 · Tracks [`execution-checklist.md`](./execution-checklist.md)
against what is now in the repo. Everything builds (`pnpm -r build`), typechecks,
and the full stack runs under `docker compose` (Postgres healthy, server + web
up, `/api/health` 200, DB read/write verified, web served on :5173).

## Legend
- **done** — implemented and verified to build/run in this pass.
- **code-complete** — implemented & typechecks, but the runtime path needs a
  live Daytona snapshot + the Phase-0 spikes to validate end to end.
- **needs human** — requires credentials / a browser / a registry; cannot be run
  headlessly here.

## Phase 0 — Spikes
| Step | Status | Notes |
|---|---|---|
| S1 opencode in a sandbox | **needs human** | Requires building/pushing the snapshot image and a live Daytona sandbox + preview URL. The code path (`daytona.ts`, `opencode.ts`) is written against it. |
| S2 ChatGPT device login | **needs human** | Requires a browser to approve the device code. Flow implemented in `services/chatgpt.ts`; the exact login command + `auth.json` parsing must be confirmed live (isolated in one place). |

## Phase 1 — Foundations
| Step | Status | Notes |
|---|---|---|
| D1 shared package | **done** | `@app/shared` builds; `apps/web` + `apps/server` import `ROUTES`, types, `buildPath`. |
| D2 opencode client | **code-complete** | Hand-written typed client + SSE normalizer (`opencode.ts`) instead of generated-from-OpenAPI; confirm shapes in S1. |
| C1 monorepo tooling | **done** | pnpm workspaces; `pnpm -r build` runs. |
| C2 snapshot image | **code-complete / needs human** | `infra/snapshot/Dockerfile` authored with node, python3+pip, opencode, poppler-utils, pypdf/pdfplumber, pandoc. Digest must be built + recorded (`infra/snapshot/README.md`). |
| C3 AGENTS.md | **done** | `infra/snapshot/AGENTS.md` baked into the image; instructs opencode on reproducible deps. |
| C4 compose + Dockerfiles | **done** | Both app images build; `docker compose up` → Postgres healthy + both containers running, verified. |
| A1 server scaffold + health | **done** | Fastify + ws; `GET /api/health` returns 200 in compose. |
| A2 DB access layer | **done** | `pg` layer + row→entity mappers bound to `db/schema.sql`; reads the seeded demo user. |
| A3 Storage FS adapter | **done** | `FsStorage` implements the contract incl. `signedDownloadUrl` (server-proxied). |
| B1 web scaffold | **done** | Vite + React; boots, calls `/api/health`, shows online/offline. |

## Phase 2–7 — Features (all wired against the contract)
| Step | Status | Notes |
|---|---|---|
| A4 workspace lifecycle + routes | **done / code-complete** | Routes + create→provision state machine verified (transitions to `error` cleanly without a snapshot). Live `ready` needs C2 digest. |
| A5 file upload + manifest + push | **code-complete** | Canonical copy to storage, manifest row, push into sandbox knowledge. |
| A6 ChatGPT connect + api-key | **code-complete** | Device flow + encrypted `auth.json` backup + API-key fallback. |
| A7 SSE→WS relay + chat routes | **code-complete** | One SSE per workspace, normalized + fanned out; chat is 202 + WS output. |
| A8 capture automations | **code-complete** | In-sandbox tar → bundle + `automations` row (versioned). |
| A9 run automation | **code-complete** | setup + entrypoint with inputs as env; collects `/workspace/artifacts/<run-id>`. |
| A10 reproduce | **code-complete** | Fresh sandbox from bundle digest → restore auth → hydrate knowledge → unpack → run. |
| B2 workspaces UI | **done** | List, create, detail, live state polling. |
| B3 files UI | **done** | Drag-and-drop upload, list with sizes + sha. |
| B4 connect UI | **done** | URL + code display, status polling, API-key form. |
| B5 chat UI | **done** | Streams `message.delta` by id, finalizes on completed, tool activity, reconnect. |
| B6/B7 automations + artifacts UI | **done** | Run button, run polling, artifact download links. |
| B8 reproduce UI | **done** | Reproduce action wired. |

## Phase 8 — Polish
| Step | Status | Notes |
|---|---|---|
| P1 error/empty/loading states | **partial** | Present across views; can be hardened. |
| P2 WS/SSE reconnect/backoff | **done** | Exponential backoff + re-subscribe in `wsClient.ts`; relay error surfacing in `ws.ts`. |
| P3 secrets at rest | **done** | AES-256-GCM (`crypto.ts`); `encrypted_auth_blob` never serialized — `chatgptConnected` is a derived boolean. |
| P4 e2e demo script | **todo** | Create → upload → connect → chat → capture → run → download → reproduce. |

## To make the live path work (human steps)
1. Build + push `infra/snapshot` and register a Daytona snapshot; set
   `DAYTONA_SNAPSHOT` + `DAYTONA_SNAPSHOT_DIGEST` in `.env` (spike S1).
2. Run the ChatGPT device login once to confirm the command + `auth.json` path
   (spike S2), or set `OPENAI_API_KEY` to use the fallback.
3. Set `AUTH_ENCRYPTION_KEY` (`openssl rand -base64 32`).
