-- CODE CONTRACT: database schema (Postgres).
-- Authoritative shape mirrored by packages/shared/src/contract.ts.
-- Mounted by docker compose as a Postgres init script for local dev.
-- For app migrations, the server team may import this into Prisma/Drizzle, but
-- column names + types here are the contract.

CREATE EXTENSION IF NOT EXISTS "pgcrypto"; -- gen_random_uuid()

CREATE TABLE IF NOT EXISTS users (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT UNIQUE NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workspaces (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  daytona_sandbox_id  TEXT,
  snapshot_digest     TEXT NOT NULL,                 -- pinned base image digest
  state               TEXT NOT NULL DEFAULT 'creating',
  provisioning_error  TEXT,                          -- last sandbox/opencode startup failure
  auth_mode           TEXT,                          -- 'chatgpt-oauth' | 'openai-api-key'
  encrypted_auth_blob BYTEA,                         -- encrypted auth.json / api key
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_workspaces_user ON workspaces(user_id);

CREATE TABLE IF NOT EXISTS file_manifest (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  rel_path      TEXT NOT NULL,                       -- under /workspace/knowledge
  sha256        TEXT NOT NULL,
  size          BIGINT NOT NULL,
  mime          TEXT NOT NULL,
  storage_key   TEXT NOT NULL,                       -- canonical copy in object store
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, rel_path)
);

CREATE TABLE IF NOT EXISTS automations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  version       TEXT NOT NULL,
  entrypoint    TEXT NOT NULL,
  manifest_json JSONB NOT NULL,                      -- AutomationManifest
  storage_key   TEXT NOT NULL,                       -- bundle archive
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name, version)
);

CREATE TABLE IF NOT EXISTS automation_runs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id  UUID NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  workspace_id   UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  status         TEXT NOT NULL DEFAULT 'queued',
  inputs_json    JSONB NOT NULL DEFAULT '{}',
  started_at     TIMESTAMPTZ,
  finished_at    TIMESTAMPTZ,
  logs_key       TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_automation ON automation_runs(automation_id);

CREATE TABLE IF NOT EXISTS artifacts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id        UUID NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
  rel_path      TEXT NOT NULL,                       -- under /workspace/artifacts/<run-id>
  sha256        TEXT NOT NULL,
  size          BIGINT NOT NULL,
  content_type  TEXT NOT NULL,
  storage_key   TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts(run_id);

-- Single demo user for the MVP. Real auth is post-MVP.
INSERT INTO users (id, email)
VALUES ('00000000-0000-0000-0000-000000000001', 'demo@local')
ON CONFLICT (email) DO NOTHING;
