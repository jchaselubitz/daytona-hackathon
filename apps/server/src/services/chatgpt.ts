/**
 * ChatGPT connection service (A6).
 *
 * Primary path: run opencode's headless device-code login inside the sandbox,
 * surface the verification URL + user code to the user's browser, poll until
 * `auth.json` appears, then back it up encrypted on the workspace row.
 *
 * Fallback: store an OpenAI API key (encrypted) so the product works without
 * the ChatGPT OAuth flow.
 *
 * NOTE: the exact login command + auth.json parsing is Phase-0 spike S2; it is
 * isolated here. Tokens are encrypted at rest and never returned to the browser.
 */
import type { StartChatGptConnectResponse } from "@app/shared";
import { SANDBOX_PATHS } from "@app/shared";
import { query } from "../db.js";
import { encryptSecret } from "../crypto.js";
import { getSandbox } from "../daytona.js";
import { getWorkspaceRow } from "./workspaces.js";
import { badRequest, notFound } from "../errors.js";

const LOGIN_SESSION = "chatgpt-login";

/** Command that begins the headless device-code login (confirm in spike S2). */
const LOGIN_COMMAND = "opencode auth login --provider openai --headless";

/** Begin the device flow; return the URL + code for the user to approve. */
export async function startConnect(workspaceId: string): Promise<StartChatGptConnectResponse> {
  const ws = await getWorkspaceRow(workspaceId);
  if (!ws.daytona_sandbox_id) throw notFound(`workspace ${workspaceId} has no sandbox yet`);
  const sandbox = await getSandbox(ws.daytona_sandbox_id);

  await sandbox.process.createSession(LOGIN_SESSION).catch(() => {});
  // Run async so the device flow keeps polling for approval in the background.
  const res = await sandbox.process.executeSessionCommand(LOGIN_SESSION, {
    command: LOGIN_COMMAND,
    runAsync: true,
  });

  // Some toolbox versions return early output synchronously; also try logs.
  const text = JSON.stringify(res ?? {});
  const parsed = parseDeviceCode(text);
  return {
    mode: "chatgpt-oauth",
    verificationUrl: parsed.url,
    userCode: parsed.code,
    expiresInSec: 900,
  };
}

/** Poll status: read auth.json from the sandbox; if present, back it up. */
export async function connectStatus(
  workspaceId: string,
): Promise<{ connected: boolean; pending: boolean }> {
  const ws = await getWorkspaceRow(workspaceId);
  if (ws.encrypted_auth_blob) return { connected: true, pending: false };
  if (!ws.daytona_sandbox_id) return { connected: false, pending: false };

  const sandbox = await getSandbox(ws.daytona_sandbox_id);
  let authJson: Buffer | null = null;
  try {
    authJson = await sandbox.fs.downloadFile(SANDBOX_PATHS.auth);
  } catch {
    authJson = null; // not written yet
  }
  if (!authJson || authJson.length === 0) return { connected: false, pending: true };

  const blob = encryptSecret(authJson);
  await query(
    `UPDATE workspaces SET encrypted_auth_blob = $1, auth_mode = 'chatgpt-oauth' WHERE id = $2`,
    [blob, workspaceId],
  );
  return { connected: true, pending: false };
}

/** Fallback: persist an OpenAI API key (encrypted) + push it into the sandbox. */
export async function setApiKey(workspaceId: string, openaiApiKey: string): Promise<void> {
  if (!openaiApiKey || !openaiApiKey.startsWith("sk-")) {
    throw badRequest("openaiApiKey must be a valid OpenAI key (starts with 'sk-')");
  }
  const ws = await getWorkspaceRow(workspaceId);
  const blob = encryptSecret(JSON.stringify({ openaiApiKey }));
  await query(
    `UPDATE workspaces SET encrypted_auth_blob = $1, auth_mode = 'openai-api-key' WHERE id = $2`,
    [blob, workspaceId],
  );
  if (ws.daytona_sandbox_id) {
    const sandbox = await getSandbox(ws.daytona_sandbox_id);
    // opencode reads OPENAI_API_KEY; write an auth.json the agent can use.
    const auth = JSON.stringify({ openai: { type: "api", key: openaiApiKey } });
    await sandbox.fs.uploadFile(Buffer.from(auth), SANDBOX_PATHS.auth);
  }
}

/** Restore a backed-up auth.json into a (fresh) sandbox — used by reproduce. */
export async function restoreAuth(workspaceId: string, sandboxId: string): Promise<boolean> {
  const ws = await getWorkspaceRow(workspaceId);
  if (!ws.encrypted_auth_blob) return false;
  const { decryptSecret } = await import("../crypto.js");
  const plain = decryptSecret(ws.encrypted_auth_blob);
  const sandbox = await getSandbox(sandboxId);
  await sandbox.fs.uploadFile(plain, SANDBOX_PATHS.auth);
  return true;
}

function parseDeviceCode(text: string): { url?: string; code?: string } {
  const url = text.match(/https?:\/\/[^\s"']+/)?.[0];
  // user codes look like ABCD-EFGH
  const code = text.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/)?.[0];
  return { url, code };
}
