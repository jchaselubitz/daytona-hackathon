# Agentic Workflows in Daytona Sandboxes

Lets non-technical users run agentic work in [Daytona](https://daytona.io)
sandboxes: upload a knowledgebase, connect ChatGPT, chat with an
Codex CLI agent that operates on the files, and capture +
run + reproduce the automations it builds — downloading the outputs.

## Architecture (MVP)

- **`apps/web`** — React + Vite frontend (the only thing the user touches).
- **`apps/server`** — Fastify control plane: REST API + a WebSocket relay,
  Daytona sandbox lifecycle, the Codex CLI runner, Postgres access, and object
  storage. **All secrets live here; the browser never talks to a sandbox.**
- **`packages/shared`** — the frozen code contract (`contract.ts`) imported by
  both apps so they can't drift.
- **`infra/snapshot`** — the Daytona sandbox base image (node, python, Codex CLI,
  PDF tooling) + the agent guide. Its pinned digest is the reproducibility anchor.
- **`db/schema.sql`** — authoritative Postgres schema.

Each user **workspace** is a Daytona sandbox. The server runs `codex exec` inside
it and relays chat results over WebSocket to the browser.

See [`docs/mvp-engineering-plan.md`](docs/mvp-engineering-plan.md),
[`docs/code-contract.md`](docs/code-contract.md),
[`docs/execution-checklist.md`](docs/execution-checklist.md), and the current
[`docs/build-status.md`](docs/build-status.md).

## Quickstart (local)

```bash
cp .env.example .env          # then fill in the secrets below
docker compose up --build     # Postgres + server (:8080) + web (:5173)
```

Open http://localhost:5173. `GET http://localhost:8080/api/health` should return
`{"ok":true}`.

### Required before sandboxes can go `ready`
The control plane runs without these, but creating a live workspace needs them:

- `DAYTONA_API_KEY` — Daytona credentials.
- `DAYTONA_SNAPSHOT` — build & register `infra/snapshot` first (see
  [`infra/snapshot/README.md`](infra/snapshot/README.md)).
- `DAYTONA_SNAPSHOT_DIGEST` — recommended for reproducibility, but not required
  for local workspace creation.
- `AUTH_ENCRYPTION_KEY` — `openssl rand -base64 32` (encrypts stored auth).
- `OPENAI_API_KEY` — optional fallback if you skip the ChatGPT device login.

## Development (without Docker)

```bash
pnpm install
pnpm --filter @app/shared build      # build the contract package first
pnpm -r build                        # build everything
pnpm dev:server                      # tsx watch on :8080 (needs Postgres + .env)
pnpm dev:web                         # Vite on :5173
```

After building, start the production-style entrypoints from the monorepo root:

```bash
pnpm start:server                    # node apps/server/dist/index.js
pnpm start:web                       # Vite preview on :5173
pnpm start                           # server + web together
```

## Layout

```
apps/server     control plane (REST + WS relay + Daytona + storage + db)
apps/web        React frontend
packages/shared the code contract (types, ROUTES, WS protocol, Storage iface)
infra/snapshot  Daytona sandbox image + AGENTS.md
db/schema.sql   Postgres schema (authoritative)
docker-compose.yml
```
