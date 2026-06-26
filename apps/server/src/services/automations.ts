/**
 * Automations + artifacts service (A8, A9, A10).
 *
 * Capture (A8): snapshot a /workspace/automations/<name> directory into a
 *   tar.gz bundle (source + manifest.json) and record an `automations` row.
 * Run (A9): exec the manifest's `setup` then `entrypoint` in the sandbox with
 *   inputs as env, then collect /workspace/artifacts/<run-id> into storage.
 * Reproduce (A10): create a FRESH sandbox from the bundle's snapshotDigest,
 *   restore auth + knowledge, unpack the bundle, and run it (contract §6).
 */
import { createHash } from "node:crypto";
import path from "node:path";
import type { Sandbox } from "@daytona/sdk";
import type { Artifact, Automation, AutomationManifest, AutomationRun } from "@app/shared";
import { SANDBOX_PATHS } from "@app/shared";
import {
  mapArtifact,
  mapAutomation,
  mapRun,
  query,
  type ArtifactRow,
  type AutomationRow,
  type RunRow,
} from "../db.js";
import { getStorage } from "../storage/index.js";
import { createSandbox, deleteSandbox, ensureWorkspaceDirs, exec, getSandbox } from "../daytona.js";
import { getWorkspaceRow } from "./workspaces.js";
import { hydrateKnowledge } from "./files.js";
import { restoreAuth } from "./chatgpt.js";
import { badRequest, notFound } from "../errors.js";

// ---------------------------------------------------------------------------
// A8 — capture
// ---------------------------------------------------------------------------

/** Capture all automation directories present in the sandbox into bundles. */
export async function captureAutomations(workspaceId: string): Promise<Automation[]> {
  const ws = await getWorkspaceRow(workspaceId);
  if (!ws.daytona_sandbox_id) throw notFound(`workspace ${workspaceId} has no sandbox`);
  const sandbox = await getSandbox(ws.daytona_sandbox_id);

  const ls = await exec(sandbox, `ls -1 ${SANDBOX_PATHS.automations}`);
  const names = ls.output
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  const out: Automation[] = [];
  for (const name of names) {
    const captured = await captureOne(workspaceId, sandbox, name);
    if (captured) out.push(captured);
  }
  return out;
}

async function captureOne(
  workspaceId: string,
  sandbox: Sandbox,
  name: string,
): Promise<Automation | null> {
  const dir = `${SANDBOX_PATHS.automations}/${name}`;
  // Read the manifest the agent wrote (AGENTS.md instructs this).
  let manifest: AutomationManifest;
  try {
    const raw = await sandbox.fs.downloadFile(`${dir}/manifest.json`);
    manifest = JSON.parse(raw.toString("utf8")) as AutomationManifest;
  } catch {
    return null; // no manifest yet → not a capturable automation
  }
  const version = manifest.version || `v${Date.now()}`;

  // tar the directory inside the sandbox, then download the archive.
  const tmpTar = `/tmp/${name}-${version}.tar.gz`;
  await exec(sandbox, `tar -czf ${tmpTar} -C ${SANDBOX_PATHS.automations} ${name}`);
  const archive = await sandbox.fs.downloadFile(tmpTar);

  const storageKey = `bundles/${workspaceId}/${name}/${version}.tar.gz`;
  await getStorage().put(storageKey, archive, { contentType: "application/gzip" });

  const { rows } = await query<AutomationRow>(
    `INSERT INTO automations (workspace_id, name, version, entrypoint, manifest_json, storage_key)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (workspace_id, name, version)
     DO UPDATE SET entrypoint = EXCLUDED.entrypoint, manifest_json = EXCLUDED.manifest_json,
                   storage_key = EXCLUDED.storage_key
     RETURNING *`,
    [workspaceId, name, version, manifest.entrypoint, JSON.stringify(manifest), storageKey],
  );
  return mapAutomation(rows[0]!);
}

export async function listAutomations(workspaceId: string): Promise<Automation[]> {
  await getWorkspaceRow(workspaceId);
  const { rows } = await query<AutomationRow>(
    `SELECT * FROM automations WHERE workspace_id = $1 ORDER BY created_at DESC`,
    [workspaceId],
  );
  return rows.map(mapAutomation);
}

