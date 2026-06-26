/**
 * Workspace service (A4): the create→provision state machine and lookups.
 *
 * `createWorkspace` inserts a `creating` row and returns immediately; the
 * sandbox is provisioned in the background and the row advances
 * creating → starting → ready (or error). The frontend polls GET /workspaces/:id.
 */
import type { Workspace } from "@app/shared";
import { loadEnv } from "../env.js";
import { DEMO_USER_ID, mapWorkspace, query, type WorkspaceRow } from "../db.js";
import {
  createSandbox,
  deleteSandbox,
  ensureWorkspaceDirs,
  getOpencodeClient,
  getSandbox,
  startOpencodeServe,
  waitForOpencode,
} from "../daytona.js";
import { OpencodeClient } from "../opencode.js";
import { notFound } from "../errors.js";

async function setState(id: string, state: string): Promise<void> {
  await query(`UPDATE workspaces SET state = $1 WHERE id = $2`, [state, id]);
}

async function failProvision(workspaceId: string, err: unknown): Promise<void> {
  console.error(`[workspaces] provision ${workspaceId} failed:`, err);
  await setState(workspaceId, "error");
}

export async function createWorkspace(name: string): Promise<Workspace> {
  const env = loadEnv();
  const digest = env.daytona.snapshotDigest || env.daytona.snapshot || "unpinned";
  const { rows } = await query<WorkspaceRow>(
    `INSERT INTO workspaces (user_id, name, snapshot_digest, state)
     VALUES ($1, $2, $3, 'creating')
     RETURNING *`,
    [DEMO_USER_ID, name, digest],
  );
  const ws = mapWorkspace(rows[0]!);
  // Fire-and-forget provisioning; errors are captured into the row state.
  void provision(ws.id).catch((err) => void failProvision(ws.id, err));
  return ws;
}

/** Provision the sandbox for a workspace and drive it to `ready`. */
export async function provision(workspaceId: string): Promise<void> {
  const ws = await getWorkspaceRow(workspaceId);
  const sandbox = ws.daytona_sandbox_id
    ? await getSandbox(ws.daytona_sandbox_id)
    : await createSandbox(ws.name);
  await query(
    `UPDATE workspaces SET daytona_sandbox_id = $1, state = 'starting' WHERE id = $2`,
    [sandbox.id, workspaceId],
  );
  await ensureWorkspaceDirs(sandbox);
  await startOpencodeServe(sandbox);
  const ready = await waitForOpencode(sandbox);
  await setState(workspaceId, ready ? "ready" : "error");
  if (!ready) {
    throw new Error(
      `opencode did not become healthy within the startup timeout for sandbox ${sandbox.id}`,
    );
  }
}

export async function retryWorkspaceProvision(workspaceId: string): Promise<Workspace> {
  const ws = await getWorkspaceRow(workspaceId);
  if (!["error", "creating", "starting"].includes(ws.state)) {
    return mapWorkspace(ws);
  }
  await setState(workspaceId, ws.daytona_sandbox_id ? "starting" : "creating");
  void provision(workspaceId).catch((err) => void failProvision(workspaceId, err));
  return getWorkspace(workspaceId);
}

export async function listWorkspaces(): Promise<Workspace[]> {
  const { rows } = await query<WorkspaceRow>(
    `SELECT * FROM workspaces WHERE user_id = $1 ORDER BY created_at DESC`,
    [DEMO_USER_ID],
  );
  return rows.map(mapWorkspace);
}

export async function getWorkspace(id: string): Promise<Workspace> {
  return mapWorkspace(await getWorkspaceRow(id));
}

export async function getWorkspaceRow(id: string): Promise<WorkspaceRow> {
  const { rows } = await query<WorkspaceRow>(
    `SELECT * FROM workspaces WHERE id = $1 AND user_id = $2`,
    [id, DEMO_USER_ID],
  );
  const row = rows[0];
  if (!row) throw notFound(`workspace ${id} not found`);
  return row;
}

export async function deleteWorkspace(id: string): Promise<void> {
  const ws = await getWorkspaceRow(id);
  if (ws.daytona_sandbox_id) {
    await deleteSandbox(ws.daytona_sandbox_id).catch((err) =>
      console.error(`[workspaces] sandbox delete failed for ${id}:`, err),
    );
  }
  await query(`DELETE FROM workspaces WHERE id = $1`, [id]);
}

/** Resolve a live opencode client for a workspace (used by the WS relay + chat). */
export async function opencodeClientForWorkspace(workspaceId: string): Promise<OpencodeClient> {
  const ws = await getWorkspaceRow(workspaceId);
  if (!ws.daytona_sandbox_id) {
    throw notFound(`workspace ${workspaceId} has no sandbox yet`);
  }
  const sandbox = await getSandbox(ws.daytona_sandbox_id);
  return getOpencodeClient(sandbox);
}
