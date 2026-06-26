/**
 * ChatGPT connection service (A6).
 *
 * Primary path: run Codex's headless device-code login inside the sandbox,
 * surface the verification URL + user code to the user's browser, poll until
 * `auth.json` appears, then back it up encrypted on the workspace row.
 *
 * Fallback: store an OpenAI API key (encrypted) and place it where the Codex
 * runner can pass it as OPENAI_API_KEY.
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
import { badRequest, failedDependency, notFound } from "../errors.js";

const LOGIN_SESSION = "chatgpt-login";

/** Command that begins Codex's ChatGPT device-code login. */
const LOGIN_COMMAND = `mkdir -p ${SANDBOX_PATHS.codexHome} && CODEX_HOME=${SANDBOX_PATHS.codexHome} codex login --device-auth`;

/** Begin the device flow; return the URL + code for the user to approve. */
export async function startConnect(workspaceId: string): Promise<StartChatGptConnectResponse> {
  const ws = await getWorkspaceRow(workspaceId);
  if (!ws.daytona_sandbox_id) throw notFound(`workspace ${workspaceId} has no sandbox yet`);
  const sandbox = await getSandbox(ws.daytona_sandbox_id);

  await sandbox.process.deleteSession(LOGIN_SESSION).catch(() => {});
  await sandbox.process.createSession(LOGIN_SESSION).catch(() => {});
  // Run async so the device flow keeps polling for approval in the background.
  const res = await sandbox.process.executeSessionCommand(LOGIN_SESSION, {
    command: LOGIN_COMMAND,
    runAsync: true,
  });

  const text = await waitForDeviceCodeOutput(
    sandbox.process,
    res.cmdId,
    [res.output, res.stdout, res.stderr].filter(Boolean).join("\n"),
    12_000,
  );
  const parsed = parseDeviceCode(text);
  if (!parsed.url || !parsed.code) {
    throw failedDependency(
      "chatgpt_device_code_unavailable",
      "ChatGPT login started, but the sandbox did not emit a verification URL and user code.",
      {
        commandId: res.cmdId,
        output: redactOutput(text),
      },
    );
  }

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
    authJson = await sandbox.fs.downloadFile(SANDBOX_PATHS.codexAuth);
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
    await sandbox.fs.uploadFile(Buffer.from(openaiApiKey), SANDBOX_PATHS.codexApiKey);
  }
}

/** Restore a backed-up auth.json into a (fresh) sandbox — used by reproduce. */
export async function restoreAuth(workspaceId: string, sandboxId: string): Promise<boolean> {
  const ws = await getWorkspaceRow(workspaceId);
  if (!ws.encrypted_auth_blob) return false;
  const { decryptSecret } = await import("../crypto.js");
  const plain = decryptSecret(ws.encrypted_auth_blob);
  const sandbox = await getSandbox(sandboxId);
  const authPath =
    ws.auth_mode === "openai-api-key" ? SANDBOX_PATHS.codexApiKey : SANDBOX_PATHS.codexAuth;
  await sandbox.fs.uploadFile(plain, authPath);
  return true;
}

function parseDeviceCode(text: string): { url?: string; code?: string } {
  const clean = stripTerminalControls(text);
  const url = clean.match(/https?:\/\/[^\s"'<>]+/)?.[0];
  // Codex user codes look like ABCD-EFGH or ABCD-EFGHJ.
  const contextualCode = clean.match(/one-time code[\s\S]*?\b([A-Z0-9]{4}-[A-Z0-9]{4,6})\b/i)?.[1];
  const codeMatches = [...clean.matchAll(/\b[A-Z0-9]{4}-[A-Z0-9]{4,6}\b/gi)];
  const code = (contextualCode ?? codeMatches.at(-1)?.[0])?.toUpperCase();
  return { url, code };
}

function stripTerminalControls(text: string): string {
  return text
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

async function waitForDeviceCodeOutput(
  processApi: Awaited<ReturnType<typeof getSandbox>>["process"],
  commandId: string,
  initialText: string,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastText = initialText;

  while (Date.now() < deadline) {
    const logs = await processApi.getSessionCommandLogs(LOGIN_SESSION, commandId).catch(() => null);
    lastText = [
      lastText,
      logs?.output,
      logs?.stdout,
      logs?.stderr,
    ]
      .filter(Boolean)
      .join("\n");

    const parsed = parseDeviceCode(lastText);
    if (parsed.url && parsed.code) return lastText;

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return lastText;
}

function redactOutput(text: string): string {
  return text.slice(-4000).replace(/sk-[A-Za-z0-9_-]+/g, "sk-REDACTED");
}
