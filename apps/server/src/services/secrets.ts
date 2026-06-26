/**
 * Secrets service.
 *
 * The only auth path for a workspace is a stored OpenAI API key. The key is
 * encrypted at rest on the workspace row and pushed into the sandbox where the
 * Codex CLI agent reads it as OPENAI_API_KEY. It is never returned to the
 * browser — the UI only learns whether a key is present.
 */
import { SANDBOX_PATHS } from "@app/shared";
import { query } from "../db.js";
import { decryptSecret, encryptSecret } from "../crypto.js";
import { getSandbox } from "../daytona.js";
import { getWorkspaceRow } from "./workspaces.js";
import { badRequest } from "../errors.js";

/** True when an OpenAI API key is stored for the workspace. */
export async function apiKeyStatus(workspaceId: string): Promise<{ connected: boolean }> {
  const ws = await getWorkspaceRow(workspaceId);
  return { connected: ws.encrypted_auth_blob != null };
}

/** Persist an OpenAI API key (encrypted) and push it into the sandbox. */
export async function setApiKey(workspaceId: string, openaiApiKey: string): Promise<void> {
  const key = openaiApiKey.trim();
  if (!key || !key.startsWith("sk-")) {
    throw badRequest("openaiApiKey must be a valid OpenAI key (starts with 'sk-')");
  }
  const ws = await getWorkspaceRow(workspaceId);
  const blob = encryptSecret(Buffer.from(key));
  await query(
    `UPDATE workspaces SET encrypted_auth_blob = $1, auth_mode = 'openai-api-key' WHERE id = $2`,
    [blob, workspaceId],
  );
  if (ws.daytona_sandbox_id) {
    const sandbox = await getSandbox(ws.daytona_sandbox_id);
    await sandbox.fs.uploadFile(Buffer.from(key), SANDBOX_PATHS.codexApiKey);
  }
}

/** Restore the stored API key into a (fresh) sandbox — used by reproduce. */
export async function restoreApiKey(workspaceId: string, sandboxId: string): Promise<boolean> {
  const ws = await getWorkspaceRow(workspaceId);
  if (!ws.encrypted_auth_blob) return false;
  const plain = decryptSecret(ws.encrypted_auth_blob);
  const sandbox = await getSandbox(sandboxId);
  await sandbox.fs.uploadFile(plain, SANDBOX_PATHS.codexApiKey);
  return true;
}
