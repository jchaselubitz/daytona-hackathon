/**
 * Database access layer (A2). Thin `pg` wrapper + row→entity mappers.
 *
 * `db/schema.sql` is authoritative (contract §4). snake_case columns map 1:1 to
 * the camelCase entities in `@app/shared`. The server owns all reads/writes.
 */
import pg from "pg";
import type {
  Artifact,
  Automation,
  AutomationManifest,
  AutomationRun,
  FileManifestEntry,
  RunStatus,
  Workspace,
  WorkspaceState,
} from "@app/shared";
import { loadEnv } from "./env.js";

/** The seeded demo user (db/schema.sql). MVP auth = single user. */
export const DEMO_USER_ID = "00000000-0000-0000-0000-000000000001";

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({ connectionString: loadEnv().databaseUrl, max: 10 });
  }
  return pool;
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  return getPool().query<T>(text, params as never[]);
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

// ---------------------------------------------------------------------------
// Row shapes (as returned by Postgres) + mappers to contract entities.
// ---------------------------------------------------------------------------

interface WorkspaceRow {
  id: string;
  user_id: string;
  name: string;
  daytona_sandbox_id: string | null;
  snapshot_digest: string;
  state: string;
  provisioning_error: string | null;
  auth_mode: string | null;
  encrypted_auth_blob: Buffer | null;
  created_at: Date;
}

export function mapWorkspace(r: WorkspaceRow): Workspace {
  return {
    id: r.id,
    userId: r.user_id,
    name: r.name,
    daytonaSandboxId: r.daytona_sandbox_id,
    snapshotDigest: r.snapshot_digest,
    state: r.state as WorkspaceState,
    provisioningError: r.provisioning_error,
    apiKeyConnected: r.encrypted_auth_blob != null,
    createdAt: r.created_at.toISOString(),
  };
}

interface FileRow {
  id: string;
  workspace_id: string;
  rel_path: string;
  sha256: string;
  size: string; // BIGINT comes back as string
  mime: string;
  storage_key: string;
  created_at: Date;
}

export function mapFile(r: FileRow): FileManifestEntry {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    relPath: r.rel_path,
    sha256: r.sha256,
    size: Number(r.size),
    mime: r.mime,
    storageKey: r.storage_key,
    createdAt: r.created_at.toISOString(),
  };
}

interface AutomationRow {
  id: string;
  workspace_id: string;
  name: string;
  version: string;
  entrypoint: string;
  manifest_json: AutomationManifest;
  storage_key: string;
  created_at: Date;
}

export function mapAutomation(r: AutomationRow): Automation {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    name: r.name,
    version: r.version,
    entrypoint: r.entrypoint,
    manifest: r.manifest_json,
    storageKey: r.storage_key,
    createdAt: r.created_at.toISOString(),
  };
}

interface RunRow {
  id: string;
  automation_id: string;
  workspace_id: string;
  status: string;
  inputs_json: Record<string, string | number | boolean>;
  started_at: Date | null;
  finished_at: Date | null;
  logs_key: string | null;
}

export function mapRun(r: RunRow): AutomationRun {
  return {
    id: r.id,
    automationId: r.automation_id,
    workspaceId: r.workspace_id,
    status: r.status as RunStatus,
    inputs: r.inputs_json,
    startedAt: r.started_at ? r.started_at.toISOString() : null,
    finishedAt: r.finished_at ? r.finished_at.toISOString() : null,
    logsKey: r.logs_key,
  };
}

interface ArtifactRow {
  id: string;
  run_id: string;
  rel_path: string;
  sha256: string;
  size: string;
  content_type: string;
  storage_key: string;
  created_at: Date;
}

export function mapArtifact(r: ArtifactRow): Artifact {
  return {
    id: r.id,
    runId: r.run_id,
    relPath: r.rel_path,
    sha256: r.sha256,
    size: Number(r.size),
    contentType: r.content_type,
    storageKey: r.storage_key,
    createdAt: r.created_at.toISOString(),
  };
}

export type { WorkspaceRow, FileRow, AutomationRow, RunRow, ArtifactRow };