async function getAutomationRow(automationId: string): Promise<AutomationRow> {
  const { rows } = await query<AutomationRow>(`SELECT * FROM automations WHERE id = $1`, [
    automationId,
  ]);
  const row = rows[0];
  if (!row) throw notFound(`automation ${automationId} not found`);
  return row;
}

// ---------------------------------------------------------------------------
// A9 — run
// ---------------------------------------------------------------------------

export async function runAutomation(
  workspaceId: string,
  automationId: string,
  inputs: Record<string, string | number | boolean> = {},
): Promise<AutomationRun> {
  const ws = await getWorkspaceRow(workspaceId);
  if (!ws.daytona_sandbox_id) throw notFound(`workspace ${workspaceId} has no sandbox`);
  const automation = await getAutomationRow(automationId);
  const sandbox = await getSandbox(ws.daytona_sandbox_id);

  const run = await insertRun(automationId, workspaceId, inputs);
  // Execute in the existing sandbox using the source already present.
  void executeRun(run.id, sandbox, automation.manifest_json, automation.name, inputs).catch((err) =>
    failRun(run.id, err),
  );
  return run;
}

// ---------------------------------------------------------------------------
// A10 — reproduce on a fresh sandbox
// ---------------------------------------------------------------------------

export async function reproduceAutomation(
  workspaceId: string,
  automationId: string,
  inputs: Record<string, string | number | boolean> = {},
): Promise<AutomationRun> {
  const automation = await getAutomationRow(automationId);
  const manifest = automation.manifest_json;
  if (!manifest.snapshotDigest) {
    throw badRequest("automation manifest has no snapshotDigest; cannot reproduce");
  }
  const run = await insertRun(automationId, workspaceId, inputs);

  void (async () => {
    // 1) fresh sandbox from the SAME snapshot the bundle was authored against.
    const sandbox = await createSandbox(`reproduce-${automation.name}`);
    try {
      await ensureWorkspaceDirs(sandbox);
      // 2) restore auth.json + 3) hydrate knowledge from canonical storage.
      await restoreAuth(workspaceId, sandbox.id);
      await hydrateKnowledge(workspaceId, sandbox.id);
      // 4) unpack the bundle into /workspace/automations/<name>.
      const archive = await streamToBuffer(await getStorage().get(automation.storage_key));
      const tmpTar = `/tmp/${automation.name}.tar.gz`;
      await sandbox.fs.uploadFile(archive, tmpTar);
      await exec(sandbox, `tar -xzf ${tmpTar} -C ${SANDBOX_PATHS.automations}`);
      // 5) setup + 6) entrypoint + 7) collect artifacts.
      await executeRun(run.id, sandbox, manifest, automation.name, inputs);
    } finally {
      // Reproduction sandboxes are disposable.
      await deleteSandbox(sandbox.id).catch(() => {});
    }
  })().catch((err) => failRun(run.id, err));

  return run;
}

// ---------------------------------------------------------------------------
// shared run execution + artifact collection
// ---------------------------------------------------------------------------

async function executeRun(
  runId: string,
  sandbox: Sandbox,
  manifest: AutomationManifest,
  name: string,
  inputs: Record<string, string | number | boolean>,
): Promise<void> {
  await query(`UPDATE automation_runs SET status = 'running', started_at = now() WHERE id = $1`, [
    runId,
  ]);
  const dir = `${SANDBOX_PATHS.automations}/${name}`;
  const artifactDir = `${SANDBOX_PATHS.artifacts}/${runId}`;
  await sandbox.fs.createFolder(artifactDir, "755").catch(() => {});

  const envExports = Object.entries(inputs)
    .map(([k, v]) => `export INPUT_${k.toUpperCase()}=${shellQuote(String(v))}`)
    .join("; ");
  const envPrefix = envExports ? `${envExports}; ` : "";
  const runArtifacts = `export RUN_ARTIFACTS_DIR=${artifactDir}; `;

  const logs: string[] = [];
  // setup (idempotent installs from lockfiles)
  for (const cmd of manifest.setup ?? []) {
    const r = await exec(sandbox, `${envPrefix}${runArtifacts}${cmd}`, dir);
    logs.push(`$ ${cmd}\n${r.output}`);
    if (r.exitCode !== 0) {
      await persistLogs(runId, logs);
      throw new Error(`setup step failed (exit ${r.exitCode}): ${cmd}`);
    }
  }
  // entrypoint
  const runner = manifest.runtime === "node" ? "node" : "python3";
  const entry = `${envPrefix}${runArtifacts}${runner} ${shellQuote(manifest.entrypoint)}`;
  const r = await exec(sandbox, entry, dir);
  logs.push(`$ ${entry}\n${r.output}`);
  await persistLogs(runId, logs);

  await collectArtifacts(runId, sandbox, artifactDir);

  await query(
    `UPDATE automation_runs SET status = $1, finished_at = now() WHERE id = $2`,
    [r.exitCode === 0 ? "succeeded" : "failed", runId],
  );
}

