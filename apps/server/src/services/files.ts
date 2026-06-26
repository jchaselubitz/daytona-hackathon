/**
 * Knowledgebase files service (A5).
 *
 * On upload: store a canonical copy in object storage (the reproducibility
 * source of truth), push the bytes into the sandbox's /workspace/knowledge, and
 * record a `file_manifest` row with sha256. Hydration on a fresh sandbox replays
 * the canonical copies (contract §6).
 */
import { createHash } from "node:crypto";
import path from "node:path";
import type { FileManifestEntry } from "@app/shared";
import { SANDBOX_PATHS } from "@app/shared";
import { mapFile, query, type FileRow } from "../db.js";
import { getStorage } from "../storage/index.js";
import { getSandbox } from "../daytona.js";
import { getWorkspaceRow } from "./workspaces.js";

export interface IncomingFile {
  filename: string;
  buffer: Buffer;
  mime: string;
}

function storageKeyFor(workspaceId: string, sha256: string): string {
  return `files/${workspaceId}/${sha256}`;
}

export async function uploadFiles(
  workspaceId: string,
  files: IncomingFile[],
): Promise<FileManifestEntry[]> {
  const ws = await getWorkspaceRow(workspaceId);
  const sandbox = ws.daytona_sandbox_id ? await getSandbox(ws.daytona_sandbox_id) : null;
  const storage = getStorage();
  const out: FileManifestEntry[] = [];

  for (const f of files) {
    const relPath = path.basename(f.filename); // flat namespace under knowledge/
    const sha256 = createHash("sha256").update(f.buffer).digest("hex");
    const storageKey = storageKeyFor(workspaceId, sha256);

    // 1) canonical copy in object storage
    await storage.put(storageKey, f.buffer, { contentType: f.mime });

    // 2) push into the sandbox knowledgebase (if a sandbox exists yet)
    if (sandbox) {
      const remote = `${SANDBOX_PATHS.knowledge}/${relPath}`;
      await sandbox.fs.uploadFile(f.buffer, remote);
    }

    // 3) manifest row (idempotent on (workspace, relPath))
    const { rows } = await query<FileRow>(
      `INSERT INTO file_manifest (workspace_id, rel_path, sha256, size, mime, storage_key)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (workspace_id, rel_path)
       DO UPDATE SET sha256 = EXCLUDED.sha256, size = EXCLUDED.size,
                     mime = EXCLUDED.mime, storage_key = EXCLUDED.storage_key
       RETURNING *`,
      [workspaceId, relPath, sha256, f.buffer.length, f.mime, storageKey],
    );
    out.push(mapFile(rows[0]!));
  }
  return out;
}

export async function listFiles(workspaceId: string): Promise<FileManifestEntry[]> {
  await getWorkspaceRow(workspaceId); // 404 if missing
  const { rows } = await query<FileRow>(
    `SELECT * FROM file_manifest WHERE workspace_id = $1 ORDER BY rel_path`,
    [workspaceId],
  );
  return rows.map(mapFile);
}

/** Re-push all canonical copies into a (fresh) sandbox — used by reproduce. */
export async function hydrateKnowledge(workspaceId: string, sandboxId: string): Promise<void> {
  const sandbox = await getSandbox(sandboxId);
  const storage = getStorage();
  const { rows } = await query<FileRow>(
    `SELECT * FROM file_manifest WHERE workspace_id = $1`,
    [workspaceId],
  );
  for (const r of rows) {
    const stream = await storage.get(r.storage_key);
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(c as Buffer);
    await sandbox.fs.uploadFile(Buffer.concat(chunks), `${SANDBOX_PATHS.knowledge}/${r.rel_path}`);
  }
}