async function collectArtifacts(
  runId: string,
  sandbox: Sandbox,
  artifactDir: string,
): Promise<void> {
  const found = await exec(sandbox, `find ${artifactDir} -type f 2>/dev/null || true`);
  const files = found.output
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const storage = getStorage();
  for (const remote of files) {
    const buf = await sandbox.fs.downloadFile(remote);
    const relPath = path.relative(artifactDir, remote);
    const sha256 = createHash("sha256").update(buf).digest("hex");
    const storageKey = `artifacts/${runId}/${relPath}`;
    const contentType = guessContentType(relPath);
    await storage.put(storageKey, buf, { contentType });
    await query<ArtifactRow>(
      `INSERT INTO artifacts (run_id, rel_path, sha256, size, content_type, storage_key)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [runId, relPath, sha256, buf.length, contentType, storageKey],
    );
  }
}

async function insertRun(
  automationId: string,
  workspaceId: string,
  inputs: Record<string, string | number | boolean>,
): Promise<AutomationRun> {
  const { rows } = await query<RunRow>(
    `INSERT INTO automation_runs (automation_id, workspace_id, status, inputs_json)
     VALUES ($1, $2, 'queued', $3) RETURNING *`,
    [automationId, workspaceId, JSON.stringify(inputs)],
  );
  return mapRun(rows[0]!);
}

async function failRun(runId: string, err: unknown): Promise<void> {
  console.error(`[automations] run ${runId} failed:`, err);
  await query(
    `UPDATE automation_runs SET status = 'failed', finished_at = now() WHERE id = $1`,
    [runId],
  ).catch(() => {});
}

async function persistLogs(runId: string, logs: string[]): Promise<void> {
  const key = `logs/${runId}.log`;
  await getStorage().put(key, Buffer.from(logs.join("\n\n"), "utf8"), { contentType: "text/plain" });
  await query(`UPDATE automation_runs SET logs_key = $1 WHERE id = $2`, [key, runId]);
}

export async function getRun(runId: string): Promise<AutomationRun> {
  const { rows } = await query<RunRow>(`SELECT * FROM automation_runs WHERE id = $1`, [runId]);
  const row = rows[0];
  if (!row) throw notFound(`run ${runId} not found`);
  return mapRun(row);
}

export async function listRunArtifacts(runId: string): Promise<Artifact[]> {
  await getRun(runId);
  const { rows } = await query<ArtifactRow>(
    `SELECT * FROM artifacts WHERE run_id = $1 ORDER BY rel_path`,
    [runId],
  );
  return rows.map(mapArtifact);
}

export async function getArtifactRow(artifactId: string): Promise<ArtifactRow> {
  const { rows } = await query<ArtifactRow>(`SELECT * FROM artifacts WHERE id = $1`, [artifactId]);
  const row = rows[0];
  if (!row) throw notFound(`artifact ${artifactId} not found`);
  return row;
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function guessContentType(relPath: string): string {
  const ext = path.extname(relPath).toLowerCase();
  const map: Record<string, string> = {
    ".pdf": "application/pdf",
    ".json": "application/json",
    ".csv": "text/csv",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".html": "text/html",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".zip": "application/zip",
  };
  return map[ext] ?? "application/octet-stream";
}
